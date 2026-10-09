import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelTransportError } from "@actor0/harness";
import { ChatGptModel, drainResponsesFrames, toResponsesRequest, toResponsesTools } from "./chatgpt-client.js";
import type { ChatMessage, ModelEvent, ToolDefinition } from "@actor0/harness";

/**
 * The ChatGPT Responses client, tested like the others: the translation is pure
 * and checked directly; the streaming path is driven by a mock `fetch` returning
 * the `response.*` SSE events. The point is that a ChatGPT stream maps to the
 * same `ModelEvent`s the turn loop already understands.
 */

function sseFetch(body: string): typeof fetch {
  return async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(iter: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

const client = (body: string, accountId?: string) =>
  new ChatGptModel({ baseUrl: "https://chatgpt.com/backend-api/codex", model: "gpt-5", accessToken: "AT", ...(accountId ? { accountId } : {}), fetchImpl: sseFetch(body) });

test("system becomes instructions, user becomes an input_text item", () => {
  const { instructions, input } = toResponsesRequest([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(instructions, "be terse");
  assert.deepEqual(input, [{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
});

test("an assistant tool call becomes a function_call item, its result a function_call_output", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "read notes.md" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"n.md"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "the file" },
  ];
  const { input } = toResponsesRequest(messages);
  assert.deepEqual(input[1], { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"n.md"}', status: "completed" });
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "c1", output: "the file" });
});

test("tools carry the function shape", () => {
  const tools: ToolDefinition[] = [{ type: "function", function: { name: "read", description: "d", parameters: { type: "object" } } }];
  assert.deepEqual(toResponsesTools(tools), [{ type: "function", name: "read", description: "d", parameters: { type: "object" } }]);
});

test("a text stream maps to token deltas, usage and a clean done", async () => {
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"Hel"}',
    "",
    'data: {"type":"response.output_text.delta","delta":"lo"}',
    "",
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}',
    "",
    "",
  ].join("\n");
  const events = await collect(client(sse).stream([{ role: "user", content: "hi" }], [], new AbortController().signal));
  assert.deepEqual(events.filter((e) => e.type === "token").map((e) => (e.type === "token" ? e.delta : "")), ["Hel", "lo"]);
  const usage = events.find((e) => e.type === "usage");
  assert.equal(usage?.type === "usage" && usage.usage.total_tokens, 13);
  assert.deepEqual(events.at(-1), { type: "done" });
});

test("a function_call maps to a tool_call event with its streamed arguments", async () => {
  const sse = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"fc1","name":"read"}}',
    "",
    'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":"}',
    "",
    'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"\\"a.md\\"}"}',
    "",
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"fc1","name":"read","arguments":"{\\"path\\":\\"a.md\\"}"}}',
    "",
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":8,"total_tokens":13}}}',
    "",
    "",
  ].join("\n");
  const call = (await collect(client(sse).stream([{ role: "user", content: "read a.md" }], [], new AbortController().signal))).find((e) => e.type === "tool_call");
  assert.equal(call?.type === "tool_call" && call.tool_calls[0]!.function.name, "read");
  assert.equal(call?.type === "tool_call" && call.tool_calls[0]!.function.arguments, '{"path":"a.md"}');
  assert.equal(call?.type === "tool_call" && call.tool_calls[0]!.id, "fc1");
});

test("response.incomplete with max_output_tokens is a truncated done", async () => {
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"cut"}',
    "",
    'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
    "",
    "",
  ].join("\n");
  const done = (await collect(client(sse).stream([{ role: "user", content: "go" }], [], new AbortController().signal))).at(-1);
  assert.deepEqual(done, { type: "done", truncated: true, reason: "max_output_tokens" });
});

test("reasoning summary deltas map to reasoning events", async () => {
  const sse = ['data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}', "", 'data: {"type":"response.completed","response":{"status":"completed"}}', "", "", ""].join("\n");
  const events = await collect(client(sse).stream([{ role: "user", content: "go" }], [], new AbortController().signal));
  assert.deepEqual(events.find((e) => e.type === "reasoning"), { type: "reasoning", delta: "thinking" });
});

test("a response.failed throws a transport error", async () => {
  const sse = ['data: {"type":"response.failed","response":{"error":{"message":"upstream reset","code":"server_error"}}}', "", ""].join("\n");
  await assert.rejects(
    () => collect(client(sse).stream([{ role: "user", content: "go" }], [], new AbortController().signal)),
    (error: unknown) => error instanceof ModelTransportError && error.retriable === true,
  );
});

test("the request carries the bearer, account-id and beta headers", async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const model = new ChatGptModel({ baseUrl: "https://chatgpt.com/backend-api/codex", model: "gpt-5", accessToken: "AT", accountId: "acct-9", fetchImpl });
  await collect(model.stream([{ role: "user", content: "hi" }], [], new AbortController().signal));
  assert.equal(seen["authorization"], "Bearer AT");
  assert.equal(seen["chatgpt-account-id"], "acct-9");
  assert.equal(seen["openai-beta"], "responses=experimental");
});

test("frames split on the blank line and keep the remainder", () => {
  const { events, rest } = drainResponsesFrames('data: {"type":"response.created"}\n\ndata: {"type":"partial"}');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "response.created");
  assert.equal(rest, 'data: {"type":"partial"}');
});

test("a [DONE] sentinel after completion does not throw", async () => {
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"hi"}',
    "",
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  const events = await collect(client(sse).stream([{ role: "user", content: "hi" }], [], new AbortController().signal));
  assert.deepEqual(events.at(-1), { type: "done" }, "the sentinel ends the stream cleanly");
});

test("parallel function calls each keep their own arguments", async () => {
  const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const sse = [
    frame({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c0", name: "read" } }),
    frame({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "c1", name: "write" } }),
    frame({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"a":1}' }),
    frame({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"b":2}' }),
    frame({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "c0", name: "read", arguments: '{"a":1}' } }),
    frame({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "c1", name: "write", arguments: '{"b":2}' } }),
    frame({ type: "response.completed", response: { status: "completed" } }),
  ].join("");
  const calls = (await collect(client(sse).stream([{ role: "user", content: "go" }], [], new AbortController().signal))).filter((e) => e.type === "tool_call");
  assert.equal(calls.length, 2, "both calls survive");
  assert.equal(calls[0]?.type === "tool_call" && calls[0]!.tool_calls[0]!.function.arguments, '{"a":1}');
  assert.equal(calls[1]?.type === "tool_call" && calls[1]!.tool_calls[0]!.function.arguments, '{"b":2}', "the second call's args are not clobbered by the first");
});

test("a top-level error event is classified by its own code, not forced retriable", async () => {
  const sse = ['data: {"type":"error","code":"invalid_api_key","message":"bad token"}', "", ""].join("\n");
  await assert.rejects(
    () => collect(client(sse).stream([{ role: "user", content: "go" }], [], new AbortController().signal)),
    (error: unknown) => error instanceof ModelTransportError && error.retriable === false && /bad token/.test(error.message),
  );
});
