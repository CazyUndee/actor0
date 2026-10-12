import {
  ModelTransportError,
  describeHttpFailure,
  isRetriableStreamError,
  looksLikeHtml,
  retryAfterMs,
  MAX_HONOURED_RETRY_AFTER_MS,
  type ChatMessage,
  type ModelClient,
  type ModelEvent,
  type ToolDefinition,
} from "@actor0/harness";

/**
 * A `ModelClient` for the OpenAI *Responses* API behind ChatGPT.
 *
 * This is the third transport, and it is not Chat Completions: ChatGPT (via
 * Codex) speaks the Responses API at `chatgpt.com/backend-api/codex/responses`,
 * authenticated with an OAuth access token plus the `chatgpt-account-id` header
 * read from the id token. The differences from the OpenAI-compatible transport
 * the harness ships are all inside this file:
 *
 *   - the system prompt is a top-level `instructions` field, not a message;
 *   - `input` is a flat list of typed items (`input_text` messages,
 *     `function_call`, `function_call_output`), not `messages` with roles;
 *   - streaming is `response.*` events, not `choices[].delta`;
 *   - the stream ends on `response.completed` / `response.incomplete`, and
 *     `incomplete` with `max_output_tokens` is the truncation signal.
 *
 * The values (endpoint, headers, event names) were read off the shipped
 * `codex.exe`, not recalled — see `provider-presets.ts`.
 */

/** Beta header the Responses backend expects. */
const OPENAI_BETA = "responses=experimental";

export type ChatGptOptions = {
  /** Root of the backend, e.g. `https://chatgpt.com/backend-api/codex`. */
  baseUrl: string;
  model: string;
  accessToken: string;
  /** ChatGPT account id, required as a request header. */
  accountId?: string;
  /** Reasoning effort for models that support it. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Override the request path. Defaults to `/responses`. */
  path?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
};

type ResponsesItem = Record<string, unknown>;

/**
 * Translate the harness's OpenAI-shaped transcript into Responses `input`.
 *
 * Exported and pure so the mapping is testable without a network. System
 * messages collapse into `instructions`; a tool result becomes a
 * `function_call_output` item keyed by the call id; an assistant tool call
 * becomes a `function_call` item.
 */
export function toResponsesRequest(messages: ChatMessage[]): { instructions?: string; input: ResponsesItem[] } {
  const instructions: string[] = [];
  const input: ResponsesItem[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) instructions.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id ?? "", output: message.content });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: "completed" });
      }
      continue;
    }
    // user
    input.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
  }

  return { ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}), input };
}

/** Responses tools carry the same function shape as Chat Completions. */
export function toResponsesTools(tools: ToolDefinition[]): ResponsesItem[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

export class ChatGptModel implements ModelClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly accessToken: string;
  private readonly accountId?: string;
  private readonly reasoningEffort?: "low" | "medium" | "high";
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: ChatGptOptions) {
    if (!options.model.trim()) throw new Error("model is required");
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("base URL must use http or https");
    const explicitPath = options.path?.trim();
    if (explicitPath) {
      url.pathname = explicitPath.startsWith("/") ? explicitPath : `/${explicitPath}`;
    } else {
      // Append `/responses` to whatever prefix the base URL carries — the
      // ChatGPT backend is served from `/backend-api/codex`, and replacing the
      // pathname would silently drop that prefix.
      url.pathname = url.pathname.replace(/\/+$/, "");
      if (!url.pathname.endsWith("/responses")) url.pathname = `${url.pathname}/responses`;
    }
    url.search = "";
    url.hash = "";
    this.endpoint = url.toString();
    this.model = options.model.trim();
    this.accessToken = options.accessToken;
    this.accountId = options.accountId;
    this.reasoningEffort = options.reasoningEffort;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  async *stream(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    const translated = toResponsesRequest(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      input: translated.input,
      stream: true,
      store: false,
      tool_choice: "auto",
      ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
    };
    if (translated.instructions) body.instructions = translated.instructions;
    const responsesTools = toResponsesTools(tools);
    if (responsesTools.length > 0) body.tools = responsesTools;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${this.accessToken}`,
      "OpenAI-Beta": OPENAI_BETA,
      ...this.headers,
    };
    if (this.accountId) headers["chatgpt-account-id"] = this.accountId;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ModelTransportError(`network request failed: ${errorText(error)}`, true);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const wait = retryAfterMs(response.headers);
      const transient = response.status === 429 || response.status >= 500;
      const retriable = transient && (wait === undefined || wait <= MAX_HONOURED_RETRY_AFTER_MS);
      throw new ModelTransportError(describeHttpFailure(this.endpoint, response, text, retriable, wait), retriable, wait);
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !/\btext\/event-stream\b/i.test(contentType)) {
      const head = await response.clone().text().catch(() => "");
      if (looksLikeHtml(contentType, head)) {
        throw new ModelTransportError(
          `${this.endpoint} answered ${response.status} with an HTML page, not an event stream. ` +
            `That is a platform-level error rather than a model failure. The harness will retry with backoff.`,
          true,
        );
      }
    }
    if (!response.body) throw new ModelTransportError("response has no body", true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = new ResponsesStreamState();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = drainResponsesFrames(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) yield* state.handle(event);
      }
      buffer += decoder.decode();
      const tail = drainResponsesFrames(buffer);
      for (const event of tail.events) yield* state.handle(event);
      yield* state.finish();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

/** Accumulates the `response.*` event stream and emits harness `ModelEvent`s. */
class ResponsesStreamState {
  private inputTokens = 0;
  private outputTokens = 0;
  private totalTokens = 0;
  private stopReason: string | undefined;
  private sawTerminal = false;
  // Function-call items being streamed, keyed by output index — parallel tool
  // calls each get their own slot, so one call's arguments cannot clobber
  // another's (the reference keys its buffer the same way).
  private readonly calls = new Map<number, { callId: string; name: string; args: string }>();

  handle(event: Record<string, unknown>): ModelEvent[] {
    const type = event.type;
    const out: ModelEvent[] = [];
    switch (type) {
      case "response.output_item.added": {
        const item = event.item as { type?: string; call_id?: string; name?: string } | undefined;
        if (item?.type === "function_call") {
          this.calls.set(event.output_index as number, { callId: item.call_id ?? "", name: item.name ?? "", args: "" });
        }
        break;
      }
      case "response.output_text.delta": {
        const delta = event.delta;
        if (typeof delta === "string" && delta) out.push({ type: "token", delta });
        break;
      }
      case "response.reasoning_summary_text.delta": {
        const delta = event.delta;
        if (typeof delta === "string" && delta) out.push({ type: "reasoning", delta });
        break;
      }
      case "response.function_call_arguments.delta": {
        const call = this.calls.get(event.output_index as number);
        if (call && typeof event.delta === "string") call.args += event.delta;
        break;
      }
      case "response.output_item.done": {
        const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "function_call") {
          const index = event.output_index as number;
          const open = this.calls.get(index);
          // Prefer the completed arguments the done event carries; fall back to
          // whatever the deltas accumulated.
          const args = typeof item.arguments === "string" ? item.arguments : open?.args ?? "";
          out.push({
            type: "tool_call",
            tool_calls: [
              {
                id: item.call_id || open?.callId || `call_${index}`,
                type: "function",
                function: { name: item.name ?? open?.name ?? "", arguments: args },
              },
            ],
          });
          this.calls.delete(index);
        }
        break;
      }
      case "response.completed": {
        const response = event.response as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }; status?: string; incomplete_details?: { reason?: string } } | undefined;
        if (response?.usage) {
          this.inputTokens = response.usage.input_tokens ?? 0;
          this.outputTokens = response.usage.output_tokens ?? 0;
          this.totalTokens = response.usage.total_tokens ?? this.inputTokens + this.outputTokens;
        }
        if (response?.incomplete_details?.reason) this.stopReason = response.incomplete_details.reason;
        this.sawTerminal = true;
        break;
      }
      case "response.incomplete": {
        const response = event.response as { incomplete_details?: { reason?: string } } | undefined;
        if (response?.incomplete_details?.reason) this.stopReason = response.incomplete_details.reason;
        this.sawTerminal = true;
        break;
      }
      case "error": {
        // The top-level `error` event carries code/message at the top level, not
        // nested under `error` — reading only the nested form classifies every
        // such error as retriable and loses the diagnosis.
        const message = typeof event.message === "string" ? event.message : "";
        const code = typeof event.code === "string" ? event.code : undefined;
        throw streamError(message, code);
      }
      case "response.failed": {
        const err = (event.response as { error?: { message?: string; code?: string } } | undefined)?.error;
        throw streamError(err?.message ?? "", err?.code);
      }
      // response.created, response.in_progress, content_part.* — no content.
    }
    return out;
  }

  finish(): ModelEvent[] {
    const out: ModelEvent[] = [];
    // Flush any tool call the stream never closed with an output_item.done, so a
    // cut-off call is not silently dropped.
    for (const [index, call] of [...this.calls.entries()].sort(([a], [b]) => a - b)) {
      out.push({
        type: "tool_call",
        tool_calls: [{ id: call.callId || `call_${index}`, type: "function", function: { name: call.name, arguments: call.args } }],
      });
    }
    this.calls.clear();
    if (this.inputTokens || this.outputTokens || this.totalTokens) {
      out.push({
        type: "usage",
        usage: {
          prompt_tokens: this.inputTokens,
          completion_tokens: this.outputTokens,
          total_tokens: this.totalTokens || this.inputTokens + this.outputTokens,
        },
      });
    }
    const truncated = this.stopReason === "max_output_tokens";
    if (this.sawTerminal || this.stopReason !== undefined) {
      out.push(truncated ? { type: "done", truncated: true, reason: this.stopReason } : { type: "done" });
    }
    return out;
  }
}

function streamError(message: string, code?: string): ModelTransportError {
  const retriable = isRetriableStreamError(message, code);
  return new ModelTransportError(
    `ChatGPT ended the stream with an error${message ? `: ${message}` : " and gave no message"}. ` +
      (retriable ? "The harness will retry with backoff." : "Retrying will not help — the token may have expired; sign in again."),
    retriable,
  );
}

/** Split an SSE buffer into `response.*` event objects (reads the `data:` payload). */
export function drainResponsesFrames(buffer: string): { events: Record<string, unknown>[]; rest: string } {
  const events: Record<string, unknown>[] = [];
  let rest = buffer;
  while (true) {
    const lf = rest.indexOf("\n\n");
    const crlf = rest.indexOf("\r\n\r\n");
    let index: number;
    let length: number;
    if (lf === -1 && crlf === -1) break;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) {
      index = crlf;
      length = 4;
    } else {
      index = lf;
      length = 2;
    }
    const block = rest.slice(0, index);
    rest = rest.slice(index + length);
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      throw new ModelTransportError("endpoint returned invalid SSE JSON", true);
    }
  }
  return { events, rest };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
