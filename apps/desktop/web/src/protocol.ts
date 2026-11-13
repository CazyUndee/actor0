import type { HarnessEvent, Usage } from "@actor0/harness";

/**
 * The UI's copy of the agent's wire types.
 *
 * Duplicated on purpose. The web bundle and the agent bundle are two programs
 * that share a protocol, not a module graph: the UI must be able to run in a
 * browser (and in a test) with no Node built-ins and no import that reaches
 * into the agent's source. A shared package would be the other answer, but it
 * would also be a package boundary whose only content is `type`s — and the
 * moment one side needs a value, the shared package becomes a dependency the
 * UI drags into the browser.
 *
 * The contract is kept honest by the agent's `AgentMethods` type: a method that
 * exists on one side and not the other is a type error there, and the smoke
 * test in `client.test.ts` asserts the method list at runtime.
 */

/** Everything the UI needs to know about the running agent. */
export type AgentInfo = {
  version: string;
  cwd: string;
  bridge: "neutralino" | "node";
  shell: string;
  platform: string;
};

/** A registered endpoint, as the provider panel lists it. */
export type NamedProvider = {
  name: string;
  baseUrl: string;
  model?: string;
  models?: string[];
  transport?: "openai" | "anthropic" | "chatgpt";
  auth?: "api-key" | "oauth";
  apiKey?: string;
  reasoningEffort?: "low" | "medium" | "high";
};

export type ProviderInfo = {
  endpoint: string;
  model: string;
  transport: string;
  credential: string;
  credentialSource?: string;
  headers?: string[];
  reasoningEffort?: string;
};

export type DesktopConfig = {
  model: string;
  models: string[];
  providers?: NamedProvider[];
  activeProvider?: string;
  contextWindows?: Record<string, number>;
  maxToolRounds?: number;
};

export type ConfigSnapshot = {
  config: DesktopConfig;
  provider?: ProviderInfo;
  providerError?: string;
  providers: NamedProvider[];
  activeProvider?: string;
  models: string[];
};

export type UsageSnapshot = {
  period: string;
  tokens: number;
  turns: number;
  byModel: { model: string; tokens: number }[];
};

export type SessionSummary = {
  id: string;
  updatedAt: string;
  model: string;
  messageCount: number;
};

export type McpStatus = { configured: number; servers: string[] };
export type ProviderTestResult = { ok: boolean; message: string };
/** A sign-in option the agent offers, projected from @actor0/providers. */
export type ProviderKind = {
  kind: string;
  label: string;
  transport: string;
  baseUrl: string;
  auth: string[];
};
/** The outcome of a sign-in, or the URL the UI has to open itself. */
export type SignInResult =
  | { ok: true; opened: boolean; authorizeUrl: string; provider: NamedProvider }
  | { ok: false; message: string };
export type ModelInfo = { id: string; contextWindow?: number };

/** What a turn produced, sent when it finishes. */
export type TurnFinished = {
  turnId: string;
  ok: boolean;
  rounds: number;
  usage: Usage[];
  truncated: boolean;
  blocked: boolean;
  error?: string;
};

/** A push from the agent. */
export type AgentNotification =
  | { type: "turn.started"; turnId: string }
  | { type: "turn.event"; turnId: string; event: HarnessEvent }
  | { type: "turn.finished"; turnId: string; result: TurnFinished }
  | { type: "notice"; tone: "info" | "warn" | "error"; text: string }
  | { type: "state.changed" }
  | { type: "agent.stopping" };

/** Every call the UI makes. Mirrors the agent's `AgentMethods`. */
export type AgentCalls = {
  "agent.hello": () => Promise<AgentInfo>;
  "config.get": () => Promise<ConfigSnapshot>;
  "provider.activate": (params: { name: string | null }) => Promise<ConfigSnapshot>;
  "provider.add": (params: { entry: Omit<NamedProvider, "name"> & { name?: string } }) => Promise<ConfigSnapshot>;
  "provider.remove": (params: { name: string }) => Promise<ConfigSnapshot>;
  "provider.test": (params: { name?: string }) => Promise<ProviderTestResult>;
  "model.set": (params: { model: string }) => Promise<ConfigSnapshot>;
  "model.discover": () => Promise<ModelInfo[]>;
  /** List the models of an endpoint being considered, before it is registered. */
  "model.discoverFor": (params: { baseUrl: string; apiKey?: string }) => Promise<ModelInfo[]>;
  "thinking.set": (params: { effort: "low" | "medium" | "high" | null }) => Promise<ConfigSnapshot>;
  "provider.kinds": () => Promise<ProviderKind[]>;
  "provider.signIn": (params: { kind: string }) => Promise<SignInResult>;
  "session.list": () => Promise<SessionSummary[]>;
  "session.load": (params: { id: string }) => Promise<{ messages: unknown[]; model: string }>;
  "session.new": () => Promise<{ ok: true }>;
  "conversation.get": () => Promise<{ sessionId: string; messages: unknown[] }>;
  "usage.get": (params: { period: "day" | "week" | "month" | "all" }) => Promise<UsageSnapshot>;
  "mcp.status": () => Promise<McpStatus>;
  "turn.send": (params: { input: string }) => Promise<{ turnId: string }>;
  "turn.reply": (params: { input: string }) => Promise<{ turnId: string }>;
  "turn.cancel": () => Promise<{ cancelled: boolean }>;
};

export type AgentCallName = keyof AgentCalls;
