import {
  AbortedTurnError,
  DEFAULT_HARNESS_CONFIG,
  FailedTurnError,
  contextWindowTokens,
  isContextOverflowError,
  runAgentTurn,
  type ChatMessage,
  type HarnessEvent,
  type ModelClient,
  type RunResult,
  type ToolHost,
  type Usage,
} from "@actor0/harness";
import { createModel, type ResolvedProvider } from "@actor0/providers";
import { compactHistory } from "./history.js";
import type { TaskDelegate, TaskRequest, TaskResult } from "./tools/context.js";

/**
 * One turn, from a host's point of view.
 *
 * Everything about *how* a turn runs lives in the harness; this module is the
 * host's half — which model client, which tools, what to do when the request did
 * not fit, and how to leave a cancelled or failed turn in a state the next
 * request will accept.
 *
 * Two decisions are deliberately here rather than in the harness:
 *
 *  - **Overflow recovery.** A provider that refuses the conversation because it
 *    is too large is a size problem, not a failure, and retrying it unchanged
 *    only spends the round trip again. So the payloads behind stale tool results
 *    are cleared and the request is made once more — the messages stay exactly
 *    where they were, which is what keeps the transcript API-valid.
 *  - **The transcript a cancel or a failure leaves behind.** The harness carries
 *    it out on the error object; adopting it is what stops a resume from
 *    rewinding to the question and discarding work the user watched happen.
 */

export type TurnOutcome = {
  result: RunResult;
  /** Set when the request did not fit and was asked again on a compacted history. */
  recovery?: { before: number; after: number };
};

export type RunTurnOptions = {
  model: ResolvedProvider;
  /** Injected client, for tests and for a host that owns the transport. */
  client?: ModelClient;
  messages: ChatMessage[];
  input: string;
  toolHost: ToolHost;
  signal: AbortSignal;
  cwd: string;
  onEvent: (event: HarnessEvent) => void;
  maxToolRounds?: number;
};

/** Run one turn, recovering once from a context overflow. */
export async function runTurn(options: RunTurnOptions): Promise<TurnOutcome> {
  const client = options.client ?? createModel(options.model);
  const config = {
    ...DEFAULT_HARNESS_CONFIG,
    ...(options.maxToolRounds ? { maxToolRounds: options.maxToolRounds } : {}),
  };

  const observer = { event: (event: HarnessEvent): void => options.onEvent(event) };

  const attempt = (messages: ChatMessage[]): Promise<RunResult> =>
    runAgentTurn({
      model: client,
      messages,
      input: messages === options.messages ? options.input : options.input,
      toolHost: options.toolHost,
      signal: options.signal,
      observer,
      config,
    });

  try {
    return { result: await attempt(options.messages) };
  } catch (error) {
    if (options.signal.aborted) throw error;
    if (!isContextOverflowError(error)) throw error;

    // The conversation did not fit. Clear the payloads behind stale tool results
    // and ask once more; if the compaction changed nothing there is no point
    // retrying, and the original error is the honest answer.
    const before = measureMessages(options.messages);
    const compacted = compactHistory(options.messages, { keepRecent: 2 });
    if (measureMessages(compacted) >= before) throw error;

    options.onEvent({
      type: "status",
      status: `Conversation too large for ${options.model.model} — compacting and retrying…`,
      source: "note",
    });
    const result = await runAgentTurn({
      model: client,
      messages: compacted,
      input: options.input,
      toolHost: options.toolHost,
      signal: options.signal,
      observer,
      config,
    });
    return { result, recovery: { before, after: measureMessages(compacted) } };
  }
}

function measureMessages(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
}

/**
 * The transcript a cancelled turn left, or undefined if the error was not one.
 *
 * The harness hands it back on the error precisely so a host can persist it
 * without re-deriving anything — adopting it is what keeps work that already
 * happened in the saved session.
 */
export function cancelledTurnMessages(error: unknown): ChatMessage[] | undefined {
  return error instanceof AbortedTurnError ? error.messages : undefined;
}

/** The transcript a failed turn left, or undefined if the error was not one. */
export function failedTurnMessages(error: unknown): ChatMessage[] | undefined {
  return error instanceof FailedTurnError ? error.messages : undefined;
}

/** A short sentence for a turn that stopped and can be resumed. */
export function describeStop(reason: "tool_errors" | "round_limit"): string {
  return reason === "round_limit"
    ? "Stopped at the tool-round budget. Reply to continue."
    : "Stopped after several rounds of failing tools — check the paths and try again.";
}

/** A short sentence for an answer the endpoint cut off. */
export function describeTruncation(): string {
  return "The answer was cut off at the model's output limit.";
}

/** A short sentence for a request that had to be compacted to fit. */
export function describeRecovery(recovery: { before: number; after: number }): string {
  const saved = recovery.before - recovery.after;
  return `Conversation did not fit — ${saved.toLocaleString("en-US")} characters of stale tool output were cleared and the request was retried.`;
}

/** `5.0k tokens` or empty when nothing was reported. */
export function usageSummary(usage: Usage[]): string {
  const total = usage.reduce((sum, item) => sum + (item.total_tokens ?? 0), 0);
  if (total <= 0) return "";
  const prompt = usage.reduce((sum, item) => sum + (item.prompt_tokens ?? 0), 0);
  const completion = usage.reduce((sum, item) => sum + (item.completion_tokens ?? 0), 0);
  return `${formatTokens(total)} tokens (${formatTokens(prompt)} in, ${formatTokens(completion)} out)`;
}

/** A compact token count: 1_234 → "1.2k". */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** The context window the model reports, or undefined when it has not said. */
export function windowFor(model: string, learned: Record<string, number> | undefined): number | undefined {
  const known = learned?.[model];
  if (known && known > 0) return known;
  return contextWindowTokens(model) ?? undefined;
}

/**
 * A `TaskDelegate` that runs a subtask as a real turn.
 *
 * The sub-agent gets the same endpoint, the same tool registry and a fresh
 * transcript — it cannot see the caller's conversation, which is the point:
 * the caller's context is exactly what this keeps out of the way. Its own tool
 * host is built with a delegate that *cannot* recurse, so a sub-agent cannot
 * delegate again and fan out without bound.
 */
export function createTaskDelegate(options: {
  model: ResolvedProvider;
  cwd: string;
  toolHostFor: (delegate: TaskDelegate | undefined) => ToolHost;
  onEvent?: (event: HarnessEvent) => void;
  maxRounds?: number;
}): TaskDelegate {
  return {
    async run(request: TaskRequest, signal: AbortSignal): Promise<TaskResult> {
      const toolHost = options.toolHostFor(undefined);
      try {
        const { result } = await runTurn({
          model: options.model,
          messages: [],
          input: request.prompt,
          toolHost,
          signal,
          cwd: options.cwd,
          onEvent: (event) => options.onEvent?.(event),
          ...(options.maxRounds ? { maxToolRounds: options.maxRounds } : {}),
        });
        return {
          text: result.text,
          complete: result.complete,
          rounds: result.rounds,
          toolCallCount: result.audit.toolCallCount,
        };
      } catch (error) {
        // A sub-agent that failed is a fact for the caller, not a crash: the
        // answer is empty and says nothing was produced.
        void error;
        return { text: "", complete: false, rounds: 0, toolCallCount: 0 };
      }
    },
  };
}
