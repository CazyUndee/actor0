export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
};

export type ModelEvent =
  | { type: "token"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; tool_calls: ToolCall[] }
  | { type: "usage"; usage: Usage }
  | { type: "status"; note: string }
  | { type: "provider"; name: string }
  | { type: "done" };

export type PlanPrefix = {
  title: string;
  plan: string;
  consumed: number;
};

export type ReasoningSummary = {
  title: string;
  summary: string;
};

export type HarnessEvent =
  | { type: "token"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "status"; status: string; source: "marker" | "note" }
  | { type: "plan"; plan: PlanPrefix }
  | { type: "reset"; attemptText: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; output: string; error?: string }
  | { type: "tool_call"; tool_calls: ToolCall[] }
  | { type: "provider"; name: string }
  | { type: "usage"; usage: Usage }
  | { type: "partial"; text: string }
  | { type: "done"; text: string; complete: boolean }
  /**
   * The turn stopped because it could not make progress on its own. The
   * harness does not decide to give up here — it reports the condition and the
   * host decides, typically by asking the user whether to keep going.
   */
  | { type: "needs_user"; reason: "tool_errors" | "round_limit"; message: string }
  | { type: "error"; message: string; retriable: boolean };

export type ModelClient = {
  stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal
  ): AsyncIterable<ModelEvent>;
};

export type ToolHost = {
  definitions(): ToolDefinition[];
  execute(call: ToolCall, signal: AbortSignal): Promise<string>;
};

export type HarnessObserver = {
  event?(event: HarnessEvent): void | Promise<void>;
};

export type RoundResult = {
  text: string;
  toolCalls: ToolCall[];
  complete: boolean;
  reasoning: ReasoningSummary;
  usage: Usage[];
};

export type ToolRoundPolicy = {
  /** Return true when the completed tool round is already the final answer. */
  shouldStopAfterTools?(input: {
    calls: ToolCall[];
    text: string;
    round: number;
  }): boolean;
  /** Prompt used for the one permitted empty-answer continuation. */
  emptyContinuationMessage?: string;
};

export type RunResult = {
  messages: ChatMessage[];
  text: string;
  complete: boolean;
  rounds: number;
  usage: Usage[];
  reasoning: ReasoningSummary;
  /** True when the turn stopped on `needs_user` and can be resumed. */
  blocked?: boolean;
};

export const emptyUsage = (): Usage => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});
