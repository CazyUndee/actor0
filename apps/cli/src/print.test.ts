import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { OpenAiCompatibleModel, type ModelClient } from "@actor0/harness";
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
