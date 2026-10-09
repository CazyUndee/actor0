import {
  ModelTransportError,
  describeHttpFailure,
  isContextOverflow,
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
 * A `ModelClient` for the Anthropic Messages API.
 *
 * The harness is transport-neutral and ships only the OpenAI-compatible
 * transport; this is the CLI's client for Anthropic, behind the same
 * `ModelClient` port, so the turn loop, retries, tool rounds and rewind all
 * work unchanged. What differs is the wire shape, and that is entirely inside
 * this file:
 *
 *   - the system prompt is a top-level field, not a message;
 *   - message content is an array of blocks, not a string;
 *   - tool calls are `tool_use` blocks in an assistant turn and `tool_result`
 *     blocks in the following user turn, not `tool_calls` / `role:"tool"`;
 *   - streaming is a sequence of typed events (`message_start`,
 *     `content_block_delta`, `message_delta`, …), not `choices[].delta`.
 *
 * Auth is either an API key (`x-api-key`) or a Claude Code OAuth access token
 * (`Authorization: Bearer` plus the `oauth-2025-04-20` beta). Everything the
 * harness needs to classify a failure — retriability, context overflow — is
 * reused from `@actor0/harness`, so an Anthropic refusal is handled exactly
 * like an OpenAI one.
 */

/** The Messages API version header. Pinned; the API is versioned by date. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Beta flag that lets a Claude Code OAuth token call the Messages API. */
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/**
 * The max output tokens for a model: the *model's own* limit, not a fixed cap.
 *
 * `max_tokens` is a required field the Anthropic API will neither fill in nor
 * clamp — a value above the model's limit is rejected with a 400 — so the value
 * has to come from the model. The base mapping follows Claude Code
 * (`getModelMaxOutputTokens`), extended with the current model limits (the
 * opus-4.6+/sonnet-5+/fable-5+ 128k tier; Haiku 4.5 the 64k exception).
 * Overridable per request or via `ACTOR0_MAX_OUTPUT_TOKENS`.
 */
export function maxOutputTokensForModel(model: string): number {
  const m = model.toLowerCase();
  // Haiku is the exception to the 128k tier: 4.5 is 64k, 5.5 is 128k.
  if (m.includes("haiku-4-5") || m.includes("haiku-4.5")) return 64_000;
  if (m.includes("haiku-5")) return 128_000;
  // Newer top-tier models (opus 4.6+, opus/sonnet 5+, fable 5+) sit at 128k.
  if (
    m.includes("opus-4-6") || m.includes("opus-4-7") || m.includes("opus-4-8") ||
    m.includes("opus-5") || m.includes("sonnet-5") || m.includes("fable-5")
  ) {
    return 128_000;
  }
  // Older tiers, from Claude Code's table.
  if (m.includes("sonnet-4-6")) return 32_000;
  if (m.includes("opus-4-5") || m.includes("sonnet-4") || m.includes("haiku-4")) return 32_000;
  if (m.includes("opus-4-1") || m.includes("opus-4")) return 32_000;
  if (m.includes("claude-3-opus")) return 4_096;
  if (m.includes("claude-3-sonnet")) return 8_192;
  if (m.includes("claude-3-haiku")) return 4_096;
  if (m.includes("3-5-sonnet") || m.includes("3-5-haiku")) return 8_192;
  if (m.includes("3-7-sonnet")) return 32_000;
  return 32_000;
}

/** An explicit override from the environment, if set to a positive integer. */
function envMaxOutputTokens(): number | undefined {
  const raw = process.env.ACTOR0_MAX_OUTPUT_TOKENS?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export type AnthropicAuth =
  | { kind: "api-key"; apiKey: string }
  | { kind: "oauth"; accessToken: string };

export type AnthropicOptions = {
  /** Root of the API, e.g. `https://api.anthropic.com`. */
  baseUrl: string;
  model: string;
  auth: AnthropicAuth;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /** Override the request path. Defaults to `/v1/messages`. */
  path?: string;
};

/** Stop reasons that mean the answer was cut off, not finished. */
const TRUNCATION_STOP_REASONS: ReadonlySet<string> = new Set([
  "max_tokens",
  "model_context_window_exceeded",
]);

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicContentBlock[] };

/**
 * Translate the harness's OpenAI-shaped transcript into Anthropic's shape.
 *
 * Exported and pure so the mapping can be tested without a network. Three
 * things are not one-to-one and are where a naive translation breaks:
 *
 *   - system messages become one `system` string, not a `role:"system"` message;
 *   - an assistant turn carrying `tool_calls` becomes text blocks plus `tool_use`
 *     blocks;
 *   - a run of `role:"tool"` results becomes a single `user` message of
 *     `tool_result` blocks — Anthropic has no `tool` role, and each result must
 *     sit in the user turn that follows the assistant turn that requested it.
 */
export function toAnthropicRequest(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];

  const push = (role: "user" | "assistant", content: AnthropicContentBlock[]) => {
    if (content.length === 0) return;
    const last = out[out.length - 1];
    // Anthropic alternates user/assistant. A tool result and a following user
    // message would both be `user`; merge them rather than emit two in a row,
    // which the API rejects.
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "",
          content: message.content,
        },
      ]);
      continue;
    }
    if (message.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseToolInput(call.function.arguments),
        });
      }
      push("assistant", content);
      continue;
    }
    // user
    push("user", [{ type: "text", text: message.content }]);
  }

  return {
    ...(system.length ? { system: system.join("\n\n") } : {}),
    messages: out,
  };
}

/** Anthropic tools: OpenAI's `function` wrapper flattened, `parameters` → `input_schema`. */
export function toAnthropicTools(tools: ToolDefinition[]): { name: string; description: string; input_schema: unknown }[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function parseToolInput(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // The harness only ever hands us arguments it accepted as JSON, but a
    // partial stream could arrive here; an empty object is a valid tool input
    // and far better than throwing away the call.
    return {};
  }
}

export class AnthropicModel implements ModelClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly auth: AnthropicAuth;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: AnthropicOptions) {
    if (!options.model.trim()) throw new Error("model is required");
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("base URL must use http or https");
    const path = options.path?.trim();
    if (path) {
      url.pathname = path.startsWith("/") ? path : `/${path}`;
    } else {
      // Append `/v1/messages` to whatever prefix the base URL carries — a proxy
      // served from a path keeps it, rather than having the pathname replaced.
      url.pathname = url.pathname.replace(/\/+$/, "");
      if (!url.pathname.endsWith("/v1/messages")) url.pathname = `${url.pathname}/v1/messages`;
    }
    url.search = "";
    url.hash = "";
    this.endpoint = url.toString();
    this.model = options.model.trim();
    this.auth = options.auth;
    // The model's own max, not a fixed cap — Anthropic requires `max_tokens` and
    // rejects a value above the model's limit, so the value comes from the model.
    // An explicit option, then the environment, then the model's default.
    this.maxTokens = options.maxTokens ?? envMaxOutputTokens() ?? maxOutputTokensForModel(this.model);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  private authHeaders(): Record<string, string> {
    if (this.auth.kind === "oauth") {
      return {
        Authorization: `Bearer ${this.auth.accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
      };
    }
    return { "x-api-key": this.auth.apiKey };
  }

  async *stream(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    const translated = toAnthropicRequest(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      stream: true,
      messages: translated.messages,
    };
    if (translated.system) body.system = translated.system;
    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools.length > 0) body.tools = anthropicTools;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "anthropic-version": ANTHROPIC_VERSION,
          ...this.authHeaders(),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ModelTransportError(`network request failed: ${errorText(error)}`, true);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const wait = retryAfterMs(response.headers);
      const transient = response.status === 429 || response.status >= 500;
      const retriable = transient && (wait === undefined || wait <= MAX_HONOURED_RETRY_AFTER_MS);
      throw new ModelTransportError(
        describeHttpFailure(this.endpoint, response, text, retriable, wait),
        retriable,
        wait,
      );
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
    const state = new AnthropicStreamState();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = drainAnthropicFrames(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) yield* state.handle(event);
      }
      buffer += decoder.decode();
      const tail = drainAnthropicFrames(buffer);
      for (const event of tail.events) yield* state.handle(event);
      yield* state.finish();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

/** Accumulates Anthropic's event stream and emits harness `ModelEvent`s. */
class AnthropicStreamState {
  private inputTokens = 0;
  private outputTokens = 0;
  private stopReason: string | undefined;
  private sawStop = false;
  // Tool-use blocks being streamed, keyed by content-block index. Anthropic
  // streams blocks sequentially, but keying by index (rather than a single slot)
  // means a block the stream never closes is still flushed, not dropped.
  private readonly tools = new Map<number, { id: string; name: string; args: string }>();

  handle(event: Record<string, unknown>): ModelEvent[] {
    const type = event.type;
    const out: ModelEvent[] = [];
    switch (type) {
      case "message_start": {
        // Anthropic spells the counts `input_tokens`/`output_tokens`; the
        // harness `Usage` spells them `prompt_tokens`/`completion_tokens`.
        const usage = (event.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
        if (usage?.input_tokens) this.inputTokens = usage.input_tokens;
        break;
      }
      case "content_block_start": {
        const block = event.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === "tool_use") {
          this.tools.set(event.index as number, { id: block.id ?? "", name: block.name ?? "", args: "" });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) out.push({ type: "token", delta: delta.text });
        else if (delta?.type === "thinking_delta" && delta.thinking) out.push({ type: "reasoning", delta: delta.thinking });
        else if (delta?.type === "input_json_delta") {
          const tool = this.tools.get(event.index as number);
          if (tool) tool.args += delta.partial_json ?? "";
        }
        break;
      }
      case "content_block_stop": {
        const index = event.index as number;
        const tool = this.tools.get(index);
        if (tool) {
          out.push({
            type: "tool_call",
            tool_calls: [{ id: tool.id || `toolu_${index}`, type: "function", function: { name: tool.name, arguments: tool.args } }],
          });
          this.tools.delete(index);
        }
        break;
      }
      case "message_delta": {
        const delta = event.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) this.stopReason = delta.stop_reason;
        const usage = event.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens !== undefined) this.outputTokens = usage.output_tokens;
        break;
      }
      case "message_stop":
        this.sawStop = true;
        break;
      case "error": {
        const err = event.error as { type?: string; message?: string } | undefined;
        const message = err?.message ?? "";
        const retriable = isRetriableStreamError(message, undefined, err?.type);
        throw new ModelTransportError(
          `Anthropic ended the stream with an error${message ? `: ${message}` : " and gave no message"}. ` +
            (retriable ? "The harness will retry with backoff." : "Retrying will not help — check the key and the model name."),
          retriable,
        );
      }
      // "ping" and anything unrecognised carry no content; ignore.
    }
    return out;
  }

  finish(): ModelEvent[] {
    const out: ModelEvent[] = [];
    // Flush any tool_use block the stream never closed, so a cut-off call is not
    // silently dropped.
    for (const [index, tool] of [...this.tools.entries()].sort(([a], [b]) => a - b)) {
      out.push({
        type: "tool_call",
        tool_calls: [{ id: tool.id || `toolu_${index}`, type: "function", function: { name: tool.name, arguments: tool.args } }],
      });
    }
    this.tools.clear();
    if (this.inputTokens || this.outputTokens) {
      out.push({
        type: "usage",
        usage: {
          prompt_tokens: this.inputTokens,
          completion_tokens: this.outputTokens,
          total_tokens: this.inputTokens + this.outputTokens,
        },
      });
    }
    const truncated = this.stopReason !== undefined && TRUNCATION_STOP_REASONS.has(this.stopReason);
    if (this.sawStop || this.stopReason !== undefined) {
      out.push(truncated ? { type: "done", truncated: true, reason: this.stopReason } : { type: "done" });
    }
    return out;
  }
}

/**
 * Split an SSE buffer into Anthropic event objects. Pure, and only the `data:`
 * payload is read: the `event:` line always repeats the JSON's `type`, so
 * dispatching on `type` alone is correct and tolerates servers that omit the
 * named-event line.
 */
export function drainAnthropicFrames(buffer: string): { events: Record<string, unknown>[]; rest: string } {
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

/** True when a thrown value is the Messages API refusing an oversized request. */
export function isAnthropicContextOverflow(error: unknown): boolean {
  return error instanceof ModelTransportError && !error.retriable && isContextOverflow(error.message);
}
