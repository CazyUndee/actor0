import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ModelClient } from "@actor0/harness";
import {
  activeNamedProvider,
  addProvider,
  addModels,
  namedProviders,
  removeProvider,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  withActiveReasoningEffort,
  withContextWindow,
  withModel,
  providerName,
  type CliConfig,
  type NamedProvider,
  type ResolvedProvider,
} from "../config.js";
import {
  applyEvent,
  emptyLive,
  initialConversation,
  totalUsage,
  withHelp,
  withNotice,
  withUserInput,
  type ConversationState,
} from "../conversation.js";
import {
  cancelledTurnMessages,
  describeRecovery,
  describeStop,
  describeTruncation,
  failedTurnMessages,
  forStorage,
  runTurn,
  verifyProvider,
} from "../turn.js";
import { newSessionId, saveSession } from "../session.js";
import { refreshProvider } from "../sign-in.js";
import { recordAudit, recordUsage, formatTokens, contextBar, readUsage, startOfDay, startOfWeek, startOfMonth, usageSince, usageByModel } from "../usage.js";
import { gitBranch } from "../git.js";
import { detectEnvironment } from "../environment.js";
import { contextWindowTokens } from "@actor0/harness";
import { parseSlash, matchSlashCommands, type SlashCommand } from "../slash.js";
import { color, timing } from "../theme.js";
import { createToolHost } from "../tools.js";
import { Screen } from "./term.js";
import { parseInput, type InputEvent } from "./input.js";
import {
  entryLines,
  liveLines,
  composerRows,
  providerPanelRows,
  managePanelRows,
  panel,
  modelPickerRows,
  thinkingPickerRows,
  usagePanelRows,
  slashPopupRows,
  addKindRows,
  addUrlRows,
  addKeyRows,
  addWorkingRows,
  addErrorRows,
  addModelsRows,
  addManualRows,
  stateFace,
  topArea,
  windowRows,
  frameInnerWidth,
  topFrameBorder,
  bottomFrameBorder,
  paint,
  fitWidth,
  type Face,
  type Seg,
} from "./render.js";
import { PROVIDER_KINDS, type ProviderKind } from "../provider-presets.js";
import { providerLabel } from "../provider-presets.js";
import { fetchModelInfos, fetchClaudePlan } from "../models.js";
import { runOAuthSignIn } from "../sign-in.js";
import { openBrowser } from "../oauth.js";
import type { OAuthTokens } from "../oauth.js";

/**
 * The app, as our own controller.
 *
 * It keeps every bit of the CLI's state and logic — the turn loop, config,
 * sessions, usage, onboarding, the slash commands, and the provider/model/
 * thinking/usage panels — but it does not render through Ink. Ink is the wrong
 * tool for this TUI: a full-height frame makes the terminal scroll on every
 * repaint and re-rendering the whole tree on every streamed token drops
 * characters. So this returns `null` (Ink writes nothing), draws the screen
 * itself through `Screen`, and reads input through its own parser. React is
 * used only for state and effects, which is all it is good for here.
 */

export type AppProps = {
  cwd: string;
  config: CliConfig;
  resumed?: { id: string; createdAt: string; updatedAt: string; messages: ChatMessage[] };
  version?: string;
  transport?: ModelClient;
  /** Our renderer. */
  screen: Screen;
  /** The raw TTY stdin, already in raw mode. */
  stdin: NodeJS.ReadStream;
  /** Called on quit, after the screen is restored. */
  onExit: () => void;
};

type Mode = "chat" | "menu" | "manage" | "add" | "usage" | "model" | "thinking";

type AddPhase =
  | { kind: "kind" }
  | { kind: "url"; provider: ProviderKind }
  | { kind: "key"; provider: ProviderKind; baseUrl: string }
  | { kind: "working"; label: string; note: string }
  | { kind: "models"; label: string; base: Record<string, unknown>; models: string[]; cursor: number; chosen: Set<string>; windows: Record<string, number>; query: string; existingProvider?: string }
  | { kind: "error"; provider: ProviderKind; message: string; baseUrl?: string };

const THINKING = [
  { label: "default (provider)", effort: undefined },
  { label: "low", effort: "low" },
  { label: "medium", effort: "medium" },
  { label: "high", effort: "high" },
] as const;

const PERIODS: { key: string; label: string; since: (now: Date) => number }[] = [
  { key: "day", label: "today", since: startOfDay },
  { key: "week", label: "this week", since: startOfWeek },
  { key: "month", label: "this month", since: startOfMonth },
];

function wrap(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

export function App({ cwd, config: initialConfig, resumed, version = "0.0.0", transport, screen, stdin, onExit }: AppProps) {
  const [config, setConfig] = useState<CliConfig>(initialConfig);
  const [conversation, setConversation] = useState<ConversationState>(() => initialConversation());
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState<Mode>("chat");
  const [onboarding, setOnboarding] = useState(false);
  const [contextTokens, setContextTokens] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [justFinished, setJustFinished] = useState(false);
  const finishedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Menu cursors and the add-provider phase machine. Every picker shares
  // the same shape: a cursor over its (filtered) items and a search query.
  const [menuIndex, setMenuIndex] = useState(0);
  const [providerQuery, setProviderQuery] = useState("");
  const [manageProvider, setManageProvider] = useState<string | null>(null);
  const [manageCursor, setManageCursor] = useState(0);
  const [manageConfirm, setManageConfirm] = useState(false);
  const [modelCursor, setModelCursor] = useState(0);
  const [modelQuery, setModelQuery] = useState("");
  const [thinkingCursor, setThinkingCursor] = useState(0);
  const [thinkingQuery, setThinkingQuery] = useState("");
  const [usageIndex, setUsageIndex] = useState(0);
  const [add, setAdd] = useState<AddPhase>({ kind: "kind" });
  const [addKindCursor, setAddKindCursor] = useState(0);
  const [addKindQuery, setAddKindQuery] = useState("");
  const [addKey, setAddKey] = useState("");
  const [addUrl, setAddUrl] = useState("");;
  const [addManual, setAddManual] = useState("");
  const signInAbort = useRef<AbortController | null>(null);

  const messagesRef = useRef<ChatMessage[]>(resumed?.messages ?? []);
  const sessionIdRef = useRef<string>(resumed?.id ?? newSessionId());
  const abortRef = useRef<AbortController | null>(null);
  const liveRef = useRef<ChatMessage[]>(messagesRef.current);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const openedOnboarding = useRef(false);

  const updateLive = (messages: ChatMessage[]): void => {
    liveRef.current = messages;
  };

  const toolHost = useMemo(() => createToolHost({ cwd }), [cwd]);

  const resolved = useMemo(() => {
    try {
      return { provider: resolveProvider(config), error: undefined } as const;
    } catch (error) {
      return { provider: null, error: (error as Error).message } as const;
    }
  }, [config]);
  const provider = resolved.provider;

  const active = activeNamedProvider(config);
  const endpoint = active ? providerLabel(active) : "not configured";
  const activeModel = active?.model;
  const contextWindow = activeModel ? config.contextWindows?.[activeModel] : undefined;
  const { branch, tokensToday } = useMemo(
    () => ({ branch: gitBranch(cwd), tokensToday: usageSince(readUsage(), startOfDay()).tokens }),
    [cwd, contextTokens],
  );
  const context =
    contextTokens > 0
      ? contextWindow && contextTokens <= contextWindow * 4
        ? { text: `${contextBar(contextTokens / contextWindow)} ${Math.min(100, Math.round((contextTokens / contextWindow) * 100))}%` }
        : { text: `${formatTokens(contextTokens)} tokens` }
      : undefined;

  const notice = (tone: "info" | "warn" | "error", text: string): void => {
    setConversation((state) => withNotice(state, tone, text));
  };

  // Onboarding: with nothing configured, open the add flow as a welcome.
  useEffect(() => {
    if (openedOnboarding.current) return;
    if (!provider && /No provider is configured/.test(resolved.error ?? "")) {
      openedOnboarding.current = true;
      setOnboarding(true);
      setMode("add");
      setAdd({ kind: "kind" });
    }
  }, [provider, resolved.error]);

  // Warm the environment probe at startup. Its first call spawns a shell, and
  // every turn's system prompt needs it — so pay that once, here, during load,
  // instead of on the first message the user sends (which otherwise stalls for
  // seconds before a single token appears). Fire-and-forget: the result is
  // cached for the turn that eventually needs it.
  useEffect(() => {
    void detectEnvironment(cwd);
  }, [cwd]);

  // Redraw at the new size on resize. The render effect only runs on a state
  // change, and a resize is not one, so without this the old-size grid is left
  // on a resized terminal and everything after it is misaligned.
  const [, forceRedraw] = useState(0);
  useEffect(() => {
    const onResize = (): void => {
      screen.setSize(process.stdout.rows ?? 24, process.stdout.columns ?? 80);
      forceRedraw((n) => n + 1);
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, [screen]);

  // Spinner + elapsed clock.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => {
      setFrame((n) => n + 1);
      setElapsed(Math.round((Date.now() - started) / 1000));
    }, timing.spinnerMs);
    return () => clearInterval(id);
  }, [busy]);

  const runCommand = (command: SlashCommand): void => {
    switch (command.name) {
      case "help":
        setConversation((state) => withHelp(state));
        return;
      case "clear":
        sessionIdRef.current = newSessionId();
        messagesRef.current = [];
        setConversation(initialConversation());
        notice("info", "started a new conversation");
        return;
      case "model":
        if (command.model) {
          const next = withModel(config, command.model);
          setConfig(next);
          saveConfig(next);
          notice("info", `model set to ${command.model}`);
          return;
        }
        if (config.models.length === 0) {
          notice("info", `model is ${config.model || provider?.model || "(none)"} — switch with /model <name>`);
          return;
        }
        setModelCursor(Math.max(0, config.models.indexOf(provider?.model ?? config.model)));
        setModelQuery("");
        setMode("model");
        return;
      case "provider":
        setMenuIndex(0);
        setProviderQuery("");
        setMode("menu");
        return;
      case "setup":
        setOnboarding(true);
        setAdd({ kind: "kind" });
        setAddKindQuery("");
        setMode("add");
        return;
      case "usage":
        setUsageIndex(0);
        setMode("usage");
        return;
      case "thinking":
        if (command.effort === "low" || command.effort === "medium" || command.effort === "high") {
          const next = withActiveReasoningEffort(config, command.effort);
          setConfig(next);
          saveConfig(next);
          notice("info", `reasoning effort set to ${command.effort}`);
          return;
        }
        setThinkingCursor(Math.max(0, THINKING.findIndex((o) => o.effort === active?.reasoningEffort)));
        setThinkingQuery("");
        setMode("thinking");
        return;
      case "quit":
        onExit();
        return;
      case "unknown":
        notice("warn", `unknown command ${command.input} — try /help`);
    }
  };

  const submit = (raw: string): void => {
    const input = raw.trim();
    if (!input) return;
    if (busy) {
      notice("warn", "still working — wait for the turn, or press Esc to cancel it");
      return;
    }
    const command = parseSlash(input);
    if (command) {
      setDraft("");
      setCaret(0);
      setScrollOffset(0);
      if (finishedTimer.current) clearTimeout(finishedTimer.current);
      finishedTimer.current = null;
      setJustFinished(false);
      runCommand(command);
      return;
    }
    setDraft("");
    setCaret(0);
    setScrollOffset(0);
    if (finishedTimer.current) clearTimeout(finishedTimer.current);
    finishedTimer.current = null;
    setJustFinished(false);
    setConversation((state) => withUserInput(state, input));
    setBusy(true);
    if (!provider) {
      setOnboarding(true);
      setAdd({ kind: "kind" });
      setMode("add");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        let activeProvider = provider;
        if (provider.auth === "oauth") {
          const refreshed = await refreshProvider(provider, config).catch(() => undefined);
          if (refreshed) {
            activeProvider = refreshed.provider;
            setConfig(refreshed.config);
            saveConfig(refreshed.config);
          }
        }
        const { result, recovery } = await runTurn({
          model: activeProvider,
          ...(transport ? { client: transport } : {}),
          messages: messagesRef.current,
          input,
          toolHost,
          signal: controller.signal,
          cwd,
          ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
          onEvent: (event) =>
            setConversation((state) => {
              const next = applyEvent(state, event);
              if (event.type === "done") {
                const answer = next.entries[next.entries.length - 1];
                if (answer?.kind === "assistant") updateLive([...messagesRef.current, { role: "assistant", content: answer.text }]);
              }
              return next;
            }),
        });
        messagesRef.current = forStorage(result.messages);
        updateLive(messagesRef.current);
        if (result.blocked) notice("warn", describeStop(conversationRef.current.blocked?.reason));
        if (result.truncated) notice("warn", describeTruncation());
        if (recovery) notice("warn", describeRecovery(recovery));
        const total = totalUsage(result.usage);
        recordUsage(provider.model, total);
        recordAudit(provider.model, result.audit);
        setContextTokens(total.prompt_tokens);
      } catch (error) {
        const learned = contextWindowTokens(error);
        if (learned !== undefined) {
          const next = withContextWindow(config, provider.model, learned);
          setConfig(next);
          saveConfig(next);
        }
        const recovered = cancelledTurnMessages(error) ?? failedTurnMessages(error);
        if (recovered) {
          messagesRef.current = recovered;
          updateLive(recovered);
        }
        if (controller.signal.aborted) {
          setConversation((state) => {
            const partial = state.live.text;
            const kept: ConversationState = partial.trim() ? { ...state, entries: [...state.entries, { kind: "assistant", text: partial, partial: true }] } : state;
            return withNotice({ ...kept, live: emptyLive() }, "warn", "cancelled — what you see above is all that was kept");
          });
        } else {
          setConversation((state) => {
            const partial = state.live.text;
            const kept: ConversationState = partial.trim() ? { ...state, entries: [...state.entries, { kind: "assistant", text: partial, partial: true }] } : state;
            return withNotice({ ...kept, live: emptyLive() }, "error", (error as Error).message);
          });
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setJustFinished(true);
        if (finishedTimer.current) clearTimeout(finishedTimer.current);
        finishedTimer.current = setTimeout(() => {
          setJustFinished(false);
          finishedTimer.current = null;
        }, 2200);
        try {
          saveSession({
            id: sessionIdRef.current,
            createdAt: resumed?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            model: provider.model,
            messages: liveRef.current,
          });
        } catch (error) {
          notice("error", `could not save session: ${(error as Error).message}`);
        }
      }
    })();
  };

  // ---- add-provider flow ----
  const addSignIn = (kind: ProviderKind): void => {
    if (!kind.oauth) return;
    const controller = new AbortController();
    signInAbort.current = controller;
    setAdd({ kind: "working", label: kind.label, note: "opening your browser to authorize…" });
    void runOAuthSignIn(kind.oauth, {
      signal: controller.signal,
      openBrowser: (url) => {
        setAdd({ kind: "working", label: kind.label, note: `authorize in your browser (or open this URL):\n${url}` });
        openBrowser(url);
      },
    })
      .then(async (tokens: OAuthTokens) => {
        const withPlan = kind.transport === "anthropic" && !tokens.plan ? { ...tokens, plan: await fetchClaudePlan(tokens.accessToken).catch(() => undefined) } : tokens;
        addListModels(kind, buildBase(kind, kind.baseUrl, { auth: "oauth", oauth: withPlan }));
      })
      .catch((error: Error) => setAdd({ kind: "error", provider: kind, message: error.message }));
  };

  const addListModels = (kind: ProviderKind, base: Record<string, unknown>): void => {
    setAdd({ kind: "working", label: kind.label, note: "listing models…" });
    void fetchModelInfos(base as never)
      .then((infos) => {
        const windows: Record<string, number> = {};
        for (const info of infos) if (info.contextWindow !== undefined) windows[info.id] = info.contextWindow;
        setAdd({ kind: "models", label: kind.label, base, models: infos.map((i) => i.id), cursor: 0, chosen: new Set(), windows, query: "" });
      })
      .catch((error: Error) => setAdd({ kind: "error", provider: kind, message: error.message, baseUrl: String(base.baseUrl ?? "") }));
  };

  /**
   * Re-discover an already-configured provider's models and let the user pick
   * more to add — the same multi-select as the add flow, but it grows the
   * existing provider instead of registering a new one.
   */
  const manageModels = (name?: string): void => {
    const target = name ? namedProviders(config).find((p) => p.name === name) : activeNamedProvider(config);
    if (!target) {
      notice("warn", "no such provider — switch to one, or add a new one");
      return;
    }
    const label = providerLabel(target);
    setAdd({ kind: "working", label, note: `listing ${label} models…` });
    setMode("add");
    void fetchModelInfos(target as never)
      .then((infos) => {
        const windows: Record<string, number> = {};
        for (const info of infos) if (info.contextWindow !== undefined) windows[info.id] = info.contextWindow;
        setAdd({ kind: "models", label, base: target as never, models: infos.map((i) => i.id), cursor: 0, chosen: new Set(), windows, query: "", existingProvider: target.name });
      })
      .catch((error: Error) => {
        notice("error", `couldn't list ${label} models: ${error.message}`);
        setAdd({ kind: "kind" });
        setMode("menu");
      });
  };

  const addRegister = (chosen: string[]): void => {
    if (add.kind !== "models") return;
    // Managing an already-configured provider: add the chosen models to it
    // rather than registering a new endpoint.
    if (add.existingProvider) {
      const picked = [...new Set(chosen)];
      let next = addModels(config, picked, add.windows);
      const active = activeNamedProvider(next);
      if (active && !active.model && picked[0]) next = withModel(next, picked[0]!);
      setConfig(next);
      saveConfig(next);
      setMode("menu");
      setOnboarding(false);
      notice("info", picked.length ? `added ${picked.length} model${picked.length === 1 ? "" : "s"} to ${add.existingProvider}` : "no models added");
      return;
    }
    const activeModelName = chosen[0] ?? add.models[add.cursor];
    const providerToAdd: NamedProvider = { ...(add.base as object), name: providerName(String(add.base.baseUrl ?? "")), ...(activeModelName ? { model: activeModelName } : {}) } as NamedProvider;
    let next = addProvider(config, providerToAdd);
    const remembered = [...new Set([providerToAdd.model, ...chosen].filter((m): m is string => Boolean(m)))];
    const rest = next.models.filter((m) => !remembered.includes(m));
    next = { ...next, models: [...remembered, ...rest].slice(0, 20) };
    for (const [model, win] of Object.entries(add.windows)) next = withContextWindow(next, model, win);
    setConfig(next);
    saveConfig(next);
    setMode("chat");
    setOnboarding(false);
    const name = next.activeProvider ?? "provider";
    if (!onboarding) {
      notice("info", `added ${name}${remembered.length ? ` · ${remembered.length} model${remembered.length === 1 ? "" : "s"}` : ""}`);
      return;
    }
    let resolvedProvider: ResolvedProvider;
    try {
      resolvedProvider = resolveProvider(next);
    } catch {
      notice("info", `added ${name} — set a model with /model <name> to start.`);
      return;
    }
    notice("info", `verifying ${name}…`);
    void verifyProvider(resolvedProvider).then((result) => {
      if (result.ok) notice("info", `ready — ${name} works. Ask anything, or /provider to manage providers.`);
      else if (result.retriable) notice("warn", `added ${name}, but couldn't verify it (network) — it may still work.`);
      else notice("warn", `added ${name}, but it didn't answer: ${result.message}`);
    });
  };

  // ---- draft editing (the composer input, ours) ----
  const editDraft = (event: InputEvent): boolean => {
    if (event.type === "text") {
      setDraft((d) => d.slice(0, caret) + event.text + d.slice(caret));
      setCaret((c) => c + event.text.length);
      return true;
    }
    if (event.type !== "key") return false;
    switch (event.key) {
      case "backspace":
        if (caret > 0) {
          setDraft((d) => d.slice(0, caret - 1) + d.slice(caret));
          setCaret((c) => c - 1);
        }
        return true;
      case "delete":
        setDraft((d) => d.slice(0, caret) + d.slice(caret + 1));
        return true;
      case "left":
        setCaret((c) => Math.max(0, c - 1));
        return true;
      case "right":
        setCaret((c) => Math.min(draft.length, c + 1));
        return true;
      case "home":
        setCaret(0);
        return true;
      case "end":
        setCaret(draft.length);
        return true;
      case "ctrl-u":
        setDraft("");
        setCaret(0);
        return true;
      default:
        return false;
    }
  };

  const slashToken = /^\/([a-z]*)$/i.exec(draft)?.[1];
  const slashEngaged = mode === "chat" && slashToken !== undefined && slashDismissed !== slashToken;
  const slashMatches = slashEngaged ? matchSlashCommands(slashToken!) : [];
  const slashSel = slashMatches.length > 0 ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  // The model picker filters on a search query; an empty query is every model.
  const filteredModels = modelQuery ? config.models.filter((m) => m.toLowerCase().includes(modelQuery.toLowerCase())) : config.models;
  // Every picker filters the same way — provider, reasoning effort, add-kind.
  const allProviders = namedProviders(config);
  const filteredProviders = providerQuery ? allProviders.filter((p) => `${p.name} ${providerLabel(p)}`.toLowerCase().includes(providerQuery.toLowerCase())) : allProviders;
  const filteredThinking = thinkingQuery ? THINKING.filter((o) => o.label.toLowerCase().includes(thinkingQuery.toLowerCase())) : THINKING;
  const filteredKinds = addKindQuery ? PROVIDER_KINDS.filter((k) => `${k.label} ${k.auth.join(" ")}`.toLowerCase().includes(addKindQuery.toLowerCase())) : PROVIDER_KINDS;

  // ---- input dispatch ----
  // One listener for the life of the stream; it calls the latest dispatch through
  // a ref. Re-subscribing on every render (no deps) is what let a buffered
  // chunk reach two closures during a turn's many re-renders and submit twice.
  const dispatchRef = useRef<(event: InputEvent) => void>(() => {});
  useEffect(() => {
    let rest = "";
    const onData = (chunk: Buffer | string): void => {
      rest += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parsed = parseInput(rest);
      rest = parsed.rest;
      for (const event of parsed.events) dispatchRef.current(event);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);

  const dispatch = (event: InputEvent): void => {
    if (event.type === "mouse") return handleMouse(event);
    if (event.type === "text") {
      // Always edit the draft in chat, even while the slash menu is open —
      // the menu filters on the draft, so blocking input here is what made
      // typing "/hel" print nothing and never update the list.
      if (mode === "chat") editDraft(event);
      else if (mode === "add") handleAddText(event.text);
      // In a picker, typing filters the list — the same behaviour everywhere.
      else if (mode === "model") {
        setModelQuery((q) => q + event.text);
        setModelCursor(0);
      } else if (mode === "menu") {
        setProviderQuery((q) => q + event.text);
        setMenuIndex(0);
      } else if (mode === "thinking") {
        setThinkingQuery((q) => q + event.text);
        setThinkingCursor(0);
      }
      // In any other mode a bare character is a command key (a/d/k/j in a
      // menu), not text to type — routing it here is what made the vim keys
      // and the add/remove letters dead in every menu.
      else for (const ch of event.text) handleKey(ch);
      return;
    }
    handleKey(event.key);
  };
  dispatchRef.current = dispatch;

  const handleMouse = (event: InputEvent & { type: "mouse" }): void => {
    if (event.button !== "wheel-up" && event.button !== "wheel-down") return;
    const dir = event.button === "wheel-up" ? -1 : 1;
    // In chat the wheel scrolls the transcript; in a menu it moves the cursor
    // through the (windowed, possibly long) list — same direction as the keys.
    if (mode === "chat") return setScrollOffset((o) => (dir < 0 ? o + 3 : Math.max(0, o - 3)));
    if (mode === "menu") return setMenuIndex((i) => wrap(i, filteredProviders.length + 2, dir));
    if (mode === "model") return setModelCursor((c) => wrap(c, Math.max(1, filteredModels.length), dir));
    if (mode === "thinking") return setThinkingCursor((c) => wrap(c, Math.max(1, filteredThinking.length), dir));
  };

  const handleKey = (key: string): void => {
    if (key === "ctrl-c") {
      if (busy) abortRef.current?.abort();
      else onExit();
      return;
    }
    if (key === "ctrl-d") {
      onExit();
      return;
    }
    if (mode === "chat") return chatKey(key);
    if (mode === "menu") return menuKey(key);
    if (mode === "manage") return manageKey(key);
    if (mode === "model") return modelKey(key);
    if (mode === "thinking") return thinkingKey(key);
    if (mode === "usage") return usageKey(key);
    if (mode === "add") return addKeyHandler(key);
  };

  // Move the caret up/down between lines of the draft, clamping the column to
  // the target line's length.
  const moveCaretVertical = (delta: number): void => {
    const lines = draft.split("\n");
    const before = draft.slice(0, Math.min(caret, draft.length));
    const line = before.split("\n").length - 1;
    const col = before.length - before.lastIndexOf("\n") - 1;
    const target = line + delta;
    if (target < 0 || target >= lines.length) return;
    let idx = 0;
    for (let i = 0; i < target; i += 1) idx += lines[i]!.length + 1;
    setCaret(idx + Math.min(col, lines[target]!.length));
  };

  const chatKey = (key: string): void => {
    if (slashEngaged) {
      if (key === "up") return setSlashIndex((n) => wrapSlash(n, slashMatches.length, -1));
      if (key === "down") return setSlashIndex((n) => wrapSlash(n, slashMatches.length, 1));
      if (key === "escape") return setSlashDismissed(slashToken!);
      if (key === "tab") {
        const match = slashMatches[slashSel];
        if (match) {
          setDraft(`/${match.name}`);
          setCaret(match.name.length + 1);
        }
        return;
      }
      if (key === "return") {
        const match = slashMatches[slashSel];
        submit(match ? `/${match.name}` : draft);
        return;
      }
    }
    if (key === "escape") {
      if (busy) abortRef.current?.abort();
      return;
    }
    if (key === "return") return submit(draft);
    // Up/down move the caret between lines of a multi-line draft — never load
    // past prompts, which made editing impossible (the draft was replaced).
    if (key === "up" || key === "down") return moveCaretVertical(key === "up" ? -1 : 1);
    if (key === "pageup") return setScrollOffset((o) => o + 5);
    if (key === "pagedown") return setScrollOffset((o) => Math.max(0, o - 5));
    editDraft({ type: "key", key: key as never });
  };

  const menuKey = (key: string): void => {
    const providers = filteredProviders;
    // The list is the (filtered) providers plus a trailing "Add provider" entry.
    const itemCount = providers.length + 1;
    if (key === "up" || key === "k") return setMenuIndex((i) => wrap(i, itemCount, -1));
    if (key === "down" || key === "j") return setMenuIndex((i) => wrap(i, itemCount, 1));
    if (key === "escape") {
      // First escape clears the search; a second closes the menu.
      if (providerQuery) {
        setProviderQuery("");
        setMenuIndex(0);
        return;
      }
      return setMode("chat");
    }
    if (key === "backspace") {
      setProviderQuery((q) => q.slice(0, -1));
      setMenuIndex(0);
      return;
    }
    // Right arrow opens the highlighted provider's manage screen.
    if ((key === "right" || key === "l") && menuIndex < providers.length) {
      const target = providers[menuIndex];
      if (target) {
        setManageProvider(target.name);
        setManageCursor(0);
        setMode("manage");
      }
      return;
    }
    if (key === "return") {
      if (menuIndex === providers.length) {
        setOnboarding(false);
        setAdd({ kind: "kind" });
        setAddKindCursor(0);
        setAddKindQuery("");
        setMode("add");
        return;
      }
      const target = providers[menuIndex];
      if (target) {
        const next = setActiveProvider(config, target.name);
        setConfig(next);
        saveConfig(next);
        notice("info", `switched to ${target.name}`);
      }
      setProviderQuery("");
      setMode("chat");
      return;
    }
    if (key === "d") {
      const target = providers[menuIndex];
      if (target) {
        const next = removeProvider(config, target.name);
        setConfig(next);
        saveConfig(next);
        notice("info", `removed ${target.name}`);
        setMenuIndex(0);
      }
    }
  };

  // The manage screen for one provider: its details, then four actions.
  const MANAGE_ACTIONS = 4;
  const manageKey = (key: string): void => {
    const provider = namedProviders(config).find((p) => p.name === manageProvider);
    if (!provider) {
      setMode("menu");
      return;
    }
    if (key === "escape") {
      if (manageConfirm) return setManageConfirm(false);
      setMode("menu");
      return;
    }
    if (key === "up" || key === "k") {
      setManageConfirm(false);
      return setManageCursor((c) => wrap(c, MANAGE_ACTIONS, -1));
    }
    if (key === "down" || key === "j") {
      setManageConfirm(false);
      return setManageCursor((c) => wrap(c, MANAGE_ACTIONS, 1));
    }
    if (key !== "return") return;
    if (manageCursor === 0) {
      // Change model: make this provider active, then open the picker.
      const next = setActiveProvider(config, provider.name);
      setConfig(next);
      saveConfig(next);
      setModelCursor(Math.max(0, next.models.indexOf(provider.model ?? next.model)));
      setModelQuery("");
      setMode("model");
      return;
    }
    if (manageCursor === 1) return manageModels(provider.name);
    if (manageCursor === 2) {
      // Test connection: resolve this provider and verify it answers.
      notice("info", `testing ${providerLabel(provider)}…`);
      let resolved: ReturnType<typeof resolveProvider>;
      try {
        resolved = resolveProvider({ ...config, activeProvider: provider.name });
      } catch (error) {
        notice("error", `${provider.name}: ${(error as Error).message}`);
        return;
      }
      void verifyProvider(resolved).then((result) => {
        if (result.ok) notice("info", `${provider.name} works.`);
        else if (result.retriable) notice("warn", `${provider.name}: couldn't reach it (network) — ${result.message}`);
        else notice("error", `${provider.name} didn't answer: ${result.message}`);
      });
      return;
    }
    // Remove provider: the first enter arms it, the second removes.
    if (!manageConfirm) return setManageConfirm(true);
    const next = removeProvider(config, provider.name);
    setConfig(next);
    saveConfig(next);
    notice("info", `removed ${provider.name}`);
    setManageConfirm(false);
    setMode("menu");
  };

  const modelKey = (key: string): void => {
    const count = Math.max(1, filteredModels.length);
    if (key === "up" || key === "k") return setModelCursor((c) => wrap(c, count, -1));
    if (key === "down" || key === "j") return setModelCursor((c) => wrap(c, count, 1));
    if (key === "escape") {
      // First escape clears the search; a second closes the picker.
      if (modelQuery) {
        setModelQuery("");
        setModelCursor(0);
      } else setMode("chat");
      return;
    }
    if (key === "backspace") {
      setModelQuery((q) => q.slice(0, -1));
      setModelCursor(0);
      return;
    }
    if (key === "return") {
      const model = filteredModels[modelCursor];
      if (model) {
        const next = withModel(config, model);
        setConfig(next);
        saveConfig(next);
        notice("info", `model set to ${model}`);
      }
      setMode("chat");
    }
  };

  const thinkingKey = (key: string): void => {
    const count = Math.max(1, filteredThinking.length);
    if (key === "up" || key === "k") return setThinkingCursor((c) => wrap(c, count, -1));
    if (key === "down" || key === "j") return setThinkingCursor((c) => wrap(c, count, 1));
    if (key === "escape") {
      if (thinkingQuery) {
        setThinkingQuery("");
        setThinkingCursor(0);
      } else setMode("chat");
      return;
    }
    if (key === "backspace") {
      setThinkingQuery((q) => q.slice(0, -1));
      setThinkingCursor(0);
      return;
    }
    if (key === "return") {
      const effort = filteredThinking[thinkingCursor]?.effort;
      if (effort) {
        const next = withActiveReasoningEffort(config, effort);
        setConfig(next);
        saveConfig(next);
        notice("info", `reasoning effort set to ${effort}`);
      } else {
        notice("info", "reasoning effort left to the provider");
      }
      setMode("chat");
    }
  };

  const usageKey = (key: string): void => {
    if (key === "tab" || key === "right") return setUsageIndex((n) => (n + 1) % PERIODS.length);
    if (key === "left") return setUsageIndex((n) => (n - 1 + PERIODS.length) % PERIODS.length);
    if (key === "escape") return setMode("chat");
  };

  const handleAddText = (text: string): void => {
    if (add.kind === "kind") {
      setAddKindQuery((q) => q + text);
      setAddKindCursor(0);
      return;
    }
    if (add.kind === "url") {
      const next = addUrl + text;
      setAddUrl(next);
      return;
    }
    if (add.kind === "key") {
      setAddKey((k) => k + text);
      return;
    }
    if (add.kind === "models") {
      // With a model list on screen, typing filters it; with none (the manual
      // fallback), typing enters the model name.
      if (add.models.length === 0) setAddManual((m) => m + text);
      else setAdd((a) => (a.kind === "models" ? { ...a, query: a.query + text, cursor: 0 } : a));
    }
  };

  const addKeyHandler = (key: string): void => {
    if (key === "escape") {
      // In a searchable phase, the first escape clears the search; a second leaves.
      if (add.kind === "models" && add.query) return setAdd({ ...add, query: "", cursor: 0 });
      if (add.kind === "kind" && addKindQuery) {
        setAddKindQuery("");
        setAddKindCursor(0);
        return;
      }
      signInAbort.current?.abort();
      setMode(onboarding ? "chat" : "menu");
      return;
    }
    if (add.kind === "kind") {
      const count = Math.max(1, filteredKinds.length);
      if (key === "up" || key === "k") return setAddKindCursor((n) => wrap(n, count, -1));
      if (key === "down" || key === "j") return setAddKindCursor((n) => wrap(n, count, 1));
      if (key === "backspace") {
        setAddKindQuery((q) => q.slice(0, -1));
        setAddKindCursor(0);
        return;
      }
      if (key === "return") {
        const chosen = filteredKinds[addKindCursor];
        if (!chosen) return;
        setAddKindQuery("");
        if (chosen.auth.length === 1 && chosen.auth[0] === "oauth") return addSignIn(chosen);
        setAddUrl(chosen.baseUrl);
        setAdd({ kind: "url", provider: chosen });
      }
      return;
    }
    if (add.kind === "url") {
      if (key === "return") {
        const baseUrl = addUrl.trim();
        let ok = false;
        try {
          const parsed = new URL(baseUrl);
          ok = parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          ok = false;
        }
        if (!ok) return setAdd({ kind: "error", provider: add.provider, message: `"${baseUrl}" is not a valid http(s) URL` });
        setAddKey("");
        setAdd({ kind: "key", provider: add.provider, baseUrl });
      }
      if (key === "backspace") setAddUrl((u) => u.slice(0, -1));
      return;
    }
    if (add.kind === "key") {
      if (key === "return") {
        const apiKey = addKey.trim();
        if (!apiKey) return setAdd({ kind: "error", provider: add.provider, message: "an API key is required", baseUrl: add.baseUrl });
        addListModels(add.provider, buildBase(add.provider, add.baseUrl, { auth: "api-key", apiKey }));
      }
      if (key === "backspace") setAddKey((k) => k.slice(0, -1));
      return;
    }
    if (add.kind === "error") {
      if (key === "return") {
        const retry = add.provider;
        if (retry.auth.includes("oauth") && retry.oauth && retry.auth.length === 1) return addSignIn(retry);
        if (add.baseUrl) {
          setAddKey("");
          setAdd({ kind: "key", provider: retry, baseUrl: add.baseUrl });
        } else {
          setAddUrl(retry.baseUrl);
          setAdd({ kind: "url", provider: retry });
        }
      }
      return;
    }
    if (add.kind === "models") {
      if (add.models.length === 0) {
        if (key === "return") addRegister(addManual.trim() ? [addManual.trim()] : []);
        if (key === "backspace") setAddManual((m) => m.slice(0, -1));
        return;
      }
      // Navigation and selection act on the filtered list, so a search narrows
      // what the cursor can reach without reindexing the whole model set.
      const models = add.query ? add.models.filter((m) => m.toLowerCase().includes(add.query.toLowerCase())) : add.models;
      const count = Math.max(1, models.length);
      if (key === "up" || key === "k") return setAdd({ ...add, cursor: wrap(add.cursor, count, -1) });
      if (key === "down" || key === "j") return setAdd({ ...add, cursor: wrap(add.cursor, count, 1) });
      if (key === "backspace") return setAdd({ ...add, query: add.query.slice(0, -1), cursor: 0 });
      if (key === " ") {
        const model = models[add.cursor];
        if (!model) return;
        const chosen = new Set(add.chosen);
        if (chosen.has(model)) chosen.delete(model);
        else chosen.add(model);
        setAdd({ ...add, chosen });
        return;
      }
      if (key === "a") return addRegister(add.models);
      if (key === "n") return addRegister([]);
      if (key === "return") {
        const model = models[add.cursor];
        addRegister(model ? [model] : []);
      }
      return;
    }
  };

  function wrapSlash(current: number, count: number, delta: number): number {
    if (count <= 0) return 0;
    return (((current + delta) % count) + count) % count;
  }

  // ---- the face ----
  const liveQuiet = !(conversation.live.text || conversation.live.reasoning.trim() || conversation.live.tool || conversation.live.status || conversation.live.retrying);
  const face: Face = justFinished ? "happy" : busy && liveQuiet ? "startled" : stateFace({ live: conversation.live, lastEntry: conversation.entries[conversation.entries.length - 1], blocked: Boolean(conversation.blocked), busy });

  // ---- build the screen and draw it ----
  const entryRowList = useMemo(() => conversation.entries.flatMap((entry) => entryLines(entry, frameInnerWidth(screen.size.cols))), [conversation.entries, screen.size.cols]);

  const buildGrid = (): { grid: string[]; caret?: { row: number; col: number } } => {
    const cols = screen.size.cols;
    const rows = screen.size.rows;
    const innerW = frameInnerWidth(cols);
    const menuOpen = mode !== "chat";

    // The composer (or an open menu) is pinned to the bottom; the transcript
    // window fills the space above it.
    let composer: Seg[][];
    let caretPos: { row: number; col: number } | undefined;
    // Rows a menu may occupy: the frame minus both borders, the top area, the
    // disclaimer and a sliver of transcript. Long lists window to this height.
    const menuHeight = Math.max(6, rows - 2 - 3 - 1 - 3);
    if (menuOpen) {
      composer = menuRows(menuHeight);
    } else {
      const built = composerRows({ cols: innerW, draft, caret, busy });
      composer = built.rows;
      caretPos = { row: built.inputRow, col: built.inputCol };
    }
    const slashPopup = !menuOpen && slashEngaged && slashMatches.length > 0 ? slashPopupRows(slashMatches.map((c) => ({ name: c.name, description: c.description })), slashSel) : [];
    const blockedRow = conversation.blocked ? [[{ text: `the agent needs you: ${conversation.blocked.message} — reply to continue, or /clear`, color: color.warning }]] : [];

    // Human-readable header: the provider label, the model, branch, context, session.
    const headerInfo = [endpoint, provider?.model ?? config.model, branch ? `⎇ ${branch}` : undefined, context?.text, tokensToday > 0 ? `≡ ${formatTokens(tokensToday)} today` : undefined]
      .filter((p): p is string => Boolean(p))
      .join("   ");
    const top = topArea(cols, headerInfo, face);

    const disclaimer = "Actor0 is an experimental agent and may make mistakes.";
    const dPad = Math.max(0, Math.floor((frameInnerWidth(cols) - disclaimer.length) / 2));
    const disclaimerRow: Seg[] = [{ text: " ".repeat(dPad) + disclaimer, color: color.dim }];

    const chromeH = top.length + blockedRow.length + slashPopup.length + composer.length + 1;
    const transcriptV = Math.max(3, rows - 2 - chromeH);
    const live = menuOpen ? [] : liveLines(conversation.live, frame, elapsed, innerW, transcriptV, Boolean(conversation.blocked));
    const transcript = windowRows([...entryRowList, ...live], transcriptV, scrollOffset);
    while (transcript.length < transcriptV) transcript.push([{ text: " ".repeat(innerW), dim: true }]);

    // Panel menus (provider list, manage) are top-aligned modals: the top area,
    // a blank line, the panel, then blank space down to the disclaimer. The
    // flat pickers (model, thinking, add) stay anchored above the composer.
    const panelMenu = mode === "menu" || mode === "manage";
    const blankRow: Seg[] = [{ text: " ".repeat(innerW), dim: true }];
    const inner: Seg[][] = panelMenu
      ? [...top, ...blockedRow, blankRow, ...composer]
      : [...top, ...blockedRow, ...transcript, ...slashPopup, ...composer];
    const innerPainted = inner.map((r) => paint(fitWidth(r, innerW)));
    const contentH = rows - 2;
    // The disclaimer owns the last row; fill everything above it.
    while (innerPainted.length < contentH - 1) innerPainted.push(paint(blankRow));
    innerPainted.push(paint(fitWidth(disclaimerRow, innerW)));
    const grid: string[] = [topFrameBorder("actor0", version, cols)];
    for (const line of innerPainted.slice(0, contentH)) grid.push(`│ ${line} │`);
    grid.push(bottomFrameBorder(cols));

    // Caret: absolute row = 1 (top border) + the composer's input row within the
    // inner column. The composer is fixed at the bottom, so this is stable while
    // typing (the transcript length only changes on a commit or a scroll).
    if (caretPos) {
      const composerTop = top.length + blockedRow.length + transcript.length + slashPopup.length;
      const absRow = 2 + composerTop + caretPos.row;
      return { grid, caret: { row: absRow, col: 2 + caretPos.col } };
    }
    return { grid };
  };

  function menuRows(height: number): Seg[][] {
    const innerW = frameInnerWidth(screen.size.cols);
    switch (mode) {
      case "menu": {
        const providers = filteredProviders.map((p) => ({ name: p.name, label: providerLabel(p), active: p.name === config.activeProvider }));
        // The cursor may sit on the trailing "Add provider" entry.
        return panel("Providers", providerPanelRows(providers, Math.min(menuIndex, providers.length), providerQuery), innerW);
      }
      case "manage": {
        const p = namedProviders(config).find((x) => x.name === manageProvider);
        if (!p) return [];
        const auth = p.auth === "oauth" ? `Subscription${p.oauth?.plan ? ` · ${p.oauth.plan}` : ""}` : "API key";
        return panel("Manage provider", managePanelRows({ name: p.name, label: providerLabel(p), model: p.model ?? "", endpoint: p.baseUrl, auth }, manageConfirm ? 3 : manageCursor), innerW);
      }
      case "model":
        return modelPickerRows(filteredModels, Math.min(modelCursor, Math.max(0, filteredModels.length - 1)), height, modelQuery);
      case "thinking":
        return thinkingPickerRows(filteredThinking.map((o) => ({ label: o.label, effort: o.effort })), Math.min(thinkingCursor, Math.max(0, filteredThinking.length - 1)), thinkingQuery);
      case "usage": {
        const entries = readUsage();
        const period = PERIODS[usageIndex]!;
        const since = period.since(new Date()).valueOf();
        const bucket = usageSince(entries, since);
        const all = usageSince(entries, 0);
        const byModel = usageByModel(entries, since);
        return usagePanelRows(`[${period.label}]`, bucket.tokens, bucket.turns, all.tokens, all.turns, byModel);
      }
      case "add":
        return addRows(height);
      default:
        return [];
    }
  }

  function addRows(height: number): Seg[][] {
    if (add.kind === "kind") return addKindRows(onboarding, filteredKinds.map((k) => ({ id: k.id, label: k.label, auth: k.auth })), Math.min(addKindCursor, Math.max(0, filteredKinds.length - 1)), addKindQuery);
    if (add.kind === "url") return addUrlRows(add.provider.label, addUrl).rows;
    if (add.kind === "key") return addKeyRows(add.provider.label, addKey).rows;
    if (add.kind === "working") return addWorkingRows(add.label, add.note);
    if (add.kind === "error") return addErrorRows(add.message);
    if (add.kind === "models") {
      if (add.models.length === 0) return addManualRows(add.label, addManual).rows;
      const models = add.query ? add.models.filter((m) => m.toLowerCase().includes(add.query.toLowerCase())) : add.models;
      return addModelsRows(add.label, models, Math.min(add.cursor, Math.max(0, models.length - 1)), add.chosen, height, add.query);
    }
    return [];
  }

  // Draw on every state change. A full-screen grid is small; rewriting it each
  // frame is cheap and — unlike re-reconciling an Ink tree — never drops a byte.
  useEffect(() => {
    const { grid, caret } = buildGrid();
    screen.render(grid);
    if (caret && mode === "chat") screen.caret(caret.row, caret.col);
    else screen.hideCaret();
  });

  // Restore the terminal on unmount.
  useEffect(() => () => screen.dispose(), [screen]);

  return null;
}

function buildBase(provider: ProviderKind, baseUrl: string, auth: { auth: "api-key"; apiKey: string } | { auth: "oauth"; oauth: OAuthTokens }): Record<string, unknown> {
  return { baseUrl, transport: provider.transport, ...(provider.path ? { path: provider.path } : {}), ...auth };
}
