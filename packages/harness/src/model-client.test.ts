import assert from "node:assert/strict";
import test from "node:test";
import { ModelTransportError, OpenAiCompatibleModel } from "./model-client.js";
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
      function: { name: "inspect", arguments: '{}"x"' },
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

test("an explicit path overrides the default chat/completions suffix", async () => {
  let requestedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    requestedUrl = String(input);
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200 },
    );
  };
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://aestral-chat.vercel.app",
    path: "/api/chat",
    model: "user-model",
    fetchImpl,
  });
  for await (const _event of model.stream([], [], new AbortController().signal)) {
    // drain
  }
  assert.equal(requestedUrl, "https://aestral-chat.vercel.app/api/chat");
});

test("a path without a leading slash still resolves against the host root", async () => {
  let requestedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    requestedUrl = String(input);
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200 },
    );
  };
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://example.com/v1",
    path: "api/chat",
    model: "user-model",
    fetchImpl,
  });
  for await (const _event of model.stream([], [], new AbortController().signal)) {
    // drain
  }
  assert.equal(requestedUrl, "https://example.com/api/chat");
});

test("omitting the path keeps the existing default", async () => {
  let requestedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    requestedUrl = String(input);
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200 },
    );
  };
  const model = new OpenAiCompatibleModel({ baseUrl: "https://example.com/v1", model: "m", fetchImpl });
  for await (const _event of model.stream([], [], new AbortController().signal)) {
    // drain
  }
  assert.equal(requestedUrl, "https://example.com/v1/chat/completions");
});

// --- failure reporting -----------------------------------------------------
//
// An HTML body used to be pasted into the transcript verbatim, 600 characters
// of markup with no status and no endpoint, which identified nothing. These
// pin the diagnosis instead.

const HTML_PAGE = `<!DOCTYPE html><html lang="en"><head><title>500</title></head><body><h1>Internal Server Error</h1></body></html>`;

function failureResponse(
  status: number,
  body: string,
  contentType: string | null,
  statusText = "",
): Response {
  return new Response(body, {
    status,
    statusText,
    ...(contentType ? { headers: { "content-type": contentType } } : {}),
  });
}

async function streamFailure(response: Response): Promise<ModelTransportError> {
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://example.test",
    path: "/api/chat",
    model: "m",
    fetchImpl: async () => response,
  });
  try {
    for await (const _ of model.stream([{ role: "user", content: "hey" }], [], new AbortController().signal)) {
      // drain
    }
  } catch (error) {
    assert.ok(error instanceof ModelTransportError, `expected a transport error, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the stream to fail");
}

test("an HTML error page is summarised, never quoted", async () => {
  const error = await streamFailure(failureResponse(500, HTML_PAGE, "text/html", "Internal Server Error"));
  assert.ok(!error.message.includes("<"), `markup leaked into the message: ${error.message}`);
  assert.ok(!error.message.includes("DOCTYPE"), "markup leaked into the message");
  assert.match(error.message, /HTTP 500/);
  assert.match(error.message, /https:\/\/example\.test\/api\/chat/);
  assert.match(error.message, /HTML error page/);
  assert.equal(error.retriable, true);
});

test("the closing advice matches whether the failure will actually be retried", async () => {
  // Telling someone a 403 will be retried when it will not is worse than
  // silence: they sit waiting for a retry that never comes.
  const server = await streamFailure(failureResponse(503, HTML_PAGE, "text/html"));
  assert.match(server.message, /retry with backoff/i);

  const client = await streamFailure(failureResponse(403, HTML_PAGE, "text/html", "Forbidden"));
  assert.equal(client.retriable, false);
  assert.match(client.message, /Retrying will not help/);
  assert.ok(!/retry with backoff/i.test(client.message), `a non-retriable error promised a retry: ${client.message}`);
});

test("a 200 carrying HTML fails loudly instead of answering nothing", async () => {
  // Read as a stream this has no `data:` frames, so the turn produced no
  // answer, no tool call and no error at all — a silent empty reply.
  const error = await streamFailure(failureResponse(200, HTML_PAGE, "text/html"));
  assert.match(error.message, /not an event stream/);
  assert.equal(error.retriable, true);
});

test("a wrong content-type does not hide an HTML body", async () => {
  // A declared `text/plain` is not evidence; the body is. Gateways answer error
  // pages as plain text all the time.
  const error = await streamFailure(failureResponse(200, HTML_PAGE, "text/plain;charset=UTF-8"));
  assert.match(error.message, /not an event stream/);
});

test("a real JSON error is still reported verbatim", async () => {
  const error = await streamFailure(
    failureResponse(400, JSON.stringify({ error: { message: "model not found" } }), "application/json"),
  );
  assert.match(error.message, /model not found/);
  assert.match(error.message, /HTTP 400/);
});

test("a short plain-text body is kept, a malformed document is not quoted", async () => {
  const plain = await streamFailure(failureResponse(500, "upstream connect error", "text/plain"));
  assert.match(plain.message, /upstream connect error/);

  // A truncated JSON document is a symptom, not a message.
  const broken = await streamFailure(failureResponse(400, "{not json", "application/json"));
  assert.ok(!broken.message.includes("{not json"), `quoted a broken document: ${broken.message}`);
  assert.match(broken.message, /not a usable error/);
});

test("an empty body is described as empty rather than guessed at", async () => {
  const error = await streamFailure(failureResponse(502, "", "text/plain", "Bad Gateway"));
  assert.match(error.message, /empty body/);
});

test("an endpoint that genuinely streams is never second-guessed", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://example.test",
    path: "/api/chat",
    model: "m",
    fetchImpl: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
  });
  let text = "";
  for await (const event of model.stream([{ role: "user", content: "hi" }], [], new AbortController().signal)) {
    if (event.type === "token") text += event.delta;
  }
  assert.equal(text, "hi");
});

// --- errors delivered inside a 200 --------------------------------------
//
// A stream that reports its own failure arrives as `data: {"error": {...}}`
// with a 200 status, so nothing about the response says how bad it is. These
// pin both halves of that decision: a deterministic failure is not replayed,
// and a transient one still is.

/** A 200 event stream whose only frame is an in-stream error. */
function errorStream(payload: unknown): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("an in-stream context overflow is not retried", async () => {
  // The exact request is going to be sent again, so the exact failure comes
  // back: three more attempts, four times the tokens, and the same error at
  // the end of it.
  const error = await streamFailure(
    errorStream({
      error: {
        message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 90211 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    }),
  );
  assert.equal(error.retriable, false);
  assert.match(error.message, /maximum context length/, "the provider's own diagnosis was dropped");
  assert.match(error.message, /context window/, "the overflow advice is missing");
  assert.ok(!/retry with backoff/i.test(error.message), `a will-not-be-retried error promised a retry: ${error.message}`);
});

test("an overflow sent as a bare message is recognised without a code", async () => {
  // Anthropic and every self-hosted server say it in prose and send no code.
  const anthropic = await streamFailure(
    errorStream({ error: { message: "prompt is too long: 137500 tokens > 135000 maximum", type: "invalid_request_error" } }),
  );
  assert.equal(anthropic.retriable, false);

  // The diagnosis lives in the code on OpenAI; the message is a request to
  // shorten the conversation.
  const openai = await streamFailure(
    errorStream({ error: { message: "Please reduce the length of the messages.", code: "context_length_exceeded" } }),
  );
  assert.equal(openai.retriable, false);

  // No code, no type, prose only: still the one failure a retry cannot fix.
  const bare = await streamFailure(errorStream({ error: "Requested token count exceeds the model's maximum context length" }));
  assert.equal(bare.retriable, false);
  assert.match(bare.message, /ended the stream with an error/);
});

test("a transient in-stream error is still retried", async () => {
  // The default matters as much as the exception: a stream that died
  // mid-flight is usually a dropped connection, and calling that permanent
  // would refuse to start the turn at all.
  const dropped = await streamFailure(
    errorStream({ error: { message: "upstream connection reset by peer", type: "server_error" } }),
  );
  assert.equal(dropped.retriable, true);
  assert.match(dropped.message, /retry with backoff/i);

  // A rate limit is the canonical in-stream error, and the reason the shape
  // exists at all: retriable, and the code has to win over the wording.
  const limited = await streamFailure(
    errorStream({ error: { message: "Rate limit reached for requests", type: "rate_limit_error", code: "rate_limit_exceeded" } }),
  );
  assert.equal(limited.retriable, true);
});

test("an account failure delivered in-stream is not retried", async () => {
  const quota = await streamFailure(
    errorStream({ error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }),
  );
  assert.equal(quota.retriable, false);

  // A gateway that rejects the key mid-stream is the same shape and the same
  // verdict: three more attempts cannot make the key valid.
  const key = await streamFailure(errorStream({ error: { message: "Invalid API key provided", type: "authentication_error" } }));
  assert.equal(key.retriable, false);
  assert.match(key.message, /Retrying will not help/);
});

test("an in-stream error names the endpoint and the retry decision", async () => {
  // Two endpoints can be configured; a bare provider sentence identifies
  // neither, and the old behaviour said nothing about what happens next.
  const error = await streamFailure(errorStream({ error: { message: "something upstream", type: "server_error" } }));
  assert.match(error.message, /https:\/\/example\.test\/api\/chat/);
  assert.match(error.message, /retry with backoff/i);
});

test("an error frame with no text is a failure, not silence", async () => {
  // `{"error": {}}` carries no message. Reported as nothing at all, the
  // stream ends, the turn finishes with no answer and no tool call, and the
  // user sees a turn that did nothing for no stated reason — the same
  // silent empty answer a 200 carrying HTML produces.
  const error = await streamFailure(errorStream({ error: {} }));
  assert.match(error.message, /ended the stream with an error and gave no message/);
  assert.equal(error.retriable, true);
});

test("a key passed in the query string never reaches an error message", async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://example.test/v1",
    path: "/api/chat",
    model: "m",
    apiKey: "sk-super-secret",
    fetchImpl: async () => failureResponse(500, HTML_PAGE, "text/html"),
  });
  try {
    for await (const _ of model.stream([], [], new AbortController().signal)) {
      // drain
    }
  } catch (error) {
    assert.ok(!(error as Error).message.includes("sk-super-secret"), "the key leaked into the message");
  }
});
