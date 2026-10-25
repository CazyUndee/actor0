import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskResult } from "./runner.js";
import { selectBattery } from "./battery.js";

const rec = (candidate: string, taskId: string, completed: boolean, usageTokens = 1000): TaskResult => ({
  candidate: candidate as TaskResult["candidate"],
  taskId,
  schemaHash: "h",
  model: "sim",
  completed,
  firstCallValid: completed,
  recovered: null,
  toolCalls: 1,
  schemaInvalid: 0,
  semanticInvalid: completed ? 0 : 1,
  unsupported: 0,
  usageTokens,
  toolDefTokens: 10,
  latencyMs: 100,
  answer: completed ? "done" : "could not complete",
});

test("selectBattery prefers tasks where candidates disagree, filling by cost spread", () => {
  const results: TaskResult[] = [
    rec("A", "t-split-a", true, 5000),
    rec("C", "t-split-a", false, 9000),
    rec("A", "t-split-b", true, 2000),
    rec("B", "t-split-b", true, 3000),
    rec("C", "t-split-b", false, 4000),
    rec("A", "t-agree", true, 1000),
    rec("C", "t-agree", true, 1100),
    rec("A", "t-cost", true, 100),
    rec("C", "t-cost", true, 50_000),
  ];
  const battery = selectBattery(results, 4);
  assert.deepEqual(
    battery,
    ["t-split-a", "t-split-b", "t-cost", "t-agree"],
    "the two splitting tasks lead (higher spread first), then the cost spread, then the agreed task",
  );
});

test("selectBattery returns at most k tasks and never more than it has", () => {
  const results: TaskResult[] = [
    rec("A", "x", true),
    rec("C", "x", false),
    rec("A", "y", true),
    rec("C", "y", false),
  ];
  assert.deepEqual(selectBattery(results, 4), ["x", "y"], "zero spread: stable order, both split");
  assert.deepEqual(selectBattery(results, 1), ["x"]);
});
