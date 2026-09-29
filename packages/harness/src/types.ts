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
  | {
      type: "done";
      /**
       * The endpoint stopped mid-answer — the output-token cap, or the
       * model's own window, ran out. The text so far is the beginning of
       * an answer, not one, and a caller that cannot tell the difference
       * will save a fragment and call it a reply.
       */
      truncated?: boolean;
      /** The endpoint's own word for it, kept for a message that must name a cause. */
      reason?: string;
    };

/**
 * A protocol block the answer filter refused. `call` is the synthetic call
 * that carries the error tool result into the transcript (the harness authors
 * the result itself; no tool host runs), and `reason` is the sentence both
 * the model and the UI see.
 */
export type RejectedToolBlock = {
  /** The name the model asked for — "unknown" when it emitted none. */
  name: string;
  call: ToolCall;
  reason: string;
};

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
  /**
   * A model attempt is about to stream. Everything a host renders from the
   * events that follow belongs to this attempt; a host that snapshots its
   * render state here can discard exactly this attempt's output when the
   * matching `reset` arrives.
   */
  | { type: "attempt_start" }
  | { type: "reset"; attemptText: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; output: string; error?: string }
  | { type: "tool_call"; tool_calls: ToolCall[] }
  /**
   * A tool-call block was refused (unoffered tool, or arguments that were not
   * valid JSON). Nothing reaches the answer text; the UI shows a cross and
   * the model receives the error result next round.
   */
  | { type: "tool_rejected"; rejection: RejectedToolBlock }
  | { type: "provider"; name: string }
  | { type: "usage"; usage: Usage }
  | { type: "partial"; text: string }
  | {
    type: "done";
    text: string;
    complete: boolean;
    /** The endpoint cut this answer off at its output cap. `complete` is then false. */
    truncated?: boolean;
    /** The endpoint's finish/stop reason, when it named one. */
    reason?: string;
  }
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
  /** Protocol blocks refused this round — see RejectedToolBlock. */
  rejectedBlocks: RejectedToolBlock[];
  complete: boolean;
  /** The endpoint stopped this round's answer short — see the `done` event. */
  truncated: boolean;
  /** The endpoint's finish/stop reason, when it named one. */
  truncationReason?: string;
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
  /** Prompt used for the one permitted continuation of a cut-off answer. */
  truncationContinuationMessage?: string;
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
  /**
   * The turn ended with the model's answer cut off by the output cap, and
   * the one permitted continuation did not finish it either. The text is
   * real and is returned, but the host has to say it is unfinished.
   */
  truncated?: boolean;
  /** The endpoint's finish/stop reason, when it named one. */
  truncationReason?: string;
};

export const emptyUsage = (): Usage => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});
