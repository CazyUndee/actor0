import assert from "node:assert/strict";
import { test } from "node:test";
import { isBadPatch, isHarnessError, isInvalid, partitionResults } from "./verify-results.js";
import type { TaskResult } from "./runner.js";

/**
 * The verifier: a rate-limit / transport artifact (an answer the model never
 * produced) is separated from a real result, so a comparison only counts what
 * the model actually did. A real task failure — the model ran and answered, but
 * did not complete — is valid, not an artifact.
 */

const base: TaskResult = {
  candidate: "B", taskId: "t", schemaHash: "abc123", model: "sim", completed: false, firstCallValid: true, recovered: null,
  toolCalls: 1, schemaInvalid: 0, semanticInvalid: 0, unsupported: 0,
  usageTokens: 100, toolDefTokens: 10, latencyMs: 50, answer: "a real answer",
};

const artifact: TaskResult = { ...base, answer: "(turn failed: HTTP 429 Too Many Requests …)" };
const realFailure: TaskResult = { ...base, completed: false, answer: "I could not find the file." };

test("a transport-failed turn is an artifact; a real answer — even a failure — is valid", () => {
  assert.equal(isInvalid(artifact), true);
  assert.equal(isInvalid(realFailure), false, "the model ran and answered; that is a real data point");
  assert.equal(isInvalid(base), false);
});

test("partition separates artifacts from valid results", () => {
  const { valid, invalid } = partitionResults([base, artifact, realFailure]);
  assert.deepEqual(invalid.map((r) => r.answer), [artifact.answer]);
  assert.equal(valid.length, 2);
});

test("a bad-patch turn is detected and excluded from comparison", () => {
  // The gateway's measured signature: a one-call task becomes a retry storm
  // ("I have no tools", repeat calls) and first-call validity collapses.
  const badPatch: TaskResult = { ...base, toolCalls: 6, firstCallValid: false, completed: false, answer: "I don't have a working file-reading tool." };
  assert.equal(isBadPatch(badPatch), true);
  // A genuine multi-call task with valid calls is NOT a bad patch.
  const realMultistep: TaskResult = { ...base, toolCalls: 12, firstCallValid: true, completed: true };
  assert.equal(isBadPatch(realMultistep), false, "many calls with valid first calls is real work, not a bad patch");
  // A transport failure is invalid, not "bad patch".
  assert.equal(isBadPatch(artifact), false);

  const { comparable, badPatch: flagged } = partitionResults([base, badPatch, artifact]);
  assert.deepEqual(flagged.map((r) => r.answer), [badPatch.answer]);
  assert.equal(comparable.length, 1, "only the clean turn is comparable");
});

/**
 * A harness-error turn: the benchmark itself was miswired for that turn (the
 * dispatcher could not resolve the candidate), so the answer describes the
 * tooling failure, not the model or the interface. Such a turn is comparable
 * to nothing. Old files carry the echo of the error in the answer; new ones
 * carry the field.
 */
const legacyTainted: TaskResult = { ...base, completed: false, answer: "My tools are returning \"no dispatcher for candidate g-none-full\" errors on every call." };
const freshTainted: TaskResult = { ...base, completed: false, harnessError: true, answer: "I was unable to read the file." };

test("a harness-miswired turn is excluded from comparison", () => {
  assert.equal(isHarnessError(legacyTainted), true, "legacy files: the model echoes the dispatcher error");
  assert.equal(isHarnessError(freshTainted), true, "new files: the field says so directly");
  assert.equal(isHarnessError(base), false);
  assert.equal(isHarnessError(artifact), false, "transport failures are invalid, not harness errors");

  const { comparable, harnessError } = partitionResults([base, legacyTainted, freshTainted]);
  assert.equal(comparable.length, 1, "only the clean turn is comparable");
  assert.equal(harnessError.length, 2);
});
