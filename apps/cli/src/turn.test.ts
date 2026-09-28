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
  defaultSystemPrompt,
  PROVIDER_PROMPT_FLOOR_CHARS,
  promptClearsProviderFloor,
} from "./turn.js";
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

async function startServer(script: Script): Promise<{ server: Server; baseUrl: string }> {
  let turn = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const frames = script(turn++);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const frame of frames) {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
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
    });
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
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
