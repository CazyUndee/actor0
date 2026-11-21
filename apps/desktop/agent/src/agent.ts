import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { isPublicHttpUrl } from "./url-safety.js";
import type { ChatMessage, ModelClient } from "@actor0/harness";
import {
  CHATGPT_OAUTH,
  CLAUDE_OAUTH,
  ENDPOINTS,
  createModel,
  verifyProvider,
  type OAuthPreset,
  type ProviderTransport,
  type ResolvedProvider,
} from "@actor0/providers";
import { refreshProvider as refreshOAuthProvider, runSignIn } from "./oauth.js";
import {
  activeNamedProvider,
  addProvider,
  ConfigError,
  describeProviderInfo,
  endpointUrl,
  loadConfig,
  namedProviders,
  removeProvider,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  addModels,
  withActiveReasoningEffort,
  withContextWindow,
  withModel,
  type DesktopConfig,
  type NamedProvider,
} from "./config.js";
import { deleteSession, listSessionSummaries, loadSession, newSessionId, saveSession } from "./sessions.js";
import {
  formatTokens,
  readUsage,
  recordAudit,
  recordUsage,
  startOfDay,
  startOfMonth,
  startOfWeek,
  usageByModel,
  usageSince,
} from "./usage.js";
import { defaultSystemPrompt, withProjectContext } from "./prompt.js";
import { forStorage, repairHistory } from "./history.js";
import { createToolHost } from "./tools/host.js";
import { reapBackgroundProcesses, resolveShell } from "./tools/shell.js";import { createTaskDelegate, runTurn } from "./turn.js";
import type { FileBridge } from "./native/bridge.js";
import type {
  AgentInfo,
  AgentMethods,
  AgentNotification,
  ConfigSnapshot,
  ModelInfo,
  ProviderKindWire,
  ProviderTestResult,
  SessionSummaryWire,
  SignInResultWire,
  UsageSnapshot,
} from "./protocol.js";

/** The sign-in kinds this host offers, and the preset each one runs. */
const OAUTH_KINDS: { id: string; label: string; transport: ProviderTransport; baseUrl: string; preset: OAuthPreset }[] = [
  {
    id: "chatgpt",
    label: "Sign in with ChatGPT",
    transport: "chatgpt",
    baseUrl: ENDPOINTS.chatgpt.baseUrl,
    preset: CHATGPT_OAUTH,
  },
  {
    id: "claude",
    label: "Sign in with Claude",
    transport: "anthropic",
    baseUrl: ENDPOINTS.anthropic.baseUrl,
    preset: CLAUDE_OAUTH,
  },
];

const OAUTH_KIND_BY_ID = new Map(OAUTH_KINDS.map((kind) => [kind.id, kind]));

/**
 * The agent: the app's state machine.
 *
 * It owns the config, the current conversation, the session file and the turn
 * loop — everything a host has to own — and knows nothing about sockets,
 * windows or React. The server in `server.ts` translates frames into calls on
 * this object and this object's notifications into frames, which is what makes
 * the whole thing drivable from a test without opening a port.
 *
 * Two invariants are load-bearing and easy to lose:
 *
 *  - **One turn at a time.** A second `turn.send` while one is streaming is
 *    refused rather than queued: two turns writing one transcript interleave
 *    their tool results, which is a transcript no provider will accept.
 *  - **The transcript only advances when a turn adopts it.** A cancelled or
 *    failed turn leaves the *saved* transcript at what the turn really did (the
 *    harness hands it back), never at a partial state the host invented.
 */

export type AgentOptions = {
  cwd: string;
  bridge: FileBridge;
  version: string;
  /** Where notifications go. Set by the server; a test passes a collector. */
  notify?: (notification: AgentNotification) => void;
  /** Injected model client factory, for tests. */
  createClient?: (provider: ResolvedProvider) => ModelClient;
  /** Injected browser opener, so a sign-in can be exercised with no window. */
  browserOpener?: (url: string) => boolean;
};

export class Agent implements AgentMethods {
  private config: DesktopConfig;
  private messages: ChatMessage[] = [];
  private session: { id: string; createdAt: string } = { id: newSessionId(), createdAt: new Date().toISOString() };
  /** The model's short natural-language title for the conversation, set on the first turn. */
  private sessionTitle: string | undefined;
  private turnId = 0;
  private controller: AbortController | undefined;
  private running = false;
  private bridge: FileBridge;
  /** The directory the agent answers from. Mutable: a conversation started in
   *  another path moves it, so the tools, the system prompt and agent.hello all
   *  report where the agent is actually operating. */
  private cwd: string;
  private readonly version: string;
  private notify: (notification: AgentNotification) => void;
  private readonly createClient: (provider: ResolvedProvider) => ModelClient;
  /**
   * Opens a URL in the user's browser.
   *
   * Injected so a sign-in is testable with no window and no desktop session, and
   * because the desktop equivalent is a shell call rather than `xdg-open`.
   */
  private readonly browserOpener: ((url: string) => boolean) | undefined;

  constructor(options: AgentOptions) {
    this.cwd = options.cwd;
    this.bridge = options.bridge;
    this.version = options.version;
    this.config = loadConfig();
    this.notify = options.notify ?? (() => {});
    this.createClient = options.createClient ?? ((provider) => createModel(provider));
    this.browserOpener = options.browserOpener;
  }

  /** Point notifications at a sink (the server does this per connection). */
  setNotifier(notify: (notification: AgentNotification) => void): void {
    this.notify = notify;
  }

  // --- introspection -------------------------------------------------------

  async "agent.hello"(): Promise<AgentInfo> {
    return {
      version: this.version,
      cwd: this.cwd,
      bridge: this.bridge.kind,
      scoped: this.bridge.kind === "neutralino",
      shell: resolveShell().label,
      platform: process.platform,
    };
  }

  async "config.get"(): Promise<ConfigSnapshot> {
    return this.snapshot();
  }

  private snapshot(): ConfigSnapshot {
    const providers = namedProviders(this.config);
    const base: ConfigSnapshot = {
      providers,
      models: this.modelsForActive(),
      ...(this.config.activeProvider ? { activeProvider: this.config.activeProvider } : {}),
    };
    try {
      const resolved = resolveProvider(this.config);
      return { ...base, provider: describeProviderInfo(resolved) };
    } catch (error) {
      return { ...base, providerError: error instanceof Error ? error.message : String(error) };
    }
  }

  private modelsForActive(): string[] {
    const active = activeNamedProvider(this.config);
    if (active) {
      const list = active.models ?? (active.model ? [active.model] : []);
      const current = active.model ?? this.config.model;
      return [...new Set([current, ...list].filter(Boolean))];
    }
    const current = this.config.model || process.env.ACTOR0_MODEL?.trim() || "";
    return [...new Set([current, ...this.config.models].filter(Boolean))];
  }

  // --- provider registry ---------------------------------------------------

  async "provider.activate"(params: { name: string | null }): Promise<ConfigSnapshot> {
    if (params.name === null) {
      // Back to the built-in endpoint. Clearing the pointer is the whole
      // mechanism: `activeProvider` absent *means* built-in.
      this.config = { ...this.config, activeProvider: undefined };
    } else {
      const next = setActiveProvider(this.config, params.name);
      if (next === this.config) throw new Error(`no provider named "${params.name}"`);
      this.config = next;
    }
    saveConfig(this.config);
    this.changed();
    return this.snapshot();
  }

  async "provider.add"(params: { entry: Omit<NamedProvider, "name"> & { name?: string } }): Promise<ConfigSnapshot> {
    if (!params.entry?.baseUrl?.trim()) throw new ConfigError("a provider needs a base URL");
    this.config = addProvider(this.config, params.entry);
    saveConfig(this.config);
    this.changed();
    return this.snapshot();
  }

  async "provider.remove"(params: { name: string }): Promise<ConfigSnapshot> {
    this.config = removeProvider(this.config, params.name);
    saveConfig(this.config);
    this.changed();
    return this.snapshot();
  }

  async "provider.test"(params: { name?: string }): Promise<ProviderTestResult> {
    let config = this.config;
    if (params.name && params.name !== this.config.activeProvider) {
      config = setActiveProvider(this.config, params.name);
      if (config === this.config) return { ok: false, message: `no provider named "${params.name}"` };
    }
    let resolved: ResolvedProvider;
    try {
      resolved = resolveProvider(config);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!isPublicHttpUrl(resolved.baseUrl)) {
      return { ok: false, message: "that base URL points at a private or local address, which is not allowed" };
    }
    try {
      // A real request, not a configuration check: the only thing that proves
      // an endpoint works is an endpoint answering.
      await verifyProvider(resolved);
      return { ok: true, message: `${endpointUrl(resolved)} answered for model ${resolved.model}.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- sign-in -------------------------------------------------------------

  async "provider.kinds"(): Promise<ProviderKindWire[]> {
    // Built from the presets in `@actor0/providers`, so a kind cannot offer a
    // flow this build does not actually implement — and the constants it would
    // need are the ones the provider package owns.
    return OAUTH_KINDS.map((kind) => ({
      kind: kind.id,
      label: kind.label,
      transport: kind.transport,
      baseUrl: kind.baseUrl,
      auth: ["oauth"],
    }));
  }

  async "provider.signIn"(params: { kind: string }): Promise<SignInResultWire> {
    const preset = OAUTH_KIND_BY_ID.get(params.kind);
    if (!preset) {
      return { ok: false, message: `no sign-in flow named "${params.kind}"` };
    }
    try {
      const result = await runSignIn(preset.preset, {
        ...(this.browserOpener ? { openBrowser: this.browserOpener } : {}),
      });
      // Register, then store the tokens: doing it in one operation is what keeps
      // a sign-in from being repeated on every launch.
      const registered = addProvider(this.config, {
        name: preset.id,
        baseUrl: preset.baseUrl,
        transport: preset.transport,
        auth: "oauth",
        oauth: result.tokens,
      });
      this.config = registered;
      saveConfig(this.config);
      this.changed();
      return {
        ok: true,
        opened: result.opened,
        authorizeUrl: result.authorizeUrl,
        provider: activeNamedProvider(this.config) ?? {
          name: preset.id,
          baseUrl: preset.baseUrl,
        },
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- models and effort ---------------------------------------------------

  async "model.set"(params: { model: string }): Promise<ConfigSnapshot> {
    const model = params.model.trim();
    if (!model) throw new ConfigError("a model name is required");
    this.config = withModel(this.config, model);
    saveConfig(this.config);
    this.changed();
    return this.snapshot();
  }

  async "model.discover"(): Promise<ModelInfo[]> {
    let resolved: ResolvedProvider;
    try {
      resolved = resolveProvider(this.config);
    } catch {
      return [];
    }
    const models = await listModels(resolved);
    // Context windows the endpoint volunteers are worth keeping, and the
    // picker is the one place they arrive in bulk.
    if (models.length > 0) {
      const windows: Record<string, number> = {};
      for (const model of models) if (model.contextWindow) windows[model.id] = model.contextWindow;
      this.config = addModels(this.config, models.map((model) => model.id), windows);
      saveConfig(this.config);
      this.changed();
    }
    return models;
  }

  /**
   * List the models of an endpoint the user is *considering*, not the active one.
   *
   * The add-provider flow offers the candidate's real models before it is
   * registered, so the user picks from what exists rather than typing a name
   * and fixing it in `/model` later. Failing soft — an empty list — is right
   * for the picker; the add flow lets the user name a model by hand when the
   * endpoint lists none.
   */
  async "model.discoverFor"(params: { baseUrl: string; apiKey?: string }): Promise<ModelInfo[]> {
    const baseUrl = params.baseUrl.trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new ConfigError("a base URL starting with http:// or https:// is required");
    }
    if (!isPublicHttpUrl(baseUrl)) {
      throw new ConfigError("that base URL points at a private or local address, which is not allowed");
    }
    return listModels({ baseUrl, transport: "openai", ...(params.apiKey?.trim() ? { apiKey: params.apiKey.trim() } : {}) });
  }

  async "thinking.set"(params: { effort: "low" | "medium" | "high" | null }): Promise<ConfigSnapshot> {
    this.config = withActiveReasoningEffort(this.config, params.effort ?? undefined);
    saveConfig(this.config);
    this.changed();
    return this.snapshot();
  }

  // --- sessions ------------------------------------------------------------

  async "session.list"(): Promise<SessionSummaryWire[]> {
    return listSessionSummaries().map((summary) => ({
      id: summary.id,
      updatedAt: summary.updatedAt,
      model: summary.model,
      messageCount: summary.messageCount,
      ...(summary.cwd ? { cwd: summary.cwd } : {}),
      ...(summary.title ? { title: summary.title } : {}),
    }));
  }

  async "session.load"(params: { id: string }): Promise<{ messages: unknown[]; model: string }> {
    const stored = loadSession(params.id);
    if (!stored) throw new Error(`no session named "${params.id}"`);
    if (this.running) throw new Error("cannot switch sessions while a turn is running");
    if (stored.cwd) {
      const resolved = resolve(stored.cwd);
      const normalized = resolved.replace(/\\/g, "/");
      const isRoot = normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized);
      if (!isRoot && existsSync(resolved) && statSync(resolved).isDirectory()) {
        this.cwd = resolved;
      }
    }
    this.messages = stored.messages;
    this.session = { id: stored.id, createdAt: stored.createdAt || new Date().toISOString() };
    this.sessionTitle = stored.title;
    if (stored.model) {
      this.config = withModel(this.config, stored.model);
      saveConfig(this.config);
    }
    this.changed();
    return { messages: stored.messages, model: stored.model };
  }

  /** `cwd` is accepted but not applied: the working directory is fixed when the
   * agent process starts, so a conversation in another directory means launching
   * the agent there. The UI sends it for forward-compatibility only. */
  /**
   * Start a new conversation, optionally in another directory.
   *
   * The path is applied to the agent itself, not just recorded: the tool host,
   * the system prompt's project context and agent.hello all read `this.cwd`, so
   * a conversation started in d:/projects/other actually reads and writes there.
   * (It used to accept the path and drop it, so the UI said one thing and the
   * agent kept operating in its launch directory.)
   */
  async "session.new"(params?: { cwd?: string }): Promise<{ ok: true }> {
    if (this.running) throw new Error("cannot start a new conversation while a turn is running");
    const next = params?.cwd?.trim();
    if (next && next !== this.cwd) {
      const resolved = resolve(next);
      // Refuse paths that are not an existing directory, or that are a filesystem
      // root (which would erase write containment).
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        throw new Error(`"${next}" is not an existing directory`);
      }
      const normalized = resolved.replace(/\\/g, "/");
      if (normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) {
        throw new Error(`refusing to re-root the agent at a filesystem root`);
      }
      this.cwd = resolved;
    }
    this.messages = [];
    this.session = { id: newSessionId(), createdAt: new Date().toISOString() };
    this.sessionTitle = undefined;
    this.changed();
    return { ok: true };
  }

  async "session.delete"(params: { ids: string[] }): Promise<{ deleted: string[]; missing: string[] }> {
    if (!Array.isArray(params?.ids ?? undefined)) throw new Error("ids: expected a list of session ids");
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const id of params.ids) {
      if (id === this.session.id) throw new Error("cannot delete the conversation you are in");
      if (deleteSession(id)) deleted.push(id);
      else missing.push(id);
    }
    return { deleted, missing };
  }

  /** The current transcript, for a UI that is (re)connecting. */
  async "conversation.get"(): Promise<{ sessionId: string; messages: unknown[] }> {
    return { sessionId: this.session.id, messages: this.messages };
  }

  conversation(): ChatMessage[] {
    return this.messages;
  }

  // --- usage and MCP -------------------------------------------------------

  async "usage.get"(params: { period: "day" | "week" | "month" | "all" }): Promise<UsageSnapshot> {
    const entries = readUsage();
    const since =
      params.period === "day" ? startOfDay() : params.period === "week" ? startOfWeek() : params.period === "month" ? startOfMonth() : 0;
    const bucket = usageSince(entries, since);
    return {
      period: params.period,
      tokens: bucket.tokens,
      turns: bucket.turns,
      byModel: usageByModel(entries, since),
    };
  }

  async "mcp.status"(): Promise<{ configured: number; servers: string[] }> {
    // The desktop app hosts no MCP servers yet; the panel says so rather than
    // showing a list that is not real.
    return { configured: 0, servers: [] };
  }

  // --- turns ---------------------------------------------------------------

  async "turn.send"(params: { input: string }): Promise<{ turnId: string }> {
    return this.startTurn(params.input, false);
  }

  async "turn.reply"(params: { input: string }): Promise<{ turnId: string }> {
    return this.startTurn(params.input, true);
  }

  private async startTurn(input: string, isReply: boolean): Promise<{ turnId: string }> {
    const text = input.trim();
    if (!text) throw new Error("cannot send an empty message");
    if (this.running) throw new Error("a turn is already running");

    const turnId = `t${++this.turnId}`;
    // A reply and an ordinary send are the same operation, and saying so in one
    // place is what keeps the two paths from drifting.
    void isReply;

    let provider: ResolvedProvider;
    try {
      provider = resolveProvider(this.config);
      // A token that is about to expire is refreshed before the request rather
      // than after the 401: the failure is not retriable by the harness (it is a
      // clean refusal), so a turn that skipped this would end with "sign in
      // again" instead of simply working.
      const refreshed = await refreshOAuthProvider(
        provider as ResolvedProvider & { auth?: string; oauth?: import("@actor0/providers").OAuthTokens },
        this.config,
      );
      if (refreshed) {
        provider = refreshed.provider as unknown as ResolvedProvider;
        this.config = refreshed.config;
        saveConfig(this.config);
        this.notify({ type: "notice", tone: "info", text: "Refreshed the sign-in." });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.notify({ type: "notice", tone: "error", text: message });
      this.notify({
        type: "turn.finished",
        turnId,
        result: { turnId, ok: false, rounds: 0, usage: [], truncated: false, blocked: false, error: message },
      });
      throw error;
    }

    this.running = true;
    this.controller = new AbortController();
    this.notify({ type: "turn.started", turnId });

    // Run detached: the caller gets its turnId immediately and the stream
    // arrives as notifications, which is what lets the UI render tokens as they
    // land rather than waiting for the turn to end.
    void this.runTurnDetached(turnId, text, provider);

    return { turnId };
  }

  private async runTurnDetached(turnId: string, input: string, provider: ResolvedProvider): Promise<void> {
    const controller = this.controller!;
    const toolHostFor = (delegate?: ReturnType<typeof createTaskDelegate>) =>
      createToolHost({
        cwd: this.cwd,
        bridge: this.bridge,
        ...(delegate ? { taskDelegate: delegate } : {}),
      });

    let systemPrompt = this.config.systemPrompt?.trim() || defaultSystemPrompt(resolveShell(), provider.model);
    systemPrompt = withProjectContext(systemPrompt, this.cwd);
    // The system message is re-seeded on every turn and never persisted, so a
    // session opened later gets the *current* prompt rather than the one it was
    // written with. The user's own message is *not* added here: the harness
    // appends `input` itself, and adding it twice would put the question in the
    // transcript twice and make the provider's turn count wrong.
    const seeded: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...this.messages];

    const taskDelegate = createTaskDelegate({
      model: provider,
      cwd: this.cwd,
      toolHostFor: (delegate) => toolHostFor(delegate as ReturnType<typeof createTaskDelegate> | undefined),
      onEvent: (event) => this.notify({ type: "turn.event", turnId, event }),
    });

    const toolHost = toolHostFor(taskDelegate);
    let ok = false;
    let rounds = 0;
    let usage: Awaited<ReturnType<typeof runTurn>>["result"]["usage"] = [];
    let truncated = false;
    let blocked = false;
    let errorMessage: string | undefined;

    try {
      const outcome = await runTurn({
        model: provider,
        client: this.createClient(provider),
        messages: seeded,
        input,
        toolHost,
        signal: controller.signal,
        cwd: this.cwd,
        onEvent: (event) => this.notify({ type: "turn.event", turnId, event }),
        ...(this.config.maxToolRounds ? { maxToolRounds: this.config.maxToolRounds } : {}),
      });
      const result = outcome.result;
      rounds = result.rounds;
      usage = result.usage;
      truncated = Boolean(result.truncated);
      blocked = Boolean(result.blocked);
      ok = !blocked && !truncated;
      this.adoptTranscript(forStorage(result.messages));
      try {
        recordAudit(provider.model, result.audit);
      } catch {
        /* the audit log is best-effort */
      }
      if (outcome.recovery) {
        this.notify({
          type: "notice",
          tone: "info",
          text: `Conversation did not fit — cleared stale tool output and retried (${formatTokens(outcome.recovery.before - outcome.recovery.after)} characters).`,
        });
      }
      // The first exchange names the conversation: the model writes a short
      // natural-language title once, and the session picker stops showing an
      // ISO timestamp nobody reads. Best-effort — a provider without a cheap
      // mode simply leaves the session untitled.
      if (!this.sessionTitle && !controller.signal.aborted) {
        void this.titleConversation(provider, controller.signal).catch(() => undefined);
      }
      if (blocked) this.notify({ type: "notice", tone: "warn", text: "Stopped — reply to continue." });
      if (truncated) this.notify({ type: "notice", tone: "warn", text: "The answer was cut off at the model's output limit." });
    } catch (error) {
      if (controller.signal.aborted) {
        // A cancel still leaves a transcript — the harness hands it back on the
        // error — so the work that already happened stays in the session.
        const recovered = (error as { messages?: ChatMessage[] }).messages;
        if (recovered) this.adoptTranscript(forStorage(repairHistory(recovered)));
        this.notify({ type: "notice", tone: "warn", text: "Interrupted." });
        errorMessage = "interrupted";
      } else {
        const recovered = (error as { messages?: ChatMessage[] }).messages;
        if (recovered) this.adoptTranscript(forStorage(repairHistory(recovered)));
        errorMessage = error instanceof Error ? error.message : String(error);
        this.notify({ type: "notice", tone: "error", text: errorMessage });
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      const total = usage.reduce(
        (acc, item) => ({
          prompt_tokens: acc.prompt_tokens + (item.prompt_tokens ?? 0),
          completion_tokens: acc.completion_tokens + (item.completion_tokens ?? 0),
          total_tokens: acc.total_tokens + (item.total_tokens ?? 0),
        }),
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      );
      if (total.total_tokens > 0) {
        try {
          recordUsage(provider.model, total);
        } catch {
          /* the usage log is best-effort; a failure there must not fail a turn */
        }
      }
      this.persist();
      this.notify({
        type: "turn.finished",
        turnId,
        result: {
          turnId,
          ok,
          rounds,
          usage,
          truncated,
          blocked,
          ...(errorMessage ? { error: errorMessage } : {}),
        },
      });
    }
  }

  /** Adopt a transcript a turn produced, and remember the model's window. */
  private adoptTranscript(messages: ChatMessage[]): void {
    this.messages = messages;
    try {
      const provider = resolveProvider(this.config);
      const window = contextWindowOf(provider);
      if (window) this.config = withContextWindow(this.config, provider.model, window);
    } catch {
      /* an unresolvable provider is reported by the next turn, not here */
    }
  }

  async "turn.cancel"(): Promise<{ cancelled: boolean }> {
    if (!this.controller) return { cancelled: false };
    this.controller.abort(new Error("cancelled by the user"));
    return { cancelled: true };
  }

  private persist(): void {
    try {
      saveSession({
        id: this.session.id,
        createdAt: this.session.createdAt,
        updatedAt: new Date().toISOString(),
        model: this.config.model,
        messages: this.messages,
        ...(this.cwd ? { cwd: this.cwd } : {}),
        ...(this.sessionTitle ? { title: this.sessionTitle } : {}),
      });
    } catch (error) {
      this.notify({
        type: "notice",
        tone: "warn",
        text: `could not save the session: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private changed(): void {
    this.notify({ type: "state.changed" });
  }

  /**
   * Ask the model for a 3–5 word natural-language title for the conversation.
   *
   * Runs once, after the first successful exchange, as a detached best-effort
   * request: a failure leaves the session untitled (the picker falls back to
   * the date) and never blocks or breaks the turn that triggered it.
   */
  private async titleConversation(provider: ResolvedProvider, signal: AbortSignal): Promise<void> {
    const firstUser = this.messages.find((message) => message.role === "user");
    if (!firstUser) return;
    const client = this.createClient(provider);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content:
          `Write a 3-5 word title for this conversation, in the same language as the user's message. ` +
          `Reply with only the title, no quotes, no punctuation at the end.\n\nConversation:\n${firstUser.content.slice(0, 2000)}`,
      },
    ];
    // ModelClient only streams; collect the answer text from the events. The
    // title request carries no tools, so nothing else can arrive.
    let text = "";
    for await (const event of client.stream(messages, [], signal)) {
      if (event.type === "token") text += event.delta;
    }
    const title = text.trim().replace(/^["']+|["']+$/g, "").split("\n")[0];
    if (title && title.length >= 2 && title.length <= 80) {
      this.sessionTitle = title.slice(0, 80);
      this.persist();
      this.changed();
    }
  }

  /** Stop everything; called on shutdown. */
  dispose(): void {
    this.controller?.abort(new Error("shutting down"));
    // Detached background shell children outlive a cancel and the session;
    // reap them explicitly so a dev server the model started cannot survive the
    // app exiting.
    reapBackgroundProcesses();
  }
}

/**
 * List an endpoint’s models the way an OpenAI-compatible server publishes them.
 *
 * Only that transport has a portable listing endpoint; the others publish no
 * equivalent and answer with an empty list rather than invented names. Failing
 * soft is right for the picker, and both callers let the user name a model by
 * hand when nothing is listed.
 */
async function listModels(resolved: { baseUrl: string; transport?: string; apiKey?: string; headers?: Record<string, string> }): Promise<ModelInfo[]> {
  if ((resolved.transport ?? "openai") !== "openai") return [];
  if (!isPublicHttpUrl(resolved.baseUrl)) return [];
  const base = resolved.baseUrl.replace(/\/+$/, "");
  const url = `${base}/models`;
  try {
    const response = await fetch(url, {
      headers: {
        ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
        ...(resolved.headers ?? {}),
      },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: { id?: unknown; context_window?: unknown }[] };
    const models: ModelInfo[] = [];
    for (const entry of payload.data ?? []) {
      if (typeof entry.id !== "string" || !entry.id) continue;
      models.push({
        id: entry.id,
        ...(typeof entry.context_window === "number" && entry.context_window > 0 ? { contextWindow: entry.context_window } : {}),
      });
    }
    return models;
  } catch {
    return [];
  }
}

/** The context window a provider reported, when it reported one. */
function contextWindowOf(provider: ResolvedProvider): number | undefined {
  const raw = (provider as { contextWindow?: unknown }).contextWindow;
  return typeof raw === "number" && raw > 0 ? raw : undefined;
}
