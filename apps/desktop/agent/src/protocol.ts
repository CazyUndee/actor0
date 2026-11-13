import type { HarnessEvent, Usage } from "@actor0/harness";
import type { DesktopConfig, NamedProvider } from "./config.js";

/**
 * The wire protocol between the React UI and the agent core.
 *
 * Two channels, and the split matters:
 *
 *  - **Calls** are request/response. The UI asks a question ("what sessions are
 *    there"), the agent answers, and the call's id ties the two together. Every
 *    one of them is listed in `AgentMethods`, so a method that the UI calls but
 *    the agent does not implement is a compile error rather than a silent
 *    `undefined` at runtime.
 *  - **Events** are pushes. A turn is long-lived and produces a stream, so the
 *    agent sends `turn.event` frames the moment they happen and the UI applies
 *    them in order. Nothing polls.
 *
 * The harness's own `HarnessEvent` crosses the wire unchanged. That is
 * deliberate: the UI's reducer is the same shape as the CLI's, so the streaming
 * contract (including `reset` rewinding a retried attempt) is exercised in the
 * desktop app exactly as it is in the terminal rather than being re-invented.
 */

/** What the agent answers for `agent.hello`. */
export type AgentInfo = {
  version: string;
  cwd: string;
  /** Which filesystem backend the tools are using: the shell's native API, or node:fs. */
  bridge: "neutralino" | "node";
  /** What `shell` will run, in one clause. */
  shell: string;
  platform: NodeJS.Platform;
};

/** A resolved endpoint, as the status line and the provider panel show it. */
export type ProviderInfo = {
  endpoint: string;
  model: string;
  transport: string;
  credential: string;
  credentialSource?: string;
  headers?: string[];
  reasoningEffort?: string;
};

export type ConfigSnapshot = {
  config: DesktopConfig;
  /** The endpoint in play, or undefined when the config cannot resolve one. */
  provider?: ProviderInfo;
  /** The error that stopped it resolving, when there is one. */
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

export type SessionSummaryWire = {
  id: string;
  updatedAt: string;
  model: string;
  messageCount: number;
};

export type McpStatus = { configured: number; servers: string[] };

/** A model the provider reported, for the picker. */
export type ModelInfo = { id: string; contextWindow?: number };

/** The result of a `provider.test`. */
export type ProviderTestResult = { ok: boolean; message: string };

/** A sign-in option, projected from the presets in `@actor0/providers`. */
export type ProviderKindWire = {
  /** The preset's id, which is what `provider.signIn` takes. */
  kind: string;
  label: string;
  transport: string;
  baseUrl: string;
  /** Which credentials this kind accepts: `oauth` is a browser sign-in. */
  auth: string[];
};

/** The result of a sign-in, or the URL the UI has to open itself. */
export type SignInResultWire =
  | { ok: true; opened: boolean; authorizeUrl: string; provider: NamedProvider }
  | { ok: false; message: string };

/** What a turn produced, sent when it finishes. */
export type TurnFinished = {
  turnId: string;
  ok: boolean;
  rounds: number;
  usage: Usage[];
  truncated: boolean;
  blocked: boolean;
  /** The message for a failed turn, when there is one. */
  error?: string;
};

/** The agent's call surface. Every entry is a real implementation. */
export type AgentMethods = {
  "agent.hello": (params: undefined) => Promise<AgentInfo>;
  "config.get": (params: undefined) => Promise<ConfigSnapshot>;
  "provider.activate": (params: { name: string | null }) => Promise<ConfigSnapshot>;
  "provider.add": (params: { entry: Omit<NamedProvider, "name"> & { name?: string } }) => Promise<ConfigSnapshot>;
  "provider.remove": (params: { name: string }) => Promise<ConfigSnapshot>;
  "provider.test": (params: { name?: string }) => Promise<ProviderTestResult>;
  "model.set": (params: { model: string }) => Promise<ConfigSnapshot>;
  "model.discover": (params: undefined) => Promise<ModelInfo[]>;
  "thinking.set": (params: { effort: "low" | "medium" | "high" | null }) => Promise<ConfigSnapshot>;
  /** The sign-in options this host offers, from the presets in @actor0/providers. */
  "provider.kinds": (params: undefined) => Promise<ProviderKindWire[]>;
  /** Register an OAuth provider by kind, by running the browser sign-in.
   *
   * Registers *and* stores in one step: the tokens are written to the config as
   * part of the same operation, because a sign-in that is not persisted is a
   * sign-in the user repeats on every launch.
   */
  "provider.signIn": (params: { kind: string }) => Promise<SignInResultWire>;
  "session.list": (params: undefined) => Promise<SessionSummaryWire[]>;
  "session.load": (params: { id: string }) => Promise<{ messages: unknown[]; model: string }>;
  "session.new": (params: undefined) => Promise<{ ok: true }>;
  /** The current transcript, so a UI that (re)connects can rebuild its view. */
  "conversation.get": (params: undefined) => Promise<{ sessionId: string; messages: unknown[] }>;
  "usage.get": (params: { period: "day" | "week" | "month" | "all" }) => Promise<UsageSnapshot>;
  "mcp.status": (params: undefined) => Promise<McpStatus>;
  "turn.send": (params: { input: string }) => Promise<{ turnId: string }>;
  "turn.reply": (params: { input: string }) => Promise<{ turnId: string }>;
  "turn.cancel": (params: undefined) => Promise<{ cancelled: boolean }>;
};

export type AgentMethodName = keyof AgentMethods;

/** A push from the agent. */
export type AgentNotification =
  | { type: "turn.started"; turnId: string }
  | { type: "turn.event"; turnId: string; event: HarnessEvent }
  | { type: "turn.finished"; turnId: string; result: TurnFinished }
  | { type: "notice"; tone: "info" | "warn" | "error"; text: string }
  /** Something the UI caches changed — config, sessions, usage. */
  | { type: "state.changed" }
  /** The agent is about to exit; the shell should stop supervising. */
  | { type: "agent.stopping" };

/** A request frame, as it arrives on the socket. */
export type WireRequest = {
  id: string;
  method: string;
  params?: unknown;
};

/** A response frame. Exactly one of `result` / `error` is set. */
export type WireResponse = {
  id: string;
  result?: unknown;
  error?: { message: string };
};

/** An event frame, as it goes out on the socket. */
export type WireNotification = { event: AgentNotification };

export function isWireRequest(value: unknown): value is WireRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WireRequest).id === "string" &&
    typeof (value as WireRequest).method === "string"
  );
}
