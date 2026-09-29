import { createAnswerFilter } from "./answer-filter.js";
import type { RejectedBlock } from "./tool-call-block.js";
import { ModelTransportError } from "./model-client.js";
import { formatReasoningSummary } from "./reasoning-summary.js";
import type {
  ChatMessage,
  HarnessObserver,
  ModelClient,
  ModelEvent,
  ReasoningSummary,
  RoundResult,
  RunResult,
  ToolCall,
  ToolHost,
  ToolRoundPolicy,
  Usage,
} from "./types.js";

export type HarnessConfig = {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  idleTimeoutMs: number;
  /**
   * Hard cap on tool rounds. Defaults to unbounded — a turn that needs to
   * research for hours should be allowed to. A caller that pays per round
   * should set it: reaching it ends the turn with `needs_user` and everything
   * the rounds already produced, never a thrown error.
   */
  maxToolRounds: number;
  /**
   * Consecutive rounds in which *every* tool call failed. Reaching this stops
   * the turn and reports `needs_user` rather than throwing, so the caller can
   * ask whether to continue. A single bad call is normal and never counts.
   */
  maxConsecutiveToolErrors: number;
  recoverEmptyAnswer: boolean;
};

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  maxRetries: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 8_000,
  idleTimeoutMs: 60_000,
  maxToolRounds: Number.POSITIVE_INFINITY,
  maxConsecutiveToolErrors: 5,
  recoverEmptyAnswer: true,
};

export async function runModelRound(
  model: ModelClient,
  messages: ChatMessage[],
  tools: Parameters<ModelClient["stream"]>[1],
  signal: AbortSignal,
  observer?: HarnessObserver,
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG
): Promise<RoundResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    assertNotAborted(signal);
    if (attempt > 0) {
      const delayMs = Math.min(
        config.initialBackoffMs * 2 ** (attempt - 1),
        config.maxBackoffMs
      );
      if (delayMs > 0) {
        await emit(observer, { type: "status", status: `Retrying in ${delayMs / 1_000}s…`, source: "note" });
        await sleep(delayMs, signal);
      }
    }

    try {
      return await runModelAttempt(model, messages, tools, signal, observer, config);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (!isRetriable(error) || attempt === config.maxRetries) throw error;
    }
  }

  throw lastError ?? new ModelTransportError("model request failed after retries", true);
}

async function runModelAttempt(
  model: ModelClient,
  messages: ChatMessage[],
  tools: Parameters<ModelClient["stream"]>[1],
  outerSignal: AbortSignal,
  observer: HarnessObserver | undefined,
  config: HarnessConfig
): Promise<RoundResult> {
  const controller = new AbortController();
  const abortOuter = () => controller.abort(outerSignal.reason);
  outerSignal.addEventListener("abort", abortOuter, { once: true });
  if (outerSignal.aborted) controller.abort(outerSignal.reason);

  // The filter also runs the tool-call protocol: a fenced ```json block
  // naming one of the request's tools becomes a real call instead of text.
  const filter = createAnswerFilter(tools.map((tool) => tool.function.name));
  let attemptText = "";
  let reasoningText = "";
  const toolCalls: ToolCall[] = [];
  const rejectedBlocks: RejectedBlock[] = [];
  const usage: Usage[] = [];
  let sawDone = false;
  let iterator: AsyncIterator<ModelEvent> | undefined;

  const emitFiltered = async (delta: string) => {
    const filtered = filter.push(delta);
    for (const status of filtered.statuses) {
      await emit(observer, { type: "status", status, source: "marker" });
    }
    if (filtered.plan) await emit(observer, { type: "plan", plan: filtered.plan });
    for (const rejection of filtered.rejected) {
      rejectedBlocks.push(rejection);
      await emit(observer, { type: "tool_rejected", rejection });
    }
    for (const call of filtered.toolCalls) {
      toolCalls.push(call);
      await emit(observer, { type: "tool_call", tool_calls: [call] });
    }
    if (filtered.text) {
      attemptText += filtered.text;
      await emit(observer, { type: "token", delta: filtered.text });
    }
  };

  try {
    iterator = model.stream(messages, tools, controller.signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await withTimeout(
        iterator.next(),
        config.idleTimeoutMs,
        controller,
        `${config.idleTimeoutMs / 1_000}s idle timeout`
      );
      if (next.done) break;
      const event = next.value;
      if (event.type === "token") {
        await emitFiltered(event.delta);
      } else if (event.type === "reasoning") {
        reasoningText = `${reasoningText}${event.delta}`.slice(-4_000);
        await emit(observer, { type: "reasoning", delta: event.delta });
      } else if (event.type === "tool_call") {
        toolCalls.push(...event.tool_calls);
        await emit(observer, { type: "tool_call", tool_calls: event.tool_calls });
      } else if (event.type === "usage") {
        usage.push(event.usage);
        await emit(observer, { type: "usage", usage: event.usage });
      } else if (event.type === "status") {
        await emit(observer, { type: "status", status: event.note, source: "note" });
      } else if (event.type === "provider") {
        await emit(observer, { type: "provider", name: event.name });
      } else if (event.type === "done") {
        sawDone = true;
      }
    }

    const tail = filter.flush();
    for (const status of tail.statuses) await emit(observer, { type: "status", status, source: "marker" });
    if (tail.plan) await emit(observer, { type: "plan", plan: tail.plan });
    for (const rejection of tail.rejected) {
      rejectedBlocks.push(rejection);
      await emit(observer, { type: "tool_rejected", rejection });
    }
    for (const call of tail.toolCalls) {
      toolCalls.push(call);
      await emit(observer, { type: "tool_call", tool_calls: [call] });
    }
    if (tail.text) {
      attemptText += tail.text;
      await emit(observer, { type: "token", delta: tail.text });
    }

    const reasoning = formatReasoningSummary(reasoningText);
    if (!sawDone && attemptText.trim()) {
      await emit(observer, { type: "partial", text: attemptText });
    }
    return { text: attemptText, toolCalls, rejectedBlocks, complete: sawDone, reasoning, usage };
  } catch (error) {
    if (outerSignal.aborted) throw error;
    if (attemptText && isRetriable(error)) await emit(observer, { type: "reset", attemptText });
    if (isRetriable(error)) throw error;
    if (error instanceof ModelTransportError) throw error;
    throw new ModelTransportError(errorMessage(error), false);
  } finally {
    outerSignal.removeEventListener("abort", abortOuter);
    if (iterator?.return) await iterator.return();
  }
}

export async function runAgentTurn(options: {
  model: ModelClient;
  messages: ChatMessage[];
  input: string;
  toolHost?: ToolHost;
  signal: AbortSignal;
  observer?: HarnessObserver;
  config?: HarnessConfig;
  policy?: ToolRoundPolicy;
}): Promise<RunResult> {
  const config = options.config ?? DEFAULT_HARNESS_CONFIG;
  const messages = [...options.messages, { role: "user" as const, content: options.input }];
  const tools = options.toolHost?.definitions() ?? [];
  const allUsage: Usage[] = [];
  let recoveredEmpty = false;
  let finalReasoning: ReasoningSummary = { title: "", summary: "" };

  // Unbounded by default: the only reason to stop a turn is a sustained run of
  // failures, which stops to *ask* rather than to give up.
  let consecutiveToolErrors = 0;
  for (let round = 1; ; round++) {
    let roundText = "";
    assertNotAborted(options.signal);
    const result = await runModelRound(
      options.model,
      messages,
      tools,
      options.signal,
      options.observer,
      config
    );
    roundText = result.text;
    allUsage.push(...result.usage);
    finalReasoning = result.reasoning;

    // A refused protocol block still gets answered. The synthetic call plus
    // the error tool result go into the transcript ahead of any real calls,
    // so the next round opens with the model being told its block was wrong
    // and why — the same way a failing tool is reported — instead of learning
    // nothing and re-emitting the same block (or worse, the user reading the
    // raw JSON). No tool host runs for these; the result is authored here.
    for (const rejection of result.rejectedBlocks) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [rejection.call],
      });
      messages.push({
        role: "tool",
        content: rejection.reason,
        tool_call_id: rejection.call.id,
        name: rejection.call.function.name,
      });
    }

    // A round that only refused a block continues: its answer is the error
    // tool result the harness authored, so the loop runs another round with
    // that result in front of the model. Treating it as complete here would
    // strand the rejection — the model never gets to react. The round budget
    // still applies: stop and report rather than loop on a model that keeps
    // re-emitting the same refused block.
    if (result.toolCalls.length === 0 && result.rejectedBlocks.length > 0) {
      if (Number.isFinite(config.maxToolRounds) && round >= config.maxToolRounds) {
        await emit(options.observer, {
          type: "needs_user",
          reason: "round_limit",
          message: `stopped after ${config.maxToolRounds} tool rounds`,
        });
        return {
          messages,
          text: result.text,
          complete: result.complete,
          rounds: round,
          usage: allUsage,
          reasoning: finalReasoning,
          blocked: true,
        };
      }
      continue;
    }

    if (result.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: result.text,
        tool_calls: result.toolCalls,
      });
      let failedThisRound = 0;
      for (const call of result.toolCalls) {
        await emit(options.observer, { type: "tool_start", call });
        try {
          const output = await options.toolHost?.execute(call, options.signal);
          if (output === undefined) throw new Error("tool host returned no result");
          messages.push({
            role: "tool",
            content: output,
            tool_call_id: call.id,
            name: call.function.name,
          });
          await emit(options.observer, { type: "tool_result", call, output });
        } catch (error) {
          failedThisRound += 1;
          const output = `Tool failed: ${errorMessage(error)}`;
          messages.push({
            role: "tool",
            content: output,
            tool_call_id: call.id,
            name: call.function.name,
          });
          await emit(options.observer, { type: "tool_result", call, output, error: output });
        }
      }
      // Only a round where *everything* failed counts. One flaky tool in a
      // round of four is not a reason to interrupt a long research turn.
      consecutiveToolErrors = failedThisRound === result.toolCalls.length
        ? consecutiveToolErrors + 1
        : 0;
      if (consecutiveToolErrors >= config.maxConsecutiveToolErrors) {
        await emit(options.observer, {
          type: "needs_user",
          reason: "tool_errors",
          message: `${consecutiveToolErrors} rounds of tool calls failed in a row`,
        });
        return {
          messages,
          text: result.text,
          complete: result.complete,
          rounds: round,
          usage: allUsage,
          reasoning: finalReasoning,
          blocked: true,
        };
      }
      if (options.policy?.shouldStopAfterTools?.({ calls: result.toolCalls, text: roundText, round })) {
        return {
          messages,
          text: result.text,
          complete: result.complete,
          rounds: round,
          usage: allUsage,
          reasoning: finalReasoning,
        };
      }
      // The round budget is a *stop*, not a failure. Throwing here threw away
      // a turn that had already produced files and findings because the model
      // kept going — which is the case the budget exists for. Stop the way the
      // error streak stops: report it, keep what was done, let the host say so
      // in its own words.
      if (Number.isFinite(config.maxToolRounds) && round >= config.maxToolRounds) {
        await emit(options.observer, {
          type: "needs_user",
          reason: "round_limit",
          message: `stopped after ${config.maxToolRounds} tool rounds`,
        });
        return {
          messages,
          text: result.text,
          complete: result.complete,
          rounds: round,
          usage: allUsage,
          reasoning: finalReasoning,
          blocked: true,
        };
      }
      continue;
    }

    // A round that produced an answer is a healthy round — clear the streak.
    consecutiveToolErrors = 0;

    // A round that only refused a block is not an empty round: the model said
    // something (the harness answered it with the error result above), and
    // stacking "your previous reply was empty" on top of that rejection
    // teaches the model two contradictory things at once.
    if (!result.text.trim() && result.rejectedBlocks.length === 0 && config.recoverEmptyAnswer && !recoveredEmpty) {
      recoveredEmpty = true;
      await emit(options.observer, {
        type: "status",
        status: "Empty response — trying again…",
        source: "note",
      });
      messages.push({
        role: "user",
        content:
          options.policy?.emptyContinuationMessage ??
          "(Your previous reply was empty. Please respond now to the user's last message.)",
      });
      continue;
    }

    await emit(options.observer, { type: "done", text: result.text, complete: result.complete });
    messages.push({ role: "assistant", content: result.text });
    return {
      messages,
      text: result.text,
      complete: result.complete,
      rounds: round,
      usage: allUsage,
      reasoning: finalReasoning,
    };
  }

  throw new Error("unreachable: the tool-round loop always returns");
}

async function emit(
  observer: HarnessObserver | undefined,
  event: Parameters<NonNullable<HarnessObserver["event"]>>[0]
): Promise<void> {
  await observer?.event?.(event);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ModelTransportError(message, true));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function isRetriable(error: unknown): boolean {
  return error instanceof ModelTransportError && error.retriable;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
