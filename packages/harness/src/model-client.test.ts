import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleModel } from "./model-client.js";
import type { ModelEvent, ToolCall } from "./types.js";

test("calls one configured endpoint and parses SSE frames", async () => {
  let requestedUrl = "";
  let authorization = "";
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"thin"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"inspect","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\""}}]}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://example.com/v1",
    apiKey: "secret",
    model: "user-model",
    fetchImpl,
  });
  const events: ModelEvent[] = [];
  for await (const event of model.stream([], [], new AbortController().signal)) events.push(event);

  assert.equal(requestedUrl, "https://example.com/v1/chat/completions");
  assert.equal(authorization, "Bearer secret");
  assert.deepEqual(events.filter((event) => event.type === "token"), [{ type: "token", delta: "hel" }]);
  const calls = events.flatMap((event) => (event.type === "tool_call" ? event.tool_calls : []));
  assert.deepEqual(calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "inspect", arguments: '{}\"x\"' },
    } satisfies ToolCall,
  ]);
  assert.ok(events.some((event) => event.type === "usage" && event.usage.total_tokens === 5));
  assert.ok(events.some((event) => event.type === "done"));
});

test("reassembles one SSE frame split across network chunks mid-JSON", async () => {
  // The full frame is `data: {"choices":[{"delta":{"content":"split ok"}}]}\n\n`
  // but it arrives in three network chunks: header + prefix, middle, tail.
  // Nothing may be emitted until the frame boundary closes; then exactly one
  // token with the complete delta must come out. No [DONE] frame is sent, so
  // the stream ends after the single frame.
  const encoder = new TextEncoder();
  const frame = 'data: {"choices":[{"delta":{"content":"split ok"}}]}\n\n';
  const chunks = [frame.slice(0, 22), frame.slice(22, 40), frame.slice(40)];
  const fetchImpl: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200 }
    );
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://example.com/v1",
    model: "m",
    fetchImpl,
  });
  const events: ModelEvent[] = [];
  for await (const event of model.stream([], [], new AbortController().signal)) events.push(event);

  assert.deepEqual(
    events.filter((event) => event.type === "token"),
    [{ type: "token", delta: "split ok" }]
  );
  assert.deepEqual(events.map((event) => event.type), ["token"]);
});
