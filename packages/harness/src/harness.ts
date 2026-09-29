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
  /**
   * Whether one continuation is attempted when the endpoint cuts an answer
   * off at its output cap. Once, not repeatedly: a model that is too long
   * for the cap is too long for it twice, and the second attempt costs a
   * full request to learn the same thing.
   */
  recoverTruncatedAnswer: boolean;
};

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  maxRetries: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 8_000,
  idleTimeoutMs: 60_000,
  maxToolRounds: Number.POSITIVE_INFINITY,
  maxConsecutiveToolErrors: 5,
  recoverEmptyAnswer: true,
  recoverTruncatedAnswer: true,
};

/** Marker appended to an answer a cancel cut short. */
export const INTERRUPT_MARKER = "[interrupted]";

/**
 * `text` with the interrupt marker appended, or the marker alone when the
 * cancel landed before anything streamed. The marker is what tells a resumed
 * session that the text above it is a fragment the user stopped, not a
 * completed answer the model should stand behind.
 */
export function withInterruptMarker(text: string): string {
  const trimmedEnd = text.trimEnd();
  return trimmedEnd ? `${trimmedEnd}\n\n${INTERRUPT_MARKER}` : INTERRUPT_MARKER;
}

/**
 * Thrown when the caller aborted a turn. Carries the transcript as the turn
 * left it — the input, every finished round, answers for calls the cancel cut
 * short, and the partial answer marked interrupted — so a host can persist an
 * exchange the user watched happen. Without it, a cancel rewinds the
 * conversation to before the turn: the work vanishes from the saved session
 * and a resume replays it from zero.
 *
 * The transcript is API-valid by construction (see `abortTurn`), so a host can
 * save it as-is and the next request will be accepted.
 */
export class AbortedTurnError extends Error {
  constructor(
    readonly messages: ChatMessage[],
    /** What the cancelled attempt had streamed, without the marker. */
    readonly partialText: string,
  ) {
    super("The operation was aborted");
    this.name = "AbortedTurnError";
  }
}

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
      const delayMs = retryDelay(attempt, config, lastError);
      if (delayMs > 0) {
        const note = isServerDirected(lastError) ? "Rate limited — " : "";
        await emit(observer, { type: "status", status: `${note}retrying in ${waitLabel(delayMs)}…`, source: "note" });
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
  let truncationReason: string | undefined;
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
    // The attempt boundary, told to the observer before anything streams: a
    // host that keeps render state can snapshot here and discard exactly what
    // this attempt produced if the attempt dies and is retried. Without it, a
    // `reset` cannot say how far to rewind — text is named by `attemptText`,
    // but reasoning flushed on a tool_call or plan, statuses, and usage
    // summaries all streamed before the failure too.
    await emit(observer, { type: "attempt_start" });
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
        if (event.truncated && truncationReason === undefined) truncationReason = event.reason ?? "length";
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
    // A cut-off answer is not a finished one, whatever the transport said
    // about ending the stream. `[DONE]` describes the connection;
    // `finish_reason` describes the answer, and only the second one is about
    // whether the model got to the end of what it was writing.
    const truncated = truncationReason !== undefined;
    if (!sawDone && attemptText.trim()) {
      await emit(observer, { type: "partial", text: attemptText });
    }
    return {
      text: attemptText,
      toolCalls,
      rejectedBlocks,
      complete: sawDone && !truncated,
      truncated,
      truncationReason,
      reasoning,
      usage,
    };
  } catch (error) {
    if (outerSignal.aborted) {
      // The attempt's streamed text dies here — the round loop above cannot
      // see it — so it rides on the error to `abortTurn`, which puts it in the
      // transcript the caller persists. Without this, the text the user
      // watched stream would be the one thing the saved session loses.
      (error as { attemptText?: string }).attemptText = attemptText;
      throw error;
    }
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
  let recoveredTruncation = false;
  let finalReasoning: ReasoningSummary = { title: "", summary: "" };

  // Unbounded by default: the only reason to stop a turn is a sustained run of
  // failures, which stops to *ask* rather than to give up.
  let consecutiveToolErrors = 0;
  for (let round = 1; ; round++) {
    let roundText = "";
    if (options.signal.aborted) abortTurn(messages, "", []);
    let result: RoundResult;
    try {
      result = await runModelRound(
        options.model,
        messages,
        tools,
        options.signal,
        options.observer,
        config
      );
    } catch (error) {
      // An abort can surface from anywhere inside the round — the pre-flight
      // check, the backoff sleep, the stream itself. It still has to leave
      // through `abortTurn`, or the caller loses the transcript below.
      if (options.signal.aborted) abortTurn(messages, attemptTextOf(error), []);
      throw error;
    }
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
        await stopForUser(
          options.observer,
          messages,
          "round_limit",
          `stopped after ${config.maxToolRounds} tool rounds`
        );
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
      for (let index = 0; index < result.toolCalls.length; index += 1) {
        const call = result.toolCalls[index]!;
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
          if (options.signal.aborted) {
            // This call's answer is unknown and the rest never started; say
            // so, or the saved transcript dangles and the resume is rejected.
            abortTurn(messages, "", [call, ...result.toolCalls.slice(index + 1)]);
          }
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
        await stopForUser(
          options.observer,
          messages,
          "tool_errors",
          `${consecutiveToolErrors} rounds of tool calls failed in a row`
        );
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
        await stopForUser(
          options.observer,
          messages,
          "round_limit",
          `stopped after ${config.maxToolRounds} tool rounds`
        );
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

    // The endpoint stopped writing mid-sentence. This is the one condition
    // that is not the model's mistake and not a tool's: the answer exists,
    // it just did not fit. Ask for the rest of it, with what was written
    // already in front of the model so it continues rather than restarts.
    // Once only, and only for an answer that was actually cut — a model that
    // is too long for the cap is too long for it twice.
    if (result.truncated && config.recoverTruncatedAnswer && !recoveredTruncation && result.text.trim()) {
      recoveredTruncation = true;
      messages.push({ role: "assistant", content: result.text });
      await emit(options.observer, {
        type: "status",
        status: "Answer cut off at the model\u2019s output limit \u2014 continuing\u2026",
        source: "note",
      });
      messages.push({
        role: "user",
        content:
          options.policy?.truncationContinuationMessage ??
          "(Your previous reply was cut off at the output limit. Continue it from exactly where it stopped. Do not repeat any text you have already written and do not start over.)",
      });
      continue;
    }

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

    await emit(options.observer, {
      type: "done",
      text: result.text,
      complete: result.complete,
      ...(result.truncated ? { truncated: true, reason: result.truncationReason } : {}),
    });
    messages.push({ role: "assistant", content: result.text });
    return {
      messages,
      text: result.text,
      complete: result.complete,
      rounds: round,
      usage: allUsage,
      reasoning: finalReasoning,
      // Only the round that ends the turn decides this: an earlier truncated
      // round that the continuation finished is not a truncated turn.
      ...(result.truncated ? { truncated: true, truncationReason: result.truncationReason } : {}),
    };
  }

  throw new Error("unreachable: the tool-round loop always returns");
}

/**
 * Stop the turn and say so — to the user, and to the model.
 *
 * A stop is the one moment the host speaks to the user and the model hears
 * nothing. The UI says “stopped: tool calls kept failing — check the paths and try again”,
 * the user answers that question, and the answer arrives as an ordinary user
 * message with no question anywhere before it. Measured: after a five-round
 * tool-failure stop the transcript ended on a tool result and said nothing
 * about stopping, so the next turn opened with a reply to a prompt the model
 * had never seen.
 *
 * The last sentence of the note is the load-bearing one. It is the problem
 * Claude Code writes into the system prompt for its companion sprite — a second
 * speaker sharing the channel — and the fix is the same: tell the model what the
 * other party knows instead of leaving it to infer that from the shape of the
 * reply. It deliberately does not claim the user's next message is about the
 * stop, because it may not be.
 */
function stopNote(reason: "tool_errors" | "round_limit", message: string): string {
  const cause =
    reason === "round_limit"
      ? `This turn stopped at its tool-round budget (${message}).`
      : `This turn stopped because ${message}.`;
  return (
    `(${cause} The user has been told and asked how to proceed. They have not ` +
    `seen a message from you about the stop, so do not assume they know why.)`
  );
}

async function stopForUser(
  observer: HarnessObserver | undefined,
  messages: ChatMessage[],
  reason: "tool_errors" | "round_limit",
  message: string
): Promise<void> {
  await emit(observer, { type: "needs_user", reason, message });
  messages.push({ role: "user", content: stopNote(reason, message) });
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

/** Did the server tell us when to come back? */
function isServerDirected(error: unknown): boolean {
  return error instanceof ModelTransportError && error.retryAfterMs !== undefined;
}

/** The wait a rate limit asked for, if the error came from one. */
function retryAfterOf(error: unknown): number | undefined {
  return error instanceof ModelTransportError ? error.retryAfterMs : undefined;
}

/**
 * A duration as it should be read.
 *
 * Rounding a sub-second wait to "0s" tells the user nothing is happening,
 * which is the one thing they are watching for when the turn goes quiet.
 */
function waitLabel(delayMs: number): string {
  return delayMs >= 1_000 ? `${Math.round(delayMs / 1_000)}s` : `${Math.round(delayMs)}ms`;
}

/**
 * Jitter added to every wait, as a fraction of the delay itself.
 *
 * Without it, every client that hit a rate limit in the same second comes back
 * in the same second, and the limit that just rejected them rejects them
 * again. It is added and never subtracted: a wait shorter than the backoff it
 * is jittering is not a backoff.
 */
export const RETRY_JITTER_RATIO = 0.25;

/**
 * How long to wait before the next attempt.
 *
 * Two inputs, and the second can only make the wait longer:
 *
 *  - exponential backoff, capped, which is what a dropped connection or a
 *    5xx wants;
 *  - `Retry-After`, which is the server stating a rate limit window. A 429
 *    that says "come back in 30" and is retried after one, two and four
 *    seconds has honoured nothing: every attempt lands inside the window and
 *    the turn fails having spent seven seconds confirming what it was told.
 *
 * A wait beyond `MAX_HONOURED_RETRY_AFTER_MS` never reaches here — the
 * transport has already made that failure non-retriable rather than have the
 * turn vanish for a number of minutes a user is waiting on.
 *
 * Exported so the arithmetic can be tested without sleeping through it.
 */
export function retryDelay(attempt: number, config: HarnessConfig, error?: unknown): number {
  const backoff = Math.min(config.initialBackoffMs * 2 ** (attempt - 1), config.maxBackoffMs);
  const base = Math.max(backoff, retryAfterOf(error) ?? 0);
  return Math.round(base + Math.random() * RETRY_JITTER_RATIO * base);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The streamed text an aborted attempt carried out on its error, if any. */
function attemptTextOf(error: unknown): string {
  const text = (error as { attemptText?: string } | null | undefined)?.attemptText;
  return typeof text === "string" ? text : "";
}

/**
 * Leave a cancelled turn the way the user watched it, not the way the code
 * unwound.
 *
 * Every call in `calls` gets an answer: a result unknown. That covers both
 * the call a cancel cut short and the ones that never started — "result
 * unknown" is the honest answer to "did it finish?", and an invented result
 * (an empty string, the failure text) would teach the model something false
 * about the machine. On the next round the model can re-run what it needs.
 *
 * `partialText` is appended as the final assistant message with an interrupt
 * marker, so a resume reads the cut text as a fragment the user stopped
 * rather than a completed answer. Claude Code leaves the same shape behind —
 * a partial assistant message and "[Request interrupted by user]" — with the
 * marker as its own pseudo-message; here it rides on the message, because
 * `ChatMessage` has no place for a separate notice and one shape keeps every
 * consumer uniform. Pass an empty string when the streamed text is already in
 * the transcript (on the tool-call assistant message), so it is not stored
 * twice.
 *
 * The result is API-valid by construction: no dangling call, no unanswered
 * `tool_calls` — the shapes a provider rejects the whole request over.
 */
function abortTurn(messages: ChatMessage[], partialText: string, unanswered: ToolCall[]): never {
  const transcript = [...messages];
  for (const call of unanswered) {
    transcript.push({ role: "assistant", content: "", tool_calls: [call] });
    transcript.push({
      role: "tool",
      content:
        "[cancelled] The turn was interrupted around this call, so its result is unknown. Run it again if you still need it.",
      tool_call_id: call.id,
      name: call.function.name,
    });
  }
  transcript.push({ role: "assistant", content: withInterruptMarker(partialText) });
  throw new AbortedTurnError(transcript, partialText);
}
