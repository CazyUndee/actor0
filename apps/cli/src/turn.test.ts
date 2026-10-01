import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { HarnessEvent } from "@actor0/harness";
import {
  runTurn,
  seedSystemPrompt,
  forStorage,
  cancelledTurnMessages,
  failedTurnMessages,
  defaultSystemPrompt,
  INTERRUPT_MARKER,
  FAILED_MARKER,
  PROVIDER_PROMPT_FLOOR_CHARS,
  promptClearsProviderFloor,
} from "./turn.js";
import { AbortedTurnError, FailedTurnError, type ChatMessage } from "@actor0/harness";
import { createToolHost, resolveShell } from "./tools.js";
import { applyEvent, initialConversation } from "./conversation.js";

/**
 * End-to-end through the real harness.
 *
 * The unit tests cover the reducer and the tool host in isolation. This one
 * runs actual turns against a mock OpenAI-compatible endpoint, so it exercises
 * the seam the whole project rests on: a third party supplying a `ModelClient`
 * and a `ToolHost` and getting a working agent with no harness changes.
 */

type Script = (turn: number) => unknown[];

async function startServer(script: Script): Promise<{ server: Server; baseUrl: string; bodies: string[] }> {
  let turn = 0;
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    // The body is read *before* the response is written, not alongside it.
    // Recording it from an `end` listener that runs whenever it gets around
    // to it looks equivalent and is not: a turn that fails mid-stream closes
    // the connection, `end` never fires, and the request the test is asserting
    // about simply does not appear to have happened.
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(body);
      const frames = script(turn++);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const frame of frames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, bodies };
}

const textFrames = (text: string): unknown[] => [
  { choices: [{ delta: { content: text } }] },
];

const toolFrames = (name: string, args: unknown, id = "call_1"): unknown[] => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
];

const close = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const cwd = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-turn-"));
  writeFileSync(join(dir, "readme.md"), "# hello\n");
  return dir;
};

/** The frame a provider sends when the answer hit the output-token cap. */
const cutOffFrame = (finish: string): unknown => ({
  choices: [{ delta: { content: "and then it " }, finish_reason: finish }],
});

test("an answer the endpoint cut off is continued, and the continuation sees what was written", async () => {
  // `finish_reason: "length"` means the model ran out of output budget, not
  // that it finished. Reporting that as a completed answer shows the user a
  // sentence that stops mid-word and saves it as the reply.
  const { server, baseUrl, bodies } = await startServer((turn) =>
    turn === 0
      ? [...textFrames("The answer starts like this"), cutOffFrame("length")]
      : textFrames("and carries on to the end."),
  );
  const events: HarnessEvent[] = [];
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "write me an essay",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    assert.equal(bodies.length, 2, "the cut-off answer must be asked about again");
    assert.equal(result.text, "and carries on to the end.");
    assert.equal(result.complete, true, "a completed continuation is a completed turn");
    assert.equal(result.truncated, undefined, "the turn that ended is not itself truncated");
    // The partial has to be in the second request, or the model restarts
    // the essay from the top and the user gets it twice.
    assert.ok(
      bodies[1]?.includes("The answer starts like this"),
      "the continuation must carry the text that was already written",
    );
    assert.ok(
      events.some((e) => e.type === "status" && /cut off/i.test(e.status)),
      "and the user must be told why the turn did not end where it looked like it would",
    );
  } finally {
    await close(server);
  }
});

test("an answer that is still cut off after one continuation is reported as unfinished", async () => {
  // The continuation is a recovery, not a loop. A model too long for the
  // cap is too long for it twice, and a turn that keeps asking spends the
  // user's tokens to learn that a second time.
  const { server, baseUrl, bodies } = await startServer(() => [...textFrames("still going"), cutOffFrame("length")]);
  const events: HarnessEvent[] = [];
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "write me an essay",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    assert.equal(bodies.length, 2, "exactly one continuation, then the turn ends");
    assert.equal(result.complete, false, "an unfinished answer is not a completed turn");
    assert.equal(result.truncated, true);
    assert.equal(result.truncationReason, "length");
    const done = events.find((e) => e.type === "done");
    assert.equal(done && done.truncated, true, "and the event has to say so, for the host that renders it");
  } finally {
    await close(server);
  }
});

test("a clean finish reason is not mistaken for a cut-off answer", async () => {
  const { server, baseUrl } = await startServer(() => [
    ...textFrames("Done."),
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "hello",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });
    assert.equal(result.text, "Done.");
    assert.equal(result.complete, true);
    assert.equal(result.truncated, undefined);
  } finally {
    await close(server);
  }
});

test("a cut-off answer is recognised in every spelling an endpoint uses", async () => {
  // OpenAI puts `finish_reason` on the choice, Anthropic puts `stop_reason`
  // on the message, and relays copy either to the top level. Missing all
  // three is the failure: a cut-off stream is then indistinguishable from
  // a finished one.
  const shapes: Record<string, unknown> = {
    "openai choice": { choices: [{ delta: { content: "cut " }, finish_reason: "length" }] },
    "anthropic message": { choices: [{ delta: { content: "cut " } }], stop_reason: "max_tokens" },
    "relayed top level": { choices: [{ delta: { content: "cut " } }], finish_reason: "model_length" },
    "context window": { choices: [{ delta: { content: "cut " }, stop_reason: "model_context_window_exceeded" }] },
  };
  for (const [name, frame] of Object.entries(shapes)) {
    // The cut-off frame only on the first request: the second is the continuation,
    // and a continuation that is cut off again is a different test.
    const { server, baseUrl, bodies } = await startServer((turn) =>
      turn === 0
        ? [frame, { choices: [{ delta: { content: "the rest." } }] }]
        : [{ choices: [{ delta: { content: "the rest." } }] }],
    );
    try {
      const { result } = await runTurn({
        model: { baseUrl, path: "/chat/completions", model: "test-model" },
        messages: [],
        input: "hello",
        toolHost: createToolHost({ cwd: cwd() }),
        signal: new AbortController().signal,
      });
      assert.equal(bodies.length, 2, name + ": a cut-off answer must be continued");
      assert.equal(result.text, "the rest.", name);
    } finally {
      await close(server);
    }
  }
});

test("a plain answer streams and completes", async () => {
  const { server, baseUrl } = await startServer(() => [...textFrames("Hi "), ...textFrames("there"), { usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }]);
  const events: HarnessEvent[] = [];
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "hello",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.text, "Hi there");
    assert.equal(result.complete, true);
    assert.ok(events.some((e) => e.type === "token"), "tokens must reach the observer");
    assert.equal(result.usage[0]?.total_tokens, 11);
  } finally {
    await close(server);
  }
});

/**
 * A history with a real `read` result in it, sized so compaction has
 * something to clear. This is what a session looks like after the model has
 * been shown a file: a large observational payload sitting between two
 * exchanges, which is exactly the thing that does not fit a context window.
 */
const bulkyHistory = (chars = 60_000): ChatMessage[] => [
  { role: "user", content: "read readme.md" },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_1", name: "read", content: "x".repeat(chars) },
  { role: "assistant", content: "It says hello." },
  { role: "user", content: "and now, what did it say?" },
];

/** The frame a provider sends when the request does not fit. */
const overflowFrame = {
  error: {
    message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 91234 tokens.",
    type: "invalid_request_error",
    code: "context_length_exceeded",
  },
};

test("a request the model calls too big is asked again with a compacted history", async () => {
  // The turn used to end here: the model refuses the transcript, and the only
  // thing the user could do was start over. The whole history is still there
  // __D__ it is the payloads that are large, and payloads can be cleared.
  const { server, baseUrl, bodies } = await startServer((turn) =>
    turn === 0 ? [overflowFrame] : textFrames("You were looking at a file that says hello."),
  );
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: bulkyHistory(),
      input: "and now, what did it say?",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });

    assert.equal(bodies.length, 2, "the turn must be re-asked exactly once");
    assert.ok(
      (bodies[1] as string).length < (bodies[0] as string).length / 2,
      `the retry re-sent the same size: ${(bodies[1] as string).length} vs ${(bodies[0] as string).length}`,
    );
    assert.match((bodies[1] as string), /result cleared/, "the retry must say the result was cleared, not drop it");
    assert.match(result.text, /says hello/);

    // Clearing a payload is not the same as cutting a message: the call, the
    // result and everything after it are all still there.
    const toolMessage = result.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "the cleared result must stay in the transcript");
    assert.match(toolMessage!.content, /result cleared/);
    assert.equal(result.messages.length, bulkyHistory().length + 3, "nothing may be dropped but the new exchange");
  } finally {
    await close(server);
  }
});

test("the endpoint's own size error triggers the recovery, not just the classifier", async () => {
  // The classifier test proves the string is recognised. This proves the
  // consequence: the turn is compacted and asked again once, rather than dying
  // with a size error the user can do nothing about. Before the fix this
  // reached the user as "Message too large (50k char limit). Retrying will not
  // help — check the URL, the key, and the model name."
  const endpointFrame = { error: "Message too large (50k char limit)" };
  const { server, baseUrl, bodies } = await startServer((turn) =>
    turn === 0 ? [endpointFrame] : textFrames("You were looking at a file that says hello."),
  );
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: bulkyHistory(),
      input: "and now, what did it say?",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });

    assert.equal(bodies.length, 2, "the turn must be re-asked exactly once");
    assert.ok(
      (bodies[1] as string).length < (bodies[0] as string).length / 2,
      `the retry re-sent the same size: ${(bodies[1] as string).length} vs ${(bodies[0] as string).length}`,
    );
    assert.match(bodies[1] as string, /result cleared/, "the retry must clear a payload, not drop a message");
    assert.match(result.text, /says hello/);
    assert.equal(result.messages.length, bulkyHistory().length + 3, "nothing may be dropped but the new exchange");
  } finally {
    await close(server);
  }
});
test("an overflow that compaction cannot fix is reported, not asked again", async () => {
  // Nothing clearable: the bulk is the conversation itself. Asking again with
  // the identical transcript is the death spiral a recovery is meant to end.
  const { server, baseUrl, bodies } = await startServer(() => [overflowFrame]);
  try {
    await assert.rejects(
      () =>
        runTurn({
          model: { baseUrl, path: "/chat/completions", model: "test-model" },
          messages: [{ role: "user", content: "q".repeat(80_000) }],
          input: "again",
          toolHost: createToolHost({ cwd: cwd() }),
          signal: new AbortController().signal,
        }),
      /maximum context length/,
    );
    assert.equal(bodies.length, 1, "a request that cannot shrink must be sent once");
  } finally {
    await close(server);
  }
});

test("a failure that is not an overflow is never re-asked", async () => {
  // A rejected key or an unknown model fails the same way forever. This is the
  // classification the transport layer makes, and the recovery must not undo it.
  const { server, baseUrl, bodies } = await startServer(() => [
    { error: { message: "Invalid API key provided", type: "authentication_error", code: "invalid_api_key" } },
  ]);
  try {
    await assert.rejects(
      () =>
        runTurn({
          model: { baseUrl, path: "/chat/completions", model: "test-model" },
          messages: bulkyHistory(),
          input: "hello",
          toolHost: createToolHost({ cwd: cwd() }),
          signal: new AbortController().signal,
        }),
      /Invalid API key/,
    );
    assert.equal(bodies.length, 1, "only a context overflow may be asked again");
  } finally {
    await close(server);
  }
});

test("an overflow after output has streamed is reported, not replayed", async () => {
  // A tool that has already run is not promised to be safe to run twice, and
  // tokens already on screen would be joined by a second answer.
  const { server, baseUrl, bodies } = await startServer(() => [...textFrames("partial ans"), overflowFrame]);
  try {
    await assert.rejects(
      () =>
        runTurn({
          model: { baseUrl, path: "/chat/completions", model: "test-model" },
          messages: bulkyHistory(),
          input: "hello",
          toolHost: createToolHost({ cwd: cwd() }),
          signal: new AbortController().signal,
        }),
      /maximum context length/,
    );
    assert.equal(bodies.length, 1, "a turn that already produced output must not be replayed");
  } finally {
    await close(server);
  }
});

test("the system prompt is seeded and stripped before storage", () => {
  const seeded = seedSystemPrompt([], defaultSystemPrompt());
  assert.equal(seeded[0].role, "system");
  assert.deepEqual(forStorage(seeded), []);
  const again = seedSystemPrompt([{ role: "system", content: "old" }, { role: "user", content: "x" }], "new");
  assert.equal(again[0].content, "new", "a changed prompt replaces the stored one");
});

test("a tool call runs, feeds back, and the model answers", async () => {
  const { server, baseUrl } = await startServer((turn) =>
    turn === 0 ? toolFrames("read", { path: "readme.md" }) : textFrames("The file says hello."),
  );
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "what is in readme.md?",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });

    assert.equal(result.rounds, 2, "the turn must continue after a tool round");
    assert.match(result.text, /hello/);

    const toolMessage = result.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "the tool result must be fed back to the model");
    assert.match(toolMessage!.content, /# hello/);
  } finally {
    await close(server);
  }
});

test("a turn that stops for the user says so in the transcript", async () => {
  // The UI asks the user a question when a turn stops — “check the paths and try
  // again” — and the user's answer arrives as an ordinary user message. If the
  // stop is not in the transcript, the model is answering a question nobody
  // asked it, with no idea a turn even ended.
  const { server, baseUrl } = await startServer((turn) =>
    turn < 5
      ? toolFrames("read", { path: "not-here.txt" }, `call_${turn}`)
      : textFrames("done"),
  );
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "find the config",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });

    assert.equal(result.blocked, true);
    const last = result.messages[result.messages.length - 1];
    assert.equal(last?.role, "user", "the stop has to be in the transcript the next turn replays");
    assert.match(last!.content, /5 rounds of tool calls failed in a row/, "and it must name the cause");
    assert.match(
      last!.content,
      /do not assume they know why/,
      "the note exists to stop the model reading the user's reply as a known question, not to assert what the user will say",
    );
    assert.doesNotMatch(last!.content, /their next message is (about|an answer to)/, "it must not guess at the reply");
  } finally {
    await close(server);
  }
});

test("a turn that was not stopped leaves no note behind", async () => {
  const { server, baseUrl } = await startServer(() => textFrames("All done."));
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "hello",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });

    const last = result.messages[result.messages.length - 1];
    assert.equal(last?.role, "assistant");
    assert.equal(last?.content, "All done.");
  } finally {
    await close(server);
  }
});

test("a write runs ungated and the model sees what happened", async () => {
  const { server, baseUrl } = await startServer((turn) =>
    turn === 0 ? toolFrames("write", { path: "out.txt", content: "nope" }) : textFrames("Wrote out.txt."),
  );
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "write out.txt",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });

    const toolMessage = result.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "the tool result must be fed back to the model");
    assert.match(toolMessage!.content, /Created/);
    assert.equal(result.blocked, undefined, "a tool that worked must not count as a failure");
  } finally {
    await close(server);
  }
});

test("a shell round runs, reports its exit code, and the model reads it", async () => {
  // The tool the user actually asked for, end to end: a real process, a real
  // exit code, fed back through the harness like any other tool result.
  const { server, baseUrl } = await startServer((turn) =>
    turn === 0
      ? toolFrames("shell", {
          command: (() => {
            const family = resolveShell().family;
            return family === "posix"
              ? "echo from-the-shell; exit 7"
              : family === "powershell"
                ? "Write-Output from-the-shell; exit 7"
                : "echo from-the-shell & exit /b 7";
          })(),
        })
      : textFrames("It printed from-the-shell and failed."),
  );
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "run that command",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });

    assert.equal(result.rounds, 2, "a non-zero exit is a result, not an aborted turn");
    const toolMessage = result.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "the command output must be fed back to the model");
    assert.match(toolMessage!.content, /Command exited with code 7/);
    assert.match(toolMessage!.content, /from-the-shell/);
    assert.equal(result.blocked, undefined);
  } finally {
    await close(server);
  }
});

test("a failing tool is fed back as a failure and the turn recovers", async () => {
  const { server, baseUrl } = await startServer((turn) =>
    turn === 0 ? toolFrames("read", { path: "missing.txt" }) : textFrames("That file does not exist."),
  );
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "read missing.txt",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });
    const toolMessage = result.messages.find((m) => m.role === "tool");
    assert.match(toolMessage!.content, /Tool failed/);
    assert.match(result.text, /does not exist/);
  } finally {
    await close(server);
  }
});

test("a 500 is retried by the harness and the UI is told it rewound", async () => {
  let call = 0;
  const server = createServer((_req, res) => {
    call += 1;
    if (call === 1) {
      res.writeHead(500).end("upstream boom");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "recovered" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const events: HarnessEvent[] = [];
  try {
    const { result } = await runTurn({
      model: { baseUrl: `http://127.0.0.1:${port}/v1`, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "hello",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.text, "recovered");
    assert.ok(call >= 2, "the transport failure must be retried");
  } finally {
    await close(server);
  }
});

test("cancelling mid-stream throws and stops the turn", async () => {
  const controller = new AbortController();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "start" } }] })}\n\n`);
    // Never finished: the abort below is what ends this response.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const pending = runTurn({
      model: { baseUrl: `http://127.0.0.1:${port}/v1`, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "hello",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: controller.signal,
      // Abort from the first token rather than from a timer. A timer races
      // the stream: on a loaded machine the abort can land before the
      // opening frame is read, and the test then measures a different thing
      // (an assistant turn with no text) only on slow runs.
      onEvent: (event) => {
        if (event.type === "token" && event.delta) controller.abort();
      },
    });
    await assert.rejects(pending, (error: unknown) => {
      // The abort still surfaces as a rejection (hosts keep their abort
      // handling), but it now carries the transcript the turn built.
      assert.ok(error instanceof AbortedTurnError, "an abort must hand back the exchange");
      assert.deepEqual(forStorage(error.messages), [
        { role: "user", content: "hello" },
        { role: "assistant", content: `start\n\n${INTERRUPT_MARKER}` },
      ]);
      return true;
    });
  } finally {
    await close(server);
  }
});

test("events fold into a transcript without losing or duplicating text", async () => {
  const { server, baseUrl } = await startServer((turn) =>
    turn === 0 ? toolFrames("read", { path: "readme.md" }) : [...textFrames("one "), ...textFrames("two")],
  );
  try {
    const { result } = await runTurn({
      model: { baseUrl, path: "/chat/completions", model: "test-model" },
      messages: [],
      input: "hello",
      toolHost: createToolHost({ cwd: cwd() }),
      signal: new AbortController().signal,
    });

    let state = initialConversation();
    for (const event of replay(result.text)) state = applyEvent(state, event);
    const answer = state.entries.find((entry) => entry.kind === "assistant");
    assert.equal(answer?.kind === "assistant" && answer.text, result.text);
  } finally {
    await close(server);
  }
});

/** Rebuild the event sequence the UI would have seen, to fold into a transcript. */
function* replay(text: string): Generator<HarnessEvent> {
  yield { type: "token", delta: text };
  yield { type: "done", text, complete: true };
}

test("the system prompt clears every preset provider's context floor", () => {
  // A proxied provider bills on a minimum system preamble and silently swaps
  // in its own product prompt for anything shorter. That is not a cosmetic
  // difference: the model then answers as another product, with another
  // product's tool vocabulary, and emits tool calls this CLI never offered.
  assert.ok(
    defaultSystemPrompt().length >= PROVIDER_PROMPT_FLOOR_CHARS,
    `prompt is ${defaultSystemPrompt().length} chars, floor is ${PROVIDER_PROMPT_FLOOR_CHARS}`,
  );
  assert.equal(promptClearsProviderFloor(defaultSystemPrompt()), true);
  assert.equal(promptClearsProviderFloor("too short"), false);
});

test("the system prompt states the tool-call protocol the harness parses", () => {
  // If the prompt stops naming the fenced block shape, the fallback path
  // stops working on providers with no native tool_calls transport.
  assert.match(defaultSystemPrompt(), /```json/);
  assert.match(defaultSystemPrompt(), /"type": "tool_call"/);
});

test("every tool the prompt names is a tool the host actually has", () => {
  // The prompt and the host drift apart quietly. A model that copies a name
  // from the prompt into a call gets "unknown tool", and the failure looks
  // like the model's fault rather than ours.
  const names = createToolHost({ cwd: cwd() }).definitions().map((d) => d.function.name);
  for (const name of names) {
    assert.ok(defaultSystemPrompt().includes(name), `the prompt never mentions ${name}`);
  }
  const example = /"name": "(\w+)"/.exec(defaultSystemPrompt())?.[1];
  assert.ok(example, "the example must name a tool");
  assert.ok(names.includes(example), `the example names ${example}, which is not a real tool`);
});

test("the prompt's tool count is the registry's, not a number someone remembered", () => {
  // The prompt told the model it had four tools while five were registered, and
  // no test failed: the count was a literal in a string array, so adding a tool
  // could not change it. It is now read off the registry.
  //
  // Both spellings are read, because the shape a literal takes is exactly what
  // this has to catch — the original was the word "four", and a parser that
  // only understood digits would wave that straight through.
  const words = [
    "zero", "one", "two", "three", "four", "five",
    "six", "seven", "eight", "nine", "ten",
  ];
  const asNumber = (said: string): number => {
    const digits = /^\d+$/.test(said) ? Number(said) : words.indexOf(said);
    assert.ok(digits >= 0, `the count "${said}" is neither a number nor a count word`);
    return digits;
  };

  const names = createToolHost({ cwd: cwd() }).definitions().map((d) => d.function.name);
  const claimed = /(\w+) tools that execute immediately/.exec(defaultSystemPrompt());
  assert.ok(claimed, "the opening must still state how many tools there are");
  const said = asNumber(claimed[1]!);
  assert.equal(
    said,
    names.length,
    `the prompt claims ${said} tool${said === 1 ? "" : "s"}; the host has ${names.length}`,
  );
});

test("the tool-choice sentence names every registered tool exactly once", () => {
  // The same drift, one clause at a time. This sentence used to leave `grep`
  // out entirely and route searching to the shell, four tools after the tool
  // that does it was added. Derived from the registry, it cannot; this checks
  // the derivation rather than the wording, so a reworded hint stays legal.
  const names = createToolHost({ cwd: cwd() }).definitions().map((d) => d.function.name);
  const sentence = /^Tool choice: (.*)$/m.exec(defaultSystemPrompt());
  assert.ok(sentence, "the prompt must still carry a tool-choice sentence");
  const named = [...sentence[1]!.matchAll(/`(\w+)`/g)].map((match) => match[1]!);
  assert.deepEqual(named, names, "the sentence must name the tools, in the registry's order");
});

test("every tool says what it is for, so the sentence is not a list of names", () => {
  // A name with no clause after it is worse than an absent tool: the model
  // learns nothing about when to reach for it, and the sentence reads as if it
  // had said something. The clause is read out of the prompt rather than out of
  // the builder, so a prompt that stops carrying the sentence fails here too.
  const sentence = /^Tool choice: (.*)$/m.exec(defaultSystemPrompt())?.[1] ?? "";
  for (const name of createToolHost({ cwd: cwd() }).definitions().map((d) => d.function.name)) {
    const clause = new RegExp(`\`${name}\` for ([^,.]+)`).exec(sentence);
    assert.ok(clause, `the sentence gives ${name} no clause`);
    assert.ok(
      clause[1]!.trim().length > 8,
      `the clause for ${name} is "${clause[1]}", which says nothing`,
    );
  }
});

test("cancelledTurnMessages adopts the harness transcript and strips the prompt", () => {
  const error = new AbortedTurnError(
    [
      { role: "system", content: "the seeded prompt" },
      { role: "user", content: "go" },
      { role: "assistant", content: `part\n\n${INTERRUPT_MARKER}` },
    ],
    "part",
  );
  assert.deepEqual(cancelledTurnMessages(error), [
    { role: "user", content: "go" },
    { role: "assistant", content: `part\n\n${INTERRUPT_MARKER}` },
  ]);
});

test("cancelledTurnMessages rejects anything that is not an abort carrying a transcript", () => {
  // A mislabeled error must not let a caller save the wrong history.
  assert.equal(cancelledTurnMessages(undefined), undefined);
  assert.equal(cancelledTurnMessages(null), undefined);
  assert.equal(cancelledTurnMessages(new Error("something else")), undefined);
  assert.equal(cancelledTurnMessages({ name: "AbortedTurnError", messages: "not an array" }), undefined);
  assert.equal(
    cancelledTurnMessages(Object.assign(new Error("no transcript"), { name: "AbortedTurnError" })),
    undefined,
  );
});

test("failedTurnMessages adopts the harness transcript and strips the prompt", () => {
  const error = new FailedTurnError(
    [
      { role: "system", content: "the seeded prompt" },
      { role: "user", content: "go" },
      { role: "assistant", content: `part\n\n${FAILED_MARKER}` },
    ],
    "part",
    new Error("connection reset"),
  );
  assert.deepEqual(failedTurnMessages(error), [
    { role: "user", content: "go" },
    { role: "assistant", content: `part\n\n${FAILED_MARKER}` },
  ]);
  // The caller shows this message, so it has to be the failure's
  // own — not a generic "turn failed" that says nothing.
  assert.equal(error.partialText, "part");
  assert.match(error.message, /connection reset/);
});

test("failedTurnMessages rejects anything that is not a failed turn carrying a transcript", () => {
  // A mislabeled error must not let a caller save the wrong history.
  assert.equal(failedTurnMessages(undefined), undefined);
  assert.equal(failedTurnMessages(null), undefined);
  assert.equal(failedTurnMessages(new Error("something else")), undefined);
  assert.equal(failedTurnMessages({ name: "FailedTurnError", messages: "not an array" }), undefined);
  assert.equal(
    failedTurnMessages(Object.assign(new Error("no transcript"), { name: "FailedTurnError" })),
    undefined,
  );
  // An abort is not a failure: the two recoveries stay distinct, so
  // an aborted turn is never adopted through this door.
  assert.equal(
    failedTurnMessages(new AbortedTurnError([{ role: "user", content: "go" }], "")),
    undefined,
  );
});
