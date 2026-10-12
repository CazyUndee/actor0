import assert from "node:assert/strict";
import { test } from "node:test";
import { isInvalid, partitionResults } from "./verify-results.js";
import type { TaskResult } from "./runner.js";

/**
 * The verifier: a rate-limit / transport artifact (an answer the model never
 * produced) is separated from a real result, so a comparison only counts what
 * the model actually did. A real task failure — the model ran and answered, but
 * did not complete — is valid, not an artifact.
 */

const base: TaskResult = {
  candidate: "B", taskId: "t", completed: false, firstCallValid: true, recovered: null,
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
