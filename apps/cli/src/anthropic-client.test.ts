import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelTransportError } from "@actor0/harness";
import {
  AnthropicModel,
  drainAnthropicFrames,
  maxOutputTokensForModel,
  toAnthropicRequest,
  toAnthropicTools,
  type AnthropicAuth,
} from "./anthropic-client.js";
import type { ChatMessage, ModelEvent, ToolDefinition } from "@actor0/harness";

/**
 * The Anthropic Messages client, tested the way the harness tests its own
 * OpenAI-compatible one: the translation is pure and checked directly, and the
 * streaming path is driven by a mock `fetch` that returns an SSE body. The
 * point is that a Claude stream maps to the same `ModelEvent`s the turn loop
 * already understands — tokens, tool calls, usage, a `done` that says whether
 * the answer was cut off.
 */

const apiKey = (): AnthropicAuth => ({ kind: "api-key", apiKey: "sk-ant-test" });

/** A `fetch` that answers every call with the given SSE text and a 200. */
function sseFetch(body: string, contentType = "text/event-stream"): typeof fetch {
  return async () =>
    new Response(body, { status: 200, headers: { "content-type": contentType } });
}

async function collect(iter: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

test("system messages become one system field, not a message", () => {
  const { system, messages } = toAnthropicRequest([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(system, "be terse");
  assert.deepEqual(messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("an assistant tool call becomes a tool_use block, and its result a tool_result", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "read notes.md" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"notes.md"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "the file" },
  ];
  const { messages: out } = toAnthropicRequest(messages);
  assert.deepEqual(out, [
    { role: "user", content: [{ type: "text", text: "read notes.md" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "notes.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "the file" }] },
  ]);
});

test("consecutive tool results merge into one user message", () => {
  // Anthropic has no tool role and rejects two user turns in a row, so a run of
  // results must land in a single user message with one tool_result each.
  const { messages } = toAnthropicRequest([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "a", type: "function", function: { name: "x", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "y", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "ra" },
    { role: "tool", tool_call_id: "b", content: "rb" },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.role, "user");
  assert.equal(messages[1]!.content.length, 2);
  assert.deepEqual(messages[1]!.content.map((b) => (b.type === "tool_result" ? b.tool_use_id : "?")), ["a", "b"]);
});

test("OpenAI tool definitions flatten to Anthropic input_schema tools", () => {
  const tools: ToolDefinition[] = [
    { type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } },
  ];
  assert.deepEqual(toAnthropicTools(tools), [{ name: "read", description: "read a file", input_schema: { type: "object" } }]);
});

test("a text stream maps to token deltas, usage and a clean done", async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
    "",
  ].join("\n");
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-x", auth: apiKey(), fetchImpl: sseFetch(sse) });
  const events = await collect(model.stream([{ role: "user", content: "hi" }], [], new AbortController().signal));
  const tokens = events.filter((e) => e.type === "token").map((e) => (e.type === "token" ? e.delta : ""));
  assert.deepEqual(tokens, ["Hel", "lo"]);
  const usage = events.find((e) => e.type === "usage");
  assert.equal(usage?.type === "usage" && usage.usage.total_tokens, 17);
  const done = events.at(-1);
  assert.deepEqual(done, { type: "done" }, "end_turn is a finished answer, not a cut-off one");
});

test("a tool_use block maps to a tool_call event with its streamed arguments", async () => {
  const sse = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}',
    "",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
    "",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.md\\"}"}}',
    "",
    'data: {"type":"content_block_stop","index":0}',
    "",
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
    "",
    'data: {"type":"message_stop"}',
    "",
    "",
  ].join("\n");
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-x", auth: apiKey(), fetchImpl: sseFetch(sse) });
  const events = await collect(model.stream([{ role: "user", content: "read a.md" }], [], new AbortController().signal));
  const call = events.find((e) => e.type === "tool_call");
  assert.equal(call?.type === "tool_call" && call.tool_calls[0]!.function.name, "read");
  assert.equal(call?.type === "tool_call" && call.tool_calls[0]!.function.arguments, '{"path":"a.md"}');
});

test("stop_reason max_tokens is reported as a truncated done", async () => {
  const sse = [
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"cut"}}',
    "",
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8192}}',
    "",
    'data: {"type":"message_stop"}',
    "",
    "",
  ].join("\n");
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-x", auth: apiKey(), fetchImpl: sseFetch(sse) });
  const done = (await collect(model.stream([{ role: "user", content: "go" }], [], new AbortController().signal))).at(-1);
  assert.deepEqual(done, { type: "done", truncated: true, reason: "max_tokens" });
});

test("thinking deltas map to reasoning events", async () => {
  const sse = [
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
    "",
    'data: {"type":"message_stop"}',
    "",
    "",
  ].join("\n");
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-x", auth: apiKey(), fetchImpl: sseFetch(sse) });
  const events = await collect(model.stream([{ role: "user", content: "go" }], [], new AbortController().signal));
  assert.deepEqual(events.find((e) => e.type === "reasoning"), { type: "reasoning", delta: "hmm" });
});

test("an in-stream error frame throws a transport error, classified for retry", async () => {
  const sse = [
    'data: {"type":"error","error":{"type":"overloaded_error","message":"upstream busy"}}',
    "",
    "",
  ].join("\n");
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-x", auth: apiKey(), fetchImpl: sseFetch(sse) });
  await assert.rejects(
    () => collect(model.stream([{ role: "user", content: "go" }], [], new AbortController().signal)),
    (error: unknown) => error instanceof ModelTransportError && error.retriable === true,
  );
});

test("a 401 is a permanent failure naming the credential", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-x", auth: apiKey(), fetchImpl });
  await assert.rejects(
    () => collect(model.stream([{ role: "user", content: "go" }], [], new AbortController().signal)),
    (error: unknown) => error instanceof ModelTransportError && error.retriable === false,
  );
});

test("max_tokens comes from the model, mirroring Claude Code's table", () => {
  // Anthropic requires `max_tokens` and rejects a value above the model's limit,
  // so the value is the model's own default — not a fixed cap.
  assert.equal(maxOutputTokensForModel("claude-opus-4-6"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-opus-4-7"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-opus-5"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-opus-5-5"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-sonnet-5"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-sonnet-5-5"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-fable-5"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-fable-5-1"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-haiku-5-5"), 128_000);
  assert.equal(maxOutputTokensForModel("claude-haiku-4-5"), 64_000, "Haiku 4.5 is the 64k exception");
  assert.equal(maxOutputTokensForModel("claude-sonnet-4-5-20250929"), 32_000);
  assert.equal(maxOutputTokensForModel("claude-3-7-sonnet-20250219"), 32_000);
  assert.equal(maxOutputTokensForModel("claude-3-5-sonnet-20241022"), 8_192);
  assert.equal(maxOutputTokensForModel("claude-3-opus-20240229"), 4_096);
  assert.equal(maxOutputTokensForModel("some-unknown-model"), 32_000, "unknown models get the 32k default");
});

test("the request carries the model's own max_tokens, not a fixed cap", async () => {
  let body: { max_tokens?: number } = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response('data: {"type":"message_stop"}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-3-7-sonnet-20250219", auth: apiKey(), fetchImpl });
  await collect(model.stream([{ role: "user", content: "hi" }], [], new AbortController().signal));
  assert.equal(body.max_tokens, 32_000, "3.7-sonnet gets its 32k default, not 8192");
});

test("frames split on the blank line and keep the remainder", () => {
  const { events, rest } = drainAnthropicFrames('data: {"type":"ping"}\n\ndata: {"type":"partial"');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "ping");
  assert.equal(rest, 'data: {"type":"partial"');
});

test("a [DONE] sentinel does not throw after a message_stop", async () => {
  const sse = ['data: {"type":"message_stop"}', "", "data: [DONE]", "", ""].join("\n");
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-x", auth: apiKey(), fetchImpl: sseFetch(sse) });
  const done = (await collect(model.stream([{ role: "user", content: "go" }], [], new AbortController().signal))).at(-1);
  assert.deepEqual(done, { type: "done" });
});

test("an unterminated tool_use block is still flushed, not dropped", async () => {
  // A stream that opens a tool_use and ends without content_block_stop must not
  // lose the call — finish() flushes what is still open.
  const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const sse = [
    frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"p":1}' } }),
    frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
    frame({ type: "message_stop" }),
  ].join("");
  const model = new AnthropicModel({ baseUrl: "https://api.anthropic.com", model: "claude-x", auth: apiKey(), fetchImpl: sseFetch(sse) });
  const call = (await collect(model.stream([{ role: "user", content: "go" }], [], new AbortController().signal))).find((e) => e.type === "tool_call");
  assert.equal(call?.type === "tool_call" && call.tool_calls[0]!.function.arguments, '{"p":1}');
});

test("the OAuth client sends a bearer token and the beta header, not an api key", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response('data: {"type":"message_stop"}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const model = new AnthropicModel({
    baseUrl: "https://api.anthropic.com",
    model: "claude-x",
    auth: { kind: "oauth", accessToken: "oauth-tok" },
    fetchImpl,
  });
  await collect(model.stream([{ role: "user", content: "hi" }], [], new AbortController().signal));
  assert.equal(seen["authorization"], "Bearer oauth-tok");
  assert.equal(seen["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(seen["x-api-key"], undefined, "an OAuth request must not also carry an api key");
});
