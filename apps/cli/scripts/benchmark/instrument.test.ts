import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelEvent } from "@actor0/harness";
import { CANDIDATE_B, CANDIDATE_C, CANDIDATE_C2, type RawCandidate } from "./candidates.js";
import { runCandidateOnTask } from "./runner.js";
import { simulatedModel, withUsage } from "./simulated-model.js";
import { TASKS } from "./tasks.js";

/**
 * A self-test of the instrument: drive it with a model whose behaviour is a
 * known function of the interface, offline and for free, and assert the metrics
 * show the difference. If these fail, the benchmark is measuring something other
 * than the interface and no amount of real runs would have settled the question.
 */

const provider = { baseUrl: "http://localhost", model: "sim", transport: "openai" as const };
const cheap = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

const run = (candidate: RawCandidate, taskId: string, events: (round: number) => ModelEvent[]) =>
  runCandidateOnTask({
    candidate,
    task: TASKS.find((t) => t.id === taskId)!,
    provider,
    client: simulatedModel((turn) => withUsage((t) => events(t.round), cheap)(turn)),
  });

const callEvent = (name: string, args: Record<string, unknown>, id = "c1"): ModelEvent => ({
  type: "tool_call",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

test("a competent model completes the task on every candidate", async () => {
  // Instrument sanity: nothing about the interface should stop a model that
  // always constructs valid calls. Each candidate is called through its own
  // tool name — C has no `read`, it has `inspect` with an op.
  const cases: [string, RawCandidate, string, Record<string, unknown>][] = [
    ["B", CANDIDATE_B, "read", { path: "note.txt" }],
    ["C", CANDIDATE_C, "inspect", { op: "read", path: "note.txt" }],
  ];
  for (const [name, candidate, tool, args] of cases) {
    const result = await run(candidate, "read-and-report", (round) =>
      round === 1 ? [callEvent(tool, args), { type: "done" }] : [{ type: "token", delta: "4242" }, { type: "done" }],
    );
    assert.equal(result.completed, true, `${name}: a valid read must complete`);
    assert.equal(result.firstCallValid, true, `${name}: a valid read must be first-call valid`);
    assert.equal(result.schemaInvalid, 0, `${name}: no schema failures on a well-formed call`);
  }
});

test("a model that fills only what the schema forces fails first-call on the permissive candidate, then recovers", async () => {
  // The central claim of the comparison, checked deterministically. Candidate B's
  // read requires `path`; candidate C's inspect requires only `op`. A model that
  // supplies only the required fields therefore builds a valid B call and an
  // invalid C one — and the harness must show it.
  const b = await run(CANDIDATE_B, "read-and-report", (round) =>
    round === 1 ? [callEvent("read", { path: "note.txt" }), { type: "done" }] : [{ type: "token", delta: "4242" }, { type: "done" }],
  );
  assert.equal(b.firstCallValid, true, "B's read requires path, so the minimal call is valid");

  // The C policy emits {op:"read"} — required-only — then, on round 2, retries
  // with the full args after the dispatcher told it what was missing.
  const c = await run(CANDIDATE_C, "read-and-report", (round) =>
    round === 1
      ? [callEvent("inspect", { op: "read" }), { type: "done" }]
      : round === 2
        ? [callEvent("inspect", { op: "read", path: "note.txt" }), { type: "done" }]
        : [{ type: "token", delta: "4242" }, { type: "done" }],
  );
  assert.equal(c.firstCallValid, false, "C's inspect requires only op, so the minimal call is missing path");
  assert.ok(c.schemaInvalid >= 1, "the dispatcher must reject the incomplete grouped call");
  assert.equal(c.recovered, true, "C recovers on the second round");
  assert.equal(c.completed, true, "and completes — which is why C is viable at all");
});

test("a flailing model is punished by tokens-per-completion", async () => {
  // The cost metric exists to catch this: a candidate that burns calls without
  // completing must look expensive, whichever interface it is.
  const flail = await run(CANDIDATE_B, "edit-file", (round) => {
    const args = { path: "nope.txt", old: "x", new: "y" };
    if (round <= 6) return [callEvent("edit", args, `c${round}`), { type: "usage", usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }, { type: "done" }];
    return [{ type: "token", delta: "I could not complete this." }, { type: "done" }];
  });
  assert.equal(flail.completed, false, "the flailing model never completes");
  assert.ok(flail.toolCalls >= 6, `expected a retry storm, got ${flail.toolCalls} calls`);
  assert.ok(flail.usageTokens >= 6 * 1500, "every wasted call must cost tokens");
  assert.ok(flail.semanticInvalid >= 1, "the failing calls are semantic failures");
});

test("the description knob changes first-call validity under a fixed policy", async () => {
  // C2 hardens the description so a model that reads it supplies the args even
  // though the schema is unchanged. A policy that reads the advertised
  // description and follows it must therefore score better on C2 than on C —
  // which is exactly the mechanism the real C-vs-C2 run tests.
  const withDesc = (candidate: RawCandidate) =>
    runCandidateOnTask({
      candidate,
      task: TASKS.find((t) => t.id === "read-and-report")!,
      provider,
      client: simulatedModel((turn) => {
        if (turn.round !== 1) return withUsage(() => [{ type: "token", delta: "4242" }, { type: "done" }], cheap)(turn);
        const spec = turn.tools.find((t) => t.function.name === "inspect");
        const args = /read→path/.test(spec?.function.description ?? "")
          ? { op: "read", path: "note.txt" }
          : { op: "read" };
        return withUsage(() => [callEvent("inspect", args), { type: "done" }], cheap)(turn);
      }),
    });
  const c = await withDesc(CANDIDATE_C);
  const c2 = await withDesc(CANDIDATE_C2);
  assert.equal(c.firstCallValid, false, "C's description does not name the required arg");
  assert.equal(c2.firstCallValid, true, "C2's description does, and the policy follows it");
});
