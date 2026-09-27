import assert from "node:assert/strict";
import test from "node:test";
import { extractPlanPrefix, needsMorePlanData, parsePlanPrefix } from "./plan-prefix.js";

test("extracts a leading plan and leaves the answer", () => {
  const result = extractPlanPrefix("## Inspecting inputs\nReading files.\n\nThe answer.");
  assert.equal(result.plan?.title, "Inspecting inputs");
  assert.equal(result.rest, "The answer.");
});

test("does not treat a later heading as a plan", () => {
  assert.equal(extractPlanPrefix("Answer\n## Later\n\nNo.").plan, null);
});

test("buffers only a possible plan prefix", () => {
  assert.equal(needsMorePlanData("## Par"), true);
  assert.equal(needsMorePlanData("## Plan\nReading"), true);
  assert.equal(needsMorePlanData("## Plan\nReading\n\nAnswer"), false);
  assert.equal(needsMorePlanData("Plain answer"), false);
});

test("supports heading-only plans and rejects invalid headings", () => {
  assert.equal(extractPlanPrefix("## Brief\n\nAnswer").plan?.plan, "## Brief");
  assert.equal(parsePlanPrefix(`${"#".repeat(101)}\nbody\n\nx`), null);
  assert.equal(parsePlanPrefix("#\nbody\n\nx"), null);
  assert.equal(parsePlanPrefix("Plain text\nbody\n\nx"), null);
});
