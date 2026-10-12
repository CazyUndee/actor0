import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelEvent, ToolCall } from "@actor0/harness";
import type { ResolvedProvider } from "./config.js";
import { createTaskDelegate } from "./subagent.js";

/**
 * Sub-agent delegation, driven end to end through an injected client so no
 * network is touched. The delegate runs a real turn (`runTurn` → the harness),
 * so these exercise the whole path: a fresh context, the base tools, and the
 * refusal that stops a sub-agent from recursing.
 */

const provider: ResolvedProvider = {
  baseUrl: "http://localhost",
  model: "m",
  transport: "openai",
  auth: "api-key",
};

/** A client that plays back one scripted event list per stream call. */
function scripted(scripts: ModelEvent[][]): ModelClient {
  let index = 0;
  return {
    async *stream() {
      const script = scripts[index++];
      if (!script) throw new Error(`missing script ${index}`);
      for (const event of script) yield event;
    },
  };
}

const scratch = (): string => mkdtempSync(join(tmpdir(), "actor0-subagent-"));
const call = (name: string, args: unknown): ToolCall => ({
  id: "c1",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

test("a delegated subtask runs its own turn and returns the answer", async () => {
  const model = scripted([[{ type: "token", delta: "the answer is 42" }, { type: "done" }]]);
  const delegate = createTaskDelegate({ provider, cwd: scratch(), client: model });
  const result = await delegate.run({ prompt: "what is the answer" }, new AbortController().signal);
  assert.equal(result.text, "the answer is 42");
  assert.equal(result.complete, true);
  assert.equal(result.rounds, 1);
  assert.equal(result.toolCallCount, 0);
});

test("a delegated subtask can use the tools and reports how many it made", async () => {
  const cwd = scratch();
  writeFileSync(join(cwd, "note.txt"), "hello from the file");
  const model = scripted([
    [{ type: "tool_call", tool_calls: [call("read", { path: "note.txt" })] }, { type: "done" }],
    [{ type: "token", delta: "the file says hello" }, { type: "done" }],
  ]);
  const delegate = createTaskDelegate({ provider, cwd, client: model });
  const result = await delegate.run({ prompt: "read note.txt" }, new AbortController().signal);
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCallCount, 1);
  assert.match(result.text, /the file says hello/);
});

test("a sub-agent cannot delegate further — the task tool refuses and the turn continues", async () => {
  // The refusal is a normal tool result, not a thrown error, so the sub-agent
  // reads it as a fact, does the work itself, and the turn still completes.
  const model = scripted([
    [{ type: "tool_call", tool_calls: [call("task", { prompt: "recurse" })] }, { type: "done" }],
    [{ type: "token", delta: "fine, I will do it myself" }, { type: "done" }],
  ]);
  const delegate = createTaskDelegate({ provider, cwd: scratch(), client: model });
  const result = await delegate.run({ prompt: "delegate something" }, new AbortController().signal);
  assert.equal(result.complete, true);
  assert.match(result.text, /do it myself/);
});
