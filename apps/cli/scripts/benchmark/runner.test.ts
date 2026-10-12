import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelClient, ModelEvent } from "@actor0/harness";
import { CANDIDATE_B, CANDIDATE_D } from "./candidates.js";
import { runCandidateOnTask } from "./runner.js";
import { TASKS } from "./tasks.js";

/**
 * The runner, driven by a scripted model so the metrics are deterministic
 * without a network. Verifies completion, first-call validity, recovery after a
 * schema-invalid call, and the tool-definition token cost.
 */

const provider = { baseUrl: "http://localhost", model: "test-model", transport: "openai" as const };

function scripted(turns: ModelEvent[][]): ModelClient {
  let index = 0;
  return {
    async *stream() {
      const turn = turns[index++];
      if (!turn) throw new Error(`missing script ${index}`);
      for (const event of turn) yield event;
    },
  };
}

const toolCall = (name: string, args: Record<string, unknown>): ModelEvent => ({
  type: "tool_call",
  tool_calls: [{ id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

const task = (id: string) => TASKS.find((t) => t.id === id)!;

test("a valid first call completes the task and counts as first-call valid", async () => {
  const client = scripted([
    [toolCall("write", { path: "hello.txt", content: "hi there" }), { type: "done" }],
    [{ type: "token", delta: "created hello.txt" }, { type: "done" }],
  ]);
  const result = await runCandidateOnTask({ candidate: CANDIDATE_B, task: task("create-file"), provider, client });
  assert.equal(result.completed, true, "the file was created with the right contents");
  assert.equal(result.firstCallValid, true);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.schemaInvalid, 0);
  assert.ok(result.toolDefTokens > 0, "tool-definition tokens are counted");
});

test("a schema-invalid call is recorded, and recovery is measured", async () => {
  const client = scripted([
    // Missing --content: a schema failure the dispatcher does not fill.
    [toolCall("act", { op: "write", path: "x.txt" }), { type: "done" }],
    // Corrected on the next call.
    [toolCall("act", { op: "write", path: "x.txt", content: "data" }), { type: "done" }],
    [{ type: "token", delta: "done" }, { type: "done" }],
  ]);
  const result = await runCandidateOnTask({ candidate: CANDIDATE_D, task: task("create-file"), provider, client });
  assert.equal(result.firstCallValid, false, "the first call was schema-invalid");
  assert.equal(result.recovered, true, "a later call validated");
  assert.equal(result.schemaInvalid, 1);
  assert.equal(result.toolCalls, 2);
});

test("a grep candidate finds the file and reports the path", async () => {
  const client = scripted([
    [toolCall("grep", { pattern: "FIXME" }), { type: "done" }],
    [{ type: "token", delta: "src/b.txt" }, { type: "done" }],
  ]);
  const result = await runCandidateOnTask({ candidate: CANDIDATE_B, task: task("search-and-report"), provider, client });
  assert.equal(result.completed, true);
  assert.equal(result.firstCallValid, true);
  assert.match(result.answer, /b\.txt/);
});
