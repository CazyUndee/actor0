import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { OpenAiCompatibleModel, ModelTransportError, FAILED_MARKER, TRUNCATED_MARKER, type ModelClient } from "@actor0/harness";
import { runPrintTurn } from "./print.js";
import { loadSession } from "./session.js";
import { sessionsDir } from "./paths.js";

/**
 * The headless contract, against the same mock-endpoint trick the TUI's
 * turn.test.ts uses. Two behaviors are load-bearing for scripts and CI:
 *
 *  - what lands on stdout is the answer and nothing else (progress and errors
 *    go to stderr, or `actor0 -p … > out.txt` captures the wrong thing);
 *  - a run against a restored session is not amnesiac: the exchange is written
 *    back, on success and interrupt alike. A stateless one-shot stays
 *    stateless, which is what a pipe wants.
 */

const config = { model: "test-model", models: [] };

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-print-"));
  process.env.ACTOR0_DATA_DIR = dir;
  return dir;
};

async function startServer(frames: unknown[]): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

const close = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const endpointClient = (baseUrl: string): ModelClient =>
  new OpenAiCompatibleModel({ baseUrl, path: "/chat/completions", model: "test-model" });

/** A client that streams `text` and then never finishes; the abort ends it. */
function endlessClient(text: string, controller: AbortController): ModelClient {
  return {
    async *stream() {
      yield { type: "token" as const, delta: text };
      await new Promise((_resolve, reject) => {
        // Listen before aborting: an already-aborted signal never dispatches
        // to a listener added afterwards, and waiting on one hangs the test.
        controller.signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
        setTimeout(() => controller.abort(), 50).unref();
      });
    },
  };
}

/** Capture the answer stream through the injected sink, not the real stdout —
 * patching the real stream inside a `node:test` process intercepts the
 * runner's own reporter and reads back as garbage. */
async function capture(run: (out: { write(chunk: string): void }) => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const code = await run({ write: (chunk: string) => (chunks.push(chunk), true) });
  return { code, out: chunks.join("") };
}

/** Both sinks at once: a turn that says nothing at all is the bug being
 * pinned, so the channels it *should* have spoken on have to be readable. */
async function captureBoth(
  run: (sinks: { out: { write(chunk: string): void }; err: { write(chunk: string): void } }) => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run({
    out: { write: (chunk: string) => (out.push(chunk), true) },
    err: { write: (chunk: string) => (err.push(chunk), true) },
  });
  return { code, out: out.join(""), err: err.join("") };
}

/**
 * A model that never answers: every round is a tool call and a `glob` that
 * matches nothing, which is what a long sweep looks like from the outside.
 * The turn then ends on its tool-round budget with no prose at all.
 */
function toolOnlyClient(text?: string): ModelClient {
  let round = 0;
  return {
    async *stream() {
      round += 1;
      if (text) yield { type: "token" as const, delta: text };
      yield {
        type: "tool_call" as const,
        tool_calls: [
          {
            id: `call_${round}`,
            type: "function" as const,
            function: { name: "glob", arguments: JSON.stringify({ pattern: "no-such-file-*" }) },
          },
        ],
      };
    },
  };
}

/** A model whose answer never fits, twice: the turn truncates and stops. */
function truncatedClient(): ModelClient {
  let round = 0;
  const halves = ["the first half", "and the rest of it"];
  return {
    async *stream() {
      const text = halves[Math.min(round, halves.length - 1)]!;
      round += 1;
      yield { type: "token" as const, delta: text };
      yield { type: "done" as const, text, complete: false, truncated: true, reason: "length" };
    },
  };
}

test("a stateless one-shot prints the answer to stdout and saves nothing", async () => {
  scratch();
  const { server, baseUrl } = await startServer([
    { choices: [{ delta: { content: "answer" } }] },
  ]);
  try {
    const { code, out } = await capture((out) =>
      runPrintTurn({ prompt: "hi", cwd: scratch(), config, messages: [], client: endpointClient(baseUrl), out }),
    );
    assert.equal(code, 0);
    assert.equal(out, "answer\n");
    assert.equal(existsSync(sessionsDir()), false, "no session, nothing persisted");
  } finally {
    await close(server);
  }
});

test("a run against a restored session writes the exchange back", async () => {
  scratch();
  const { server, baseUrl } = await startServer([
    { choices: [{ delta: { content: "persisted answer" } }] },
  ]);
  try {
    const { code, out } = await capture((out) =>
      runPrintTurn({
        prompt: "hi",
        cwd: scratch(),
        config,
        messages: [],
        session: { id: "2026-09-29T00-00-00-000Z", createdAt: "2026-09-29T00:00:00.000Z" },
        client: endpointClient(baseUrl),
        out,
      }),
    );
    assert.equal(code, 0);
    assert.equal(out, "persisted answer\n");

    const restored = loadSession("2026-09-29T00-00-00-000Z");
    assert.ok(restored, "the session file must exist");
    assert.deepEqual(
      restored.messages.filter((m) => m.role !== "system"),
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "persisted answer" },
      ],
    );
  } finally {
    await close(server);
  }
});

test("a mid-turn failure prints what streamed and still persists the exchange", async () => {
  // The headless twin of the TUI's adoption: a turn that fails
  // after streaming a fragment must not rewind the session to the
  // question. The fragment is printed (it is still the best answer
  // there is) and saved, marked failed so a resume reads it as a
  // cut-short attempt rather than an answer.
  scratch();
  const failing: ModelClient = {
    async *stream() {
      yield { type: "token" as const, delta: "half an answer" };
      // Non-retriable on purpose: a retriable failure would spend
      // the retry budget (and real backoff) before failing the same
      // way, and the point here is the shape of the failure, not the
      // retry policy.
      throw new ModelTransportError("connection reset", false);
    },
  };
  const { code, out } = await capture((out) =>
    runPrintTurn({
      prompt: "long question",
      cwd: scratch(),
      config,
      messages: [],
      session: { id: "2026-09-29T00-00-02-000Z", createdAt: "2026-09-29T00:00:02.000Z" },
      client: failing,
      out,
    }),
  );
  assert.equal(code, 1, "a failed turn is a failure for the caller");
  assert.equal(out, "half an answer\n");

  const restored = loadSession("2026-09-29T00-00-02-000Z");
  assert.ok(restored, "the session file must exist");
  assert.deepEqual(
    restored.messages.filter((m) => m.role !== "system"),
    [
      { role: "user", content: "long question" },
      { role: "assistant", content: `half an answer\n\n${FAILED_MARKER}` },
    ],
  );
});

test("a request that did not fit says what it cleared to fit", async () => {
  // The recovery is the one thing the CLI does to a conversation nobody
  // asked for: earlier tool payloads become markers, and the answer comes
  // back as if nothing happened. In the TUI the rows still show what the
  // file said, so the screen and the context quietly disagree — and a user
  // watching the agent answer from a file it can no longer read has no way
  // to know that is what happened.
  scratch();
  let turn = 0;
  const overflowing: ModelClient = {
    async *stream() {
      turn += 1;
      if (turn === 1) {
        // The real shape: the transport throws what the provider said, and
        // the harness's classifier decides from the text whether it is a
        // conversation that does not fit or a request that never could.
        throw new ModelTransportError(
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 91234 tokens.",
          false,
        );
      }
      yield { type: "token" as const, delta: "here is what it said" };
      yield { type: "done" as const };
    },
  };
  const { code, out, err } = await captureBoth((sinks) =>
    runPrintTurn({
      prompt: "what did it say?",
      cwd: scratch(),
      config,
      messages: [
        { role: "user", content: "read readme.md" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", name: "read", content: "x".repeat(60_000) },
        { role: "assistant", content: "It says hello." },
      ],
      client: overflowing,
      ...sinks,
    }),
  );
  assert.equal(out, "here is what it said\n");
  assert.equal(code, 0);
  assert.match(err, /no longer/i, "what left the model's view has to be said where a script reads it");
  assert.match(err, /60,000/, "and with a size, so it is a fact and not a reassurance");
});

test("a turn that runs out of tool rounds says so, and fails a run that got no answer", async () => {
  // Claude Code learned this one from a blank line: `-p` mode used to treat
  // any turn that did not throw as success, so a turn whose last message was
  // not an answer — a stop hook's progress row, a budget cut-off — emitted
  // nothing and exited 0. Here it was quieter still. Twenty-four rounds of
  // tool calls, no prose anywhere, no `needs_user` line on any channel, exit
  // 0: a script read an empty file and a clean run for a turn that never
  // answered. The stop is a real event and now it reaches stderr.
  scratch();
  const { code, out, err } = await captureBoth((sinks) =>
    runPrintTurn({
      prompt: "sweep the tree",
      cwd: scratch(),
      config,
      messages: [],
      client: toolOnlyClient(),
      ...sinks,
    }),
  );
  assert.equal(out, "", "nothing was answered, so nothing belongs on stdout");
  assert.equal(code, 1, "a turn that stopped without an answer is a failure for the caller");
  assert.match(err, /tool budget/i, "the reason has to be on the channel a script can read");
});

test("a turn that stops after answering is not a failure", async () => {
  // The other half of the same rule. The round budget is a stop, not an
  // error: the work happened and prose reached the caller, so the exit code
  // stays 0 — the stop is on stderr either way.
  scratch();
  const { code, out, err } = await captureBoth((sinks) =>
    runPrintTurn({
      prompt: "sweep the tree",
      cwd: scratch(),
      config,
      messages: [],
      client: toolOnlyClient("Reading the tree.\n"),
      ...sinks,
    }),
  );
  assert.match(out, /Reading the tree\./, "the answer the caller got is still the answer");
  assert.equal(code, 0, "work was done and prose was delivered");
  assert.match(err, /tool budget/i);
});

test("an answer the endpoint cut off is printed, flagged, and marked in the session", async () => {
  // `RunResult.truncated` carries a duty in its own doc comment: the text is
  // real, "but the host has to say it is unfinished". The TUI says it in a
  // banner and headless said nothing, so a caller got an essay that stops
  // mid-sentence with no sign that it was ever going to. The transcript was
  // unmarked on both surfaces: saved that way, the next turn's model reads a
  // half sentence as a finished reply and stands behind it.
  scratch();
  const { code, out, err } = await captureBoth((sinks) =>
    runPrintTurn({
      prompt: "write me an essay",
      cwd: scratch(),
      config,
      messages: [],
      session: { id: "2026-09-30T00-00-00-000Z", createdAt: "2026-09-30T00:00:00.000Z" },
      client: truncatedClient(),
      ...sinks,
    }),
  );
  // One answer, not two: the continuation is asked for inside the same turn,
  // and the cut-off half was never committed as a separate rendered reply —
  // it went into the transcript and the next round's tokens continued the
  // live line. So the caller gets the whole thing with the seam in it.
  assert.equal(out, "the first halfand the rest of it\n", "the text is real, so it is still the answer");
  assert.equal(code, 0);
  assert.match(err, /unfinished/i, "and its being unfinished has to be said somewhere a script reads");

  const restored = loadSession("2026-09-30T00-00-00-000Z");
  assert.ok(restored, "the session file must exist");
  assert.equal(
    restored.messages.at(-1)?.content,
    `and the rest of it\n\n${TRUNCATED_MARKER}`,
    "the transcript is what the next turn reads first, so the cut is marked there too",
  );
});

test("an interrupt prints what streamed before it and still persists the exchange", async () => {
  scratch();
  const controller = new AbortController();
  const { code, out } = await capture((out) =>
    runPrintTurn({
      prompt: "long question",
      cwd: scratch(),
      config,
      messages: [],
      session: { id: "2026-09-29T00-00-01-000Z", createdAt: "2026-09-29T00:00:01.000Z" },
      client: endlessClient("partial answer before the cut", controller),
      signal: controller.signal,
      out,
    }),
  );
  assert.equal(code, 1, "an interrupt is a failure for the caller");
  assert.equal(out, "partial answer before the cut\n");

  const restored = loadSession("2026-09-29T00-00-01-000Z");
  assert.ok(restored);
  assert.deepEqual(
    restored.messages.filter((m) => m.role !== "system"),
    [
      { role: "user", content: "long question" },
      { role: "assistant", content: "partial answer before the cut\n\n[interrupted]" },
    ],
  );
});
