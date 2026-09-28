import type { ChatMessage, ModelClient, ModelEvent, ToolCall, ToolDefinition, Usage } from "./types.js";

export class ModelTransportError extends Error {
  constructor(message: string, readonly retriable = false) {
    super(message);
    this.name = "ModelTransportError";
  }
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
  error?: string;
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
      const retriable = response.status === 429 || response.status >= 500;
      throw new ModelTransportError(describeHttpFailure(this.endpoint, response, text, retriable), retriable);
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
    const events: ModelEvent[] = [];
    const handle = (frame: StreamFrame) => {
      if (frame.error) throw new ModelTransportError(frame.error, true);
      if (frame.content) events.push({ type: "token", delta: frame.content });
      if (frame.reasoning) events.push({ type: "reasoning", delta: frame.reasoning });
      if (frame.toolCalls) calls.push(frame.toolCalls);
      if (frame.completeToolCalls) {
        for (const call of frame.completeToolCalls) events.push({ type: "tool_call", tool_calls: [call] });
      }
      if (frame.usage) events.push({ type: "usage", usage: frame.usage });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = drainFrames(buffer, handle);
        buffer = parsed.rest;
        for (const frame of parsed.frames) if (frame.done) sawDone = true;
        while (events.length > 0) yield events.shift()!;
      }
      buffer += decoder.decode();
      const parsedTail = drainFrames(buffer, handle);
      for (const frame of parsedTail.frames) if (frame.done) sawDone = true;
      const completeCalls = calls.finish();
      if (completeCalls.length > 0) yield { type: "tool_call", tool_calls: completeCalls };
      while (events.length > 0) yield events.shift()!;
      if (sawDone) yield { type: "done" };
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

function drainFrames(buffer: string, handle: (frame: StreamFrame) => void): { frames: StreamFrame[]; rest: string } {
  const frames: StreamFrame[] = [];
  let rest = buffer;
  const handleFrame = (frame: StreamFrame) => { frames.push(frame); handle(frame); };
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
    const delta = Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null
      ? (choices[0] as { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown } }).delta
      : undefined;
    handleFrame({ content: typeof delta?.content === "string" ? delta.content : undefined, reasoning: typeof delta?.reasoning_content === "string" ? delta.reasoning_content : typeof delta?.reasoning === "string" ? delta.reasoning : undefined, toolCalls: Array.isArray(delta?.tool_calls) ? delta.tool_calls as ToolDelta[] : undefined, completeToolCalls: Array.isArray(value.tool_calls) ? value.tool_calls as ToolCall[] : undefined, usage: value.usage as Usage, error: typeof (value.error as Record<string, unknown> | undefined)?.message === "string" ? String((value.error as Record<string, unknown>).message) : undefined });
  }
  return { frames, rest };
}

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
): string {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const contentType = response.headers.get("content-type") ?? "no content-type";
  const head = `${status} from ${endpoint} (${contentType})`;

  const detail = parseErrorMessage(body);
  if (detail) return `${head}: ${detail}`;

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
  const next = retriable
    ? "The harness will retry with backoff."
    : "Retrying will not help — check the URL, the key, and the model name.";
  return `${head}: ${shape}. ${next}`;
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
