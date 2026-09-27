import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerFilter } from "./answer-filter.js";

function run(deltas: string[]) {
  const statuses: string[] = [];
  const plans: string[] = [];
  const visible: string[] = [];
  const filter = createAnswerFilter();
  let answer = "";
  for (const delta of deltas) {
    const output = filter.push(delta);
    statuses.push(...output.statuses);
    if (output.plan) plans.push(output.plan.title);
    answer += output.text;
    visible.push(answer);
  }
  const tail = filter.flush();
  statuses.push(...tail.statuses);
  if (tail.plan) plans.push(tail.plan.title);
  answer += tail.text;
  visible.push(answer);
  return { answer, plans, statuses, visible };
}

test("releases answer text immediately", () => {
  const result = run(["Yes", ", ", "that ", "works", "."]);
  assert.equal(result.answer, "Yes, that works.");
  assert.deepEqual(result.visible, ["Yes", "Yes, ", "Yes, that ", "Yes, that works", "Yes, that works.", "Yes, that works."]);
});

test("extracts status lines but preserves markdown links", () => {
  const result = run(["[Working]\n[label](https://example.com)"]);
  assert.deepEqual(result.statuses, ["Working"]);
  assert.equal(result.answer, "[label](https://example.com)");
});

test("extracts one leading plan block", () => {
  const result = run(["## Inspect", "ing inputs\n", "Reading files.\n", "\nAnswer"]);
  assert.deepEqual(result.plans, ["Inspecting inputs"]);
  assert.equal(result.answer, "Answer");
});

test("reset clears held input", () => {
  const filter = createAnswerFilter();
  assert.equal(filter.push("partial [").text, "partial [");
  filter.reset();
  assert.equal(filter.push("fresh").text, "fresh");
  assert.equal(filter.flush().text, "");
});
