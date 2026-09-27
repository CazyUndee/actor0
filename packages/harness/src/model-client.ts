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
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/chat/completions")) url.pathname = `${url.pathname}/chat/completions`;
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
      throw new ModelTransportError(parseErrorMessage(text) ?? `request failed with HTTP ${response.status}`, response.status === 429 || response.status >= 500);
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

function parseErrorMessage(body: string): string | undefined {
  if (!body.trim()) return undefined;
  try {
    const value = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof value.error === "string") return value.error;
    if (typeof value.error?.message === "string") return value.error.message;
  } catch { return body.trim().slice(0, 600); }
  return undefined;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
