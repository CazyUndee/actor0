import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTokens,
  readAudit,
  readUsage,
  recordAudit,
  recordUsage,
  startOfDay,
  startOfMonth,
  startOfWeek,
  usageByModel,
  usageSince,
} from "./usage.js";

/**
 * The local usage log /usage aggregates. Data-dir isolated per test; one JSON
 * line per turn; corrupt lines skipped rather than failing the read.
 */

function withDataDir<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "actor0-usage-"));
  const prev = process.env.ACTOR0_DATA_DIR;
  process.env.ACTOR0_DATA_DIR = dir;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env.ACTOR0_DATA_DIR;
    else process.env.ACTOR0_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an empty log reads as no usage, not an error", () => {
  withDataDir(() => assert.deepEqual(readUsage(), []));
});

test("a turn's counts round-trip through the log", () => {
  withDataDir(() => {
    recordUsage("m", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    const [entry] = readUsage();
    assert.equal(entry!.total, 120);
    assert.equal(entry!.prompt, 100);
    assert.equal(entry!.model, "m");
    assert.ok(entry!.t > 0);
  });
});

test("usageSince totals tokens and turns after a cutoff", () => {
  withDataDir(() => {
    const now = Date.now();
    recordUsage("m", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    const entries = readUsage();
    assert.deepEqual(usageSince(entries, now - 1000), { tokens: 15, turns: 1 });
    assert.deepEqual(usageSince(entries, now + 1000), { tokens: 0, turns: 0 }, "before the cutoff is excluded");
  });
});

test("a corrupt line is skipped, not fatal", () => {
  withDataDir(() => {
    recordUsage("m", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    appendFileSync(join(process.env.ACTOR0_DATA_DIR!, "usage.jsonl"), "{not json}\n", "utf8");
    recordUsage("m", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
    assert.deepEqual(readUsage().map((e) => e.total), [2, 4], "the torn line drops, the good ones survive");
  });
});

test("usage totals group by model, largest first", () => {
  withDataDir(() => {
    recordUsage("claude", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    recordUsage("gpt", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    recordUsage("claude", { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 });
    assert.deepEqual(usageByModel(readUsage()), [
      { model: "claude", tokens: 40 },
      { model: "gpt", tokens: 2 },
    ]);
  });
});

test("day/week/month boundaries land on midnight local time", () => {
  const wed = new Date(2026, 9, 14, 13, 30); // a Wednesday afternoon
  assert.equal(new Date(startOfDay(wed)).getHours(), 0, "day starts at midnight");
  assert.equal(new Date(startOfWeek(wed)).getDay(), 1, "week starts Monday");
  assert.equal(new Date(startOfMonth(wed)).getDate(), 1, "month starts on the 1st");
  assert.ok(startOfWeek(wed) <= startOfDay(wed), "the week's start is this day or earlier");
  assert.ok(startOfMonth(wed) <= startOfWeek(wed), "the month's start is this week or earlier");
});

test("token counts format compactly", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(842), "842");
  assert.equal(formatTokens(1_234), "1.2k");
  assert.equal(formatTokens(2_500_000), "2.5M");
});

test("a turn's audit round-trips through the log", () => {
  withDataDir(() => {
    recordAudit("m", {
      rounds: 3,
      complete: true,
      toolCalls: { shell: 2, read: 1 },
      toolCallCount: 3,
      promptTokens: 30,
      completionTokens: 13,
      totalTokens: 43,
    });
    const [entry] = readAudit();
    assert.equal(entry!.model, "m");
    assert.equal(entry!.rounds, 3);
    assert.equal(entry!.complete, true);
    assert.deepEqual(entry!.toolCalls, { shell: 2, read: 1 });
    assert.equal(entry!.toolCallCount, 3);
    assert.equal(entry!.totalTokens, 43);
    assert.ok(entry!.t > 0);
  });
});

test("a corrupt audit line is skipped, not fatal", () => {
  withDataDir(() => {
    recordAudit("m", { rounds: 1, complete: true, toolCalls: {}, toolCallCount: 0, promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    appendFileSync(join(process.env.ACTOR0_DATA_DIR!, "audit.jsonl"), "{not json}\n", "utf8");
    recordAudit("m", { rounds: 2, complete: false, toolCalls: { shell: 1 }, toolCallCount: 1, promptTokens: 3, completionTokens: 1, totalTokens: 4 });
    assert.deepEqual(readAudit().map((e) => e.rounds), [1, 2], "the torn line drops, the good ones survive");
  });
});
