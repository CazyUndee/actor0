import assert from "node:assert/strict";
import test from "node:test";
import { formatReasoningSummary } from "./reasoning-summary.js";

test("formats bracketed reasoning titles", () => {
  assert.deepEqual(formatReasoningSummary("[Inspecting inputs]"), {
    title: "Inspecting inputs",
    summary: "",
  });
});

test("formats heading plus prose", () => {
  assert.deepEqual(formatReasoningSummary("**Deriving result**\nCombining values."), {
    title: "Deriving result",
    summary: "Combining values.",
  });
});

test("bounds untrusted reasoning", () => {
  const summary = formatReasoningSummary("x".repeat(5_000));
  assert.equal(summary.title.length, 90);
  assert.ok(summary.summary.length <= 900);
  assert.deepEqual(formatReasoningSummary("  \n\n"), { title: "", summary: "" });
});
