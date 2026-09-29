import assert from "node:assert/strict";
import test from "node:test";
import { ModelTransportError, OpenAiCompatibleModel } from "./model-client.js";
import type { ModelEvent, ToolCall } from "./types.js";

test("a streamed tool call is assembled the same at every chunk boundary", async () => {
  // `ToolCallBuffer` coalesces tool-call deltas by index, and the SSE frame
  // that carries each delta is itself split by the network at arbitrary
  // points. Two deltas for one call, a second call arriving between them, and
  // a delta with no id: the result may not depend on where the chunk
  // boundaries happened to fall. The existing split test pins three specific
  // boundaries; this pins all of them.
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"shell"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls -la\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_def","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"cwd\\":\\"/tmp\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"done"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const encoder = new TextEncoder();

  const collect = async (chunks: string[]): Promise<string> => {
    const model = new OpenAiCompatibleModel({
      baseUrl: "https://example.test/v1",
      model: "m",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const calls: unknown[] = [];
    let text = "";
    for await (const event of model.stream([], [], new AbortController().signal)) {
      if (event.type === "tool_call") calls.push(...event.tool_calls);
      if (event.type === "token") text += event.delta;
    }
    return JSON.stringify({ text, calls });
  };

  const whole = await collect([frames]);
  // A call with no id still gets a stable one, and the second call stays second.
  assert.match(whole, /call_def/);

  for (const size of [1, 2, 3, 5, 7, 11, 13, 17, 23, 31, 64, 200]) {
    const chunks: string[] = [];
    for (let i = 0; i < frames.length; i += size) chunks.push(frames.slice(i, i + size));
    assert.equal(await collect(chunks), whole, `a ${size}-byte chunking assembled the calls differently`);
  }
});


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

test("content before an error frame in the same chunk is not lost", async () => {
  // One network chunk, two frames, the second of them fatal. The tokens are
  // already paid for and already on screen by the time the error arrives, so
  // buffering a chunk and yielding it only after the whole chunk had been
  // handled threw them away: the user saw a turn that produced nothing at all.
  const chunk =
    'data: {"choices":[{"delta":{"content":"half an answer"}}]}\n\n' +
    'data: {"error":{"message":"upstream reset","type":"server_error"}}\n\n';
  const encoder = new TextEncoder();
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://example.test/v1",
    model: "m",
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });

  const seen: string[] = [];
  let failure: ModelTransportError | undefined;
  try {
    for await (const event of model.stream([], [], new AbortController().signal)) {
      if (event.type === "token") seen.push(event.delta);
    }
  } catch (error) {
    assert.ok(error instanceof ModelTransportError);
    failure = error;
  }
  assert.ok(failure, "the stream must still fail");
  assert.deepEqual(seen, ["half an answer"], "the tokens that arrived first were discarded");
});

test("a rate limit is waited out for as long as the server says", async () => {
  // `Retry-After: 30` and a backoff of 1s/2s/4s: all three retries land inside
  // the window the server just described, and the turn fails having spent
  // seven seconds confirming what it was told.
  const error = await streamFailure(
    new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "30" },
    }),
  );
  assert.equal(error.retriable, true);
  assert.equal(error.retryAfterMs, 30_000);
  assert.match(error.message, /wait 30s and try again/);
  assert.ok(!/retry with backoff/i.test(error.message), `the message claims a backoff it will not use: ${error.message}`);
});

test("a reset time is read as well as a count of seconds", async () => {
  // The header is seconds per RFC 9110, and an HTTP-date in the dialect
  // several providers actually send. Both are real; neither is guessed at.
  // A real reset time, in the future, at second resolution: an HTTP-date
  // carries no milliseconds, so the read is a moment under 45s.
  const error = await streamFailure(
    new Response("{}", {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": new Date(Date.now() + 45_000).toUTCString() },
    }),
  );
  assert.ok(
    error.retryAfterMs !== undefined && error.retryAfterMs > 43_000 && error.retryAfterMs <= 45_000,
    `read a reset 45s out as ${error.retryAfterMs}`,
  );
  assert.match(error.message, /wait 45s and try again/);
});

test("a window too far out to wait for is reported, not retried into", async () => {
  // Retrying a twenty-minute window on a 1s/2s/4s backoff proves only that
  // the limit is still in force. The user is told when it lifts instead.
  const error = await streamFailure(
    new Response("{}", {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "1200" },
    }),
  );
  assert.equal(error.retriable, false);
  assert.equal(error.retryAfterMs, 1_200_000);
  assert.match(error.message, /will not keep retrying before then/);
});

test("a header that is neither a count nor a date is ignored", async () => {
  // A misread directive is worse than no directive: honouring "soon" as zero
  // is a hot loop against a server that is asking for space.
  // "-5" and "12.5.6" are the two worth naming: Date.parse turns them into
  // April 2001 and December 2006, both long past, and a past reset reads as
  // "come back immediately" — a claim about a server that said nothing.
  for (const value of ["soon", "", "-5", "12.5.6", "tomorrow"]) {
    const error = await streamFailure(
      new Response("{}", {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": value },
      }),
    );
    assert.equal(error.retryAfterMs, undefined, `read ${JSON.stringify(value)} as a wait`);
    assert.equal(error.retriable, true, "a 5xx is still retriable without a usable header");
  }
});

test("a limit that has already lifted waits zero, not an hour", async () => {
  // A clock-skewed proxy can hand back a reset time in the past. Honouring it
  // literally would be a negative sleep, which is a spin.
  const error = await streamFailure(
    new Response("{}", {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": new Date(Date.now() - 60_000).toUTCString() },
    }),
  );
  assert.equal(error.retryAfterMs, 0);
  assert.equal(error.retriable, true);
  assert.match(error.message, /wait 0s and try again/);
});

test("a 5xx with a reset hint is waited out too", async () => {
  // Retry-After is not only a rate limit: a gateway in front of a
  // restarting service says the same thing with a 503.
  const error = await streamFailure(
    new Response("upstream restarting", {
      status: 503,
      headers: { "content-type": "text/plain", "retry-after": "5" },
    }),
  );
  assert.equal(error.retriable, true);
  assert.equal(error.retryAfterMs, 5_000);
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
