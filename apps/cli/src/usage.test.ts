import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTokens,
  readUsage,
  recordUsage,
  startOfDay,
  startOfMonth,
  startOfWeek,
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
