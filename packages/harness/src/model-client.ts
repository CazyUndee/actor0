import type { ChatMessage, ModelClient, ModelEvent, ToolCall, ToolDefinition, Usage } from "./types.js";

export class ModelTransportError extends Error {
  /**
   * @param retryAfterMs how long the server asked us to wait, when it said.
   *   A retriable error that carries one has a floor under its next attempt:
   *   see `retryDelay` in harness.ts.
   */
  constructor(message: string, readonly retriable = false, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ModelTransportError";
  }
}

/**
 * The longest server-requested wait this harness will sit through.
 *
 * A windowed rate limit can name a reset twenty minutes out. Honouring that
 * in a terminal means the turn disappears for twenty minutes with nothing on
 * screen, which the user reads as a hang; ignoring it means the retries land
 * inside the window and the turn fails having proved nothing. So the wait is
 * honoured up to here, and past it the failure is surfaced instead, with the
 * time the limit lifts in the message the user reads.
 */
export const MAX_HONOURED_RETRY_AFTER_MS = 120_000;

/**
 * How long the server asked us to wait, in milliseconds.
 *
 * `Retry-After` is a count of seconds per RFC 9110, and an HTTP-date in the
 * dialect several providers actually send. Both are honoured; a value that is
 * neither is ignored rather than guessed at, because a misread directive is
 * worse than no directive.
 */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  // `Date.parse` is a parser for humans and it is lenient: "-5" comes back as
  // April 2001 and "12.5.6" as December 2006, both of which would be read as a
  // reset that has already passed and turn a server that said nothing usable
  // into a claim that it asked us to come back immediately. Every one of the
  // three date formats HTTP allows begins with a weekday, so that is the gate.
  if (!/^(?:mon|tue|wed|thu|fri|sat|sun)/i.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /**
   * Override the request path. Defaults to `/chat/completions` appended to
   * `baseUrl`. Gateways and application proxies routinely expose an
   * OpenAI-shaped endpoint somewhere else — `/api/chat`, a tunnel, a route
   * that also serves HTML — and forcing every one of them to sit at
   * `baseUrl + /chat/completions` would be a transport limitation leaking
   * into every host that has to work around it.
   */
  path?: string;
};

type ToolDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type StreamFrame = {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolDelta[];
  completeToolCalls?: ToolCall[];
  usage?: Usage;
  done?: boolean;
  /** The endpoint's own word for why the answer stopped, when it says. */
  finishReason?: string;
  /** An error delivered inside a 200 response, with the code and type it arrived with. */
  hasError?: boolean;
  error?: string;
  errorCode?: string;
  errorType?: string;
};

export class OpenAiCompatibleModel implements ModelClient {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: OpenAiCompatibleOptions) {
    if (!options.model.trim()) throw new Error("model is required");
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("base URL must use http or https");
    const explicitPath = options.path?.trim();
    if (explicitPath) {
      url.pathname = explicitPath.startsWith("/") ? explicitPath : `/${explicitPath}`;
    } else {
      url.pathname = url.pathname.replace(/\/+$/, "");
      if (!url.pathname.endsWith("/chat/completions")) url.pathname = `${url.pathname}/chat/completions`;
    }
    url.search = "";
    url.hash = "";
    this.endpoint = url.toString();
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = options.model.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  async *stream(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify({ model: this.model, messages, stream: true, tools }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ModelTransportError(`network request failed: ${errorMessage(error)}`, true);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const wait = retryAfterMs(response.headers);
      // A rate limit whose reset is beyond anything worth waiting out is not
      // retriable: the retries would land inside the window and only prove
      // the limit is still in force.
      const transient = response.status === 429 || response.status >= 500;
      const retriable = transient && (wait === undefined || wait <= MAX_HONOURED_RETRY_AFTER_MS);
      throw new ModelTransportError(describeHttpFailure(this.endpoint, response, text, retriable, wait), retriable, wait);
    }
    // A 200 carrying an HTML page is the same failure as a 500 carrying one,
    // and it is the worse of the two: read as a stream it has no `data:` frames,
    // so the turn produced no answer, no tool call and no error — a silent empty
    // reply. A response that *claims* to be an event stream is taken at its
    // word; anything else has its head sniffed, because that is cheap and the
    // cost of guessing wrong is an empty answer with no explanation.
    const contentType = response.headers.get("content-type");
    if (!isEventStream(contentType)) {
      const head = await response.clone().text().catch(() => "");
      if (looksLikeHtml(contentType, head)) {
        throw new ModelTransportError(
          `${this.endpoint} answered 200 with an HTML page, not an event stream. ` +
            `That is a platform-level error rather than a model failure. The harness will retry with backoff.`,
          true,
        );
      }
    }
    if (!response.body) throw new ModelTransportError("response has no body", true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls = new ToolCallBuffer();
    let buffer = "";
    let sawDone = false;
    // Frames are handed on one at a time, in order, rather than collected and
    // yielded afterwards. A single network chunk routinely carries several
    // frames, and one of them can be the last thing a stream ever sends: when
    // the frames of a chunk were buffered and only yielded once the whole
    // chunk had been handled, an error frame in that chunk threw first and
    // took every token before it with it — the model answered, the tokens
    // were already paid for, and the user was shown nothing.
    const endpoint = this.endpoint;
    let truncation: string | undefined;
    const frames = async function* (parsed: StreamFrame[]): AsyncIterable<ModelEvent> {
      for (const frame of parsed) {
        if (frame.done) {
          sawDone = true;
          continue;
        }
        // First truncation wins. Servers repeat the reason on the final
        // frame, and a later `stop` (or a second stream) must not overwrite
        // the fact that this answer was cut short.
        if (truncation === undefined && frame.finishReason !== undefined && TRUNCATION_REASONS.has(frame.finishReason)) {
          truncation = frame.finishReason;
        }
        if (frame.hasError) throw streamFrameError(endpoint, frame);
        if (frame.toolCalls) calls.push(frame.toolCalls);
        if (frame.content) yield { type: "token", delta: frame.content };
        if (frame.reasoning) yield { type: "reasoning", delta: frame.reasoning };
        if (frame.completeToolCalls) {
          for (const call of frame.completeToolCalls) yield { type: "tool_call", tool_calls: [call] };
        }
        if (frame.usage) yield { type: "usage", usage: frame.usage };
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = drainFrames(buffer);
        buffer = parsed.rest;
        yield* frames(parsed.frames);
      }
      buffer += decoder.decode();
      const parsedTail = drainFrames(buffer);
      yield* frames(parsedTail.frames);
      const completeCalls = calls.finish();
      if (completeCalls.length > 0) yield { type: "tool_call", tool_calls: completeCalls };
      // A cut-off answer still ends the stream, so it is still a `done` —
      // one that says what it is. Emitted even without a `[DONE]` frame,
      // because the reason arrived and is not going to arrive again.
      if (sawDone || truncation !== undefined) {
        yield truncation === undefined
          ? { type: "done" }
          : { type: "done", truncated: true, reason: truncation };
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

class ToolCallBuffer {
  private readonly calls = new Map<number, ToolCall>();
  push(deltas: ToolDelta[]): void {
    for (const [position, delta] of deltas.entries()) {
      const index = Number.isInteger(delta.index) ? Number(delta.index) : this.calls.size || position;
      const current = this.calls.get(index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (delta.id) current.id = delta.id;
      if (delta.type) current.type = delta.type as "function";
      if (delta.function?.name) current.function.name += delta.function.name;
      if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
      this.calls.set(index, current);
    }
  }
  finish(): ToolCall[] {
    return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([index, call], position) => ({ ...call, id: call.id || `call_${index}_${position}` }));
  }
}

/**
 * Split an SSE buffer into whole frames. Pure: nothing is thrown, nothing is
 * emitted, and the caller decides what each frame means and in what order. A
 * parser that also ran the frames had to buffer them, which is how a frame
 * that failed to be yielded ended up discarded along with the ones before it.
 */
function drainFrames(buffer: string): { frames: StreamFrame[]; rest: string } {
  const frames: StreamFrame[] = [];
  let rest = buffer;
  const handleFrame = (frame: StreamFrame) => {
    frames.push(frame);
  };
  while (true) {
    const boundary = findBoundary(rest);
    if (!boundary) break;
    const block = rest.slice(0, boundary.index);
    rest = rest.slice(boundary.index + boundary.length);
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).join("\n");
    if (!data) continue;
    if (data === "[DONE]") { handleFrame({ done: true }); continue; }
    let value: Record<string, unknown>;
    try { value = JSON.parse(data) as Record<string, unknown>; } catch { throw new ModelTransportError("endpoint returned invalid SSE JSON", true); }
    const choices = value.choices;
    const choice = Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null
      ? (choices[0] as { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown }; finish_reason?: unknown; stop_reason?: unknown })
      : undefined;
    const delta = choice?.delta;
    handleFrame({ finishReason: finishReasonOf(choice, value), content: typeof delta?.content === "string" ? delta.content : undefined, reasoning: typeof delta?.reasoning_content === "string" ? delta.reasoning_content : typeof delta?.reasoning === "string" ? delta.reasoning : undefined, toolCalls: Array.isArray(delta?.tool_calls) ? delta.tool_calls as ToolDelta[] : undefined, completeToolCalls: Array.isArray(value.tool_calls) ? value.tool_calls as ToolCall[] : undefined, usage: value.usage as Usage, ...errorFields(value) });
  }
  return { frames, rest };
}

/**
 * The endpoint's reason for stopping, in whichever of the spellings it uses.
 *
 * OpenAI-compatible servers put `finish_reason` on the choice; the
 * Anthropic-shaped streams actor0 also reads put `stop_reason` on the
 * message; relays copy either onto the top level. All three are read
 * because the one that is missing reads as "the model finished", which is
 * the exact belief this path exists to break — a stream cut off by the
 * output cap is otherwise indistinguishable from a stream that ended.
 */
function finishReasonOf(
  choice: { finish_reason?: unknown; stop_reason?: unknown } | undefined,
  value: Record<string, unknown>
): string | undefined {
  for (const candidate of [choice?.finish_reason, choice?.stop_reason, value.stop_reason, value.finish_reason]) {
    if (typeof candidate === "string" && candidate) return candidate.toLowerCase();
  }
  return undefined;
}

/**
 * Reasons that mean "this answer was cut off", not "this answer is done".
 *
 * `length` is OpenAI's spelling of the output-token cap, `max_tokens` is
 * Anthropic's, and `model_context_window_exceeded` is what the same API
 * emits when the model's own window ran out mid-generation. They differ in
 * which limit was hit and not at all in what a caller must do about it:
 * the text so far is the start of an answer, and asking again is how the
 * rest of it arrives. `content_filter` is deliberately absent — a cut made
 * by a filter is not resumed by being asked again.
 */
const TRUNCATION_REASONS: ReadonlySet<string> = new Set([
  "length",
  "max_tokens",
  "model_length",
  "model_context_window_exceeded",
]);

function findBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/**
 * True when a response is an HTML document rather than a stream or a JSON
 * error. Gateways, edge runtimes and bot checks all answer this way, and none
 * of them say so in the body: the caller has to read the shape.
 */
export function looksLikeHtml(contentType: string | null, body: string | null): boolean {
  if (contentType && /\btext\/html\b|\bapplication\/xhtml/i.test(contentType)) return true;
  // A declared type that is merely wrong must not veto the body. Gateways
  // routinely answer an error page as `text/plain`, and trusting the header
  // there is how a 200 carrying HTML turned into a silent empty answer.
  return body !== null && /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body);
}/** True when the response claims to be the event stream we asked for. */
function isEventStream(contentType: string | null): boolean {
  return contentType !== null && /\btext\/event-stream\b/i.test(contentType);
}

/**
 * The identifying fields of an in-stream error frame.
 *
 * Presence and text are separate. `{"error": "upstream reset"}` and
 * `{"error": {}}` are both errors and only the first carries a message, so
 * gating on the message is what let `{"error": {}}` through as silence: the
 * stream ended, the turn finished with no answer, no tool call and no stated
 * reason — the same silent empty reply a 200 carrying HTML produces.
 */
function errorFields(value: Record<string, unknown>): { hasError: boolean; error?: string; errorCode?: string; errorType?: string } {
  const field = value.error;
  if (field === undefined || field === null) return { hasError: false };
  if (typeof field !== "object") {
    return { hasError: true, error: typeof field === "string" && field ? field : undefined };
  }
  const record = field as Record<string, unknown>;
  const text = (key: "message" | "code" | "type"): string | undefined =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  return { hasError: true, error: text("message"), errorCode: text("code"), errorType: text("type") };
}

/**
 * Whether an error delivered *inside* a 200 response can be fixed by asking
 * again.
 *
 * A 200 means the request was accepted, so the status classification above
 * never runs — there is no status left to read. Everything then arrives in
 * one shape, `data: {"error": {...}}`: a dropped upstream connection, a rate
 * limit, a rejected key, a request that does not fit the context window.
 * Calling all of them retriable, which is what this did, replays a
 * deterministic failure three times with 1s/2s/4s of backoff, at four times the
 * token cost, and ends in exactly the same error.
 *
 * Code and type are read first because they are exact, and because they are
 * the part OpenAI, Anthropic, Gemini and OpenRouter all agree on. The message
 * is the fallback for the servers that send neither. An unrecognised error
 * stays retriable: a stream that died mid-flight is far more often a dropped
 * connection than a request the server will never accept, and guessing wrong
 * in that direction costs one wasted attempt, while guessing wrong the other
 * way refuses to start the turn at all.
 */
export function isRetriableStreamError(message: string, code?: string, type?: string): boolean {
  if (code && RETRIABLE_STREAM_CODES.test(code)) return true;
  if (code && PERMANENT_STREAM_CODES.test(code)) return false;
  if (type && RETRIABLE_STREAM_CODES.test(type)) return true;
  if (type && PERMANENT_STREAM_TYPES.test(type)) return false;
  if (isContextOverflow(message)) return false;
  if (PERMANENT_STREAM_TEXT.test(message)) return false;
  return true;
}

/**
 * Is this failure the conversation not fitting the model?
 *
 * Named because it is the one transport failure with a real recovery, and
 * recovery is not the transport layer's job: the caller has to shorten the
 * history and ask again, which is a decision about the conversation.
 */
export function isContextOverflow(message: string): boolean {
  return OVERFLOW_TEXT.test(message);
}

/**
 * Is this thrown value the model saying the request is too big?
 *
 * Asked of the error rather than of the message so a host does not have to
 * know which layer raised it, or re-derive that a retriable failure of the
 * same shape must not be compacted around. Both spellings land here: a 400
 * whose body is the diagnosis, and an error frame inside a 200.
 */
export function isContextOverflowError(error: unknown): error is ModelTransportError {
  return error instanceof ModelTransportError && !error.retriable && isContextOverflow(error.message);
}

/** The in-stream error as a failure a person can act on. */
function streamFrameError(endpoint: string, frame: StreamFrame): ModelTransportError {
  const message = frame.error ?? "";
  const retriable = isRetriableStreamError(message, frame.errorCode, frame.errorType);
  const advice = !retriable && isContextOverflow(message) ? OVERFLOW_ADVICE : undefined;
  const detail = frame.error ? `: ${frame.error}` : " and gave no message";
  return new ModelTransportError(
    `${endpoint} ended the stream with an error${detail}. ${retryAdvice(retriable, advice)}`,
    retriable,
  );
}

/**
 * Codes and types that name a transient fault. Matched loosely because
 * providers disagree on separator and wording: `rate_limit_exceeded`,
 * `rate limit`, `too_many_requests`, `overloaded_error`, `server_error`.
 */
const RETRIABLE_STREAM_CODES =
  /\b(?:rate[_\s-]?limit(?:ed)?|too[_\s-]?many[_\s-]?requests|429|server[_\s-]?error|internal[_\s-]?error|overloaded(?:[_\s-]?error)?|api[_\s-]?error|service[_\s-]?unavailable|temporarily[_\s-]?unavailable|bad[_\s-]?gateway|upstream[_\s-]?error|capacity[_\s-]?exceeded|timeout|timed[_\s-]?out|transient)\b/i;

/** Codes that name a request the server will never accept, however often it is sent. */
const PERMANENT_STREAM_CODES =
  /\b(?:context[_\s-]?length[_\s-]?exceeded|context[_\s-]?window[_\s-]?exceeded|prompt[_\s-]?too[_\s-]?long|request[_\s-]?too[_\s-]?large|payload[_\s-]?too[_\s-]?large|invalid[_\s-]?api[_\s-]?key|invalid[_\s-]?authentication|permission[_\s-]?denied|insufficient[_\s-]?quota|quota[_\s-]?exceeded|billing[_\s-]?hard[_\s-]?limit[_\s-]?reached|account[_\s-]?deactivated|model[_\s-]?not[_\s-]?found|model[_\s-]?not[_\s-]?available|invalid[_\s-]?model|content[_\s-]?policy[_\s-]?violation)\b/i;

/**
 * Types, which are coarser than codes. `invalid_request_error` is OpenAI's
 * 400, and `insufficient_quota` is a rate-limit-shaped failure that is
 * actually about the account rather than the request; neither improves on a
 * third attempt.
 */
const PERMANENT_STREAM_TYPES =
  /\b(?:invalid[_\s-]?request(?:[_\s-]?error)?|authentication[_\s-]?error|permission[_\s-]?error|not[_\s-]?found[_\s-]?error|billing[_\s-]?error|account[_\s-]?error|insufficient[_\s-]?quota|request[_\s-]?too[_\s-]?large)\b/i;

/**
 * Message text, for the servers that send neither code nor type. Every
 * provider words this differently and no two agree: Anthropic says `prompt is
 * too long: 137500 tokens > 135000 maximum`, vLLM and DeepSeek say `This
 * model's maximum context length is 32768 tokens. However, your messages
 * resulted in 40000 tokens`, Groq says `Requested token count exceeds the
 * model's maximum context length`, and OpenAI puts the diagnosis in the code
 * while the message says only `Please reduce the length of the messages`.
 */
const OVERFLOW_TEXT =
  /\b(?:maximum context length|context length|context[_\s-]?length|context window|context size|prompt is too long|prompt too long|input is too long|input length|exceeds the (?:model'?s? )?maximum|exceeds the available|requested token count exceeds|messages resulted in|reduce the length of the messages|request entity too large|too many tokens|token limit)\b/i;

/** Message text for the permanent failures that arrive without a code. */
const PERMANENT_STREAM_TEXT =
  /\b(?:invalid api key|incorrect api key|api key (?:is )?(?:invalid|missing|expired)|no api key|unauthori[sz]ed|invalid authentication|permission denied|insufficient (?:quota|credit|balance)|quota exceeded|out of credits|payment required|model (?:not found|does not exist|is not available)|account (?:is )?(?:deactivated|suspended)|content policy)\b/i;

const OVERFLOW_ADVICE =
  "Retrying will not help — this conversation does not fit the model's context window. Start a new one with /clear, or switch to a model with a larger window.";

/** The closing line of a failure, derived from what actually happens next. */
function retryAdvice(retriable: boolean, permanentAdvice?: string): string {
  if (retriable) return "The harness will retry with backoff.";
  return permanentAdvice ?? "Retrying will not help — check the URL, the key, and the model name.";
}

/**
 * A failure message a person can act on.
 *
 * The endpoint is included because "request failed" tells the reader nothing
 * when three of them are configured, and the status because a body alone
 * cannot distinguish a rate limit from a crash. An HTML body is summarised
 * rather than quoted: the previous behaviour pasted its first 600 characters
 * into the transcript, which buried a one-line diagnosis under a wall of markup
 * and still omitted the two facts that would have identified the fault.
 *
 * The closing line is derived from `retriable`, never from a guess about what
 * "usually" happens. Telling someone a 403 will be retried when it will not is
 * worse than saying nothing, because they wait for a retry that never comes.
 *
 * The URL is safe to print — the constructor clears any query string, so a key
 * passed as a query parameter is already gone by this point.
 */
export function describeHttpFailure(
  endpoint: string,
  response: Response,
  body: string,
  retriable: boolean,
  retryAfterMs?: number,
): string {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const contentType = response.headers.get("content-type") ?? "no content-type";
  const head = `${status} from ${endpoint} (${contentType})`;

  // The closing line goes on this path too. It used to be attached only to
  // the shapeless-body case below, which meant that a provider that sends a
  // tidy one-line error -- the common case, and the one a user is most likely
  // to read -- got no statement of what happens next at all. That is the thing
  // this function exists to say.
  const detail = parseErrorMessage(body);
  if (detail) return `${head}: ${detail.replace(/[.\s]+$/, "")}. ${closeLine(retriable, retryAfterMs)}`;

  // Nothing usable in the body. Say what shape arrived instead of quoting it.
  const html = looksLikeHtml(response.headers.get("content-type"), body);
  const server = response.status >= 500;
  const shape = html
    ? server
      ? "it answered with an HTML error page, which means the server or its platform failed before the route ran"
      : "it answered with an HTML page, which usually means a login wall, a bot check, or the wrong URL"
    : body.trim()
      ? `it answered with a body that is not a usable error (${contentType}, ${body.length} bytes)`
      : `it answered with an empty body (${contentType})`;
  return `${head}: ${shape}. ${closeLine(retriable, retryAfterMs)}`;
}

/**
 * What happens next, said plainly.
 *
 * A rate limit with a reset time is neither of the two defaults: it will be
 * waited out, and the wait is the server's number rather than the harness's.
 * Saying "the harness will retry with backoff" about a window that resets in
 * forty minutes is advice the reader will act on and find false.
 */
function closeLine(retriable: boolean, wait?: number): string {
  if (wait === undefined) return retryAdvice(retriable);
  const seconds = Math.ceil(wait / 1_000);
  return retriable
    ? `Rate limited: the harness will wait ${seconds}s and try again.`
    : `Rate limited until the window resets in about ${seconds}s. The harness will not keep retrying before then.`;
}

function parseErrorMessage(body: string): string | undefined {
  if (!body.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    // Not JSON. An HTML page is never worth quoting, and a truncated JSON
    // document is a symptom rather than a message. A short, printable,
    // non-brace-prefixed body is a real message and is worth keeping.
    if (looksLikeHtml(null, body)) return undefined;
    const text = body.trim();
    if (/^[{[]/.test(text)) return undefined;
    // eslint-disable-next-line no-control-regex -- this range is a screenful of C0 control characters, and detecting them is the point
    if (text.length <= 300 && !/[\u0000-\u0008\u000e-\u001f]/.test(text)) return text;
    return undefined;
  }
  const record = value as { error?: { message?: string } | string; message?: string; detail?: string };
  if (typeof record.error === "string") return record.error;
  if (typeof record.error?.message === "string") return record.error.message;
  if (typeof record.message === "string") return record.message;
  if (typeof record.detail === "string") return record.detail;
  return undefined;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
