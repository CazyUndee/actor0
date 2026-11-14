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

test("a long whitespace-only buffer stops being a possible plan prefix", () => {
  // The Θ(n²) guard: a run of spaces matches `#{0,6}\s*$` forever with no
  // newline to end it. Past the maximum a plan prefix could ever be, more data
  // cannot make it a plan, so needsMorePlanData must stop asking (otherwise
  // every push re-tests the whole growing buffer).
  const spaces = " ".repeat(5_000);
  assert.equal(needsMorePlanData(spaces), false);
  // A real, still-open plan prefix is still held.
  assert.equal(needsMorePlanData("## Plan\nReading files"), true);
});
