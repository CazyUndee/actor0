import assert from "node:assert/strict";
import { test } from "node:test";
import { entryLines, liveLines } from "./render.js";
import type { Entry } from "../conversation.js";

/** Join rendered rows to plain text (no colour), for assertions. */
function text(rows: { text: string }[][]): string {
  return rows.map((r) => r.map((s) => s.text).join("")).join("\n");
}

const COLS = 80;

test("a tool call is a box headed by a clear tool name and its indented output", () => {
  const entry: Entry = { kind: "tool", name: "shell", target: "echo hi", status: "ok", output: "hi\n" };
  const out = text(entryLines(entry, COLS));
  assert.ok(out.includes("Bash"), "the shell tool is labelled Bash, not the cryptic $");
  assert.ok(out.includes("echo hi"), "the command is shown");
  assert.ok(out.includes("hi"), "the output is shown");
  assert.ok(!out.includes("⎿"), "no cryptic output marker");
});

test("tool output keeps its line structure and strips CR", () => {
  const entry: Entry = { kind: "tool", name: "shell", target: "echo a b", status: "ok", output: "a\r\nb\r\nc\r\n" };
  const out = text(entryLines(entry, COLS));
  assert.ok(!out.includes("\r"), "carriage returns are stripped");
  assert.ok(out.includes("a") && out.includes("b") && out.includes("c"), "each output line is kept on its own row");
});

test("long tool output is cut to a count, not flooded", () => {
  const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const entry: Entry = { kind: "tool", name: "read", target: "big.txt", status: "ok", output };
  const out = text(entryLines(entry, COLS));
  assert.ok(/more lines?/.test(out), "long output is truncated with a count");
  assert.ok(!out.includes("line 39"), "the tail of a long output is not shown");
});

test("reasoning is collapsed to a one-line preview by default", () => {
  const entry: Entry = { kind: "reasoning", text: "First I need to consider the options carefully and weigh them." };
  const collapsed = text(entryLines(entry, COLS));
  assert.ok(collapsed.includes("∴ thinking"), "a thinking label");
  assert.ok(collapsed.includes("⌃r"), "an expand hint");
  assert.ok(!collapsed.includes("weigh them"), "the full body is hidden when collapsed");
});

test("reasoning expands to the full body when asked", () => {
  const entry: Entry = { kind: "reasoning", text: "First I need to consider the options carefully and weigh them." };
  const expanded = text(entryLines(entry, COLS, true));
  assert.ok(expanded.includes("weigh them"), "the full body is shown when expanded");
});

test("a plan shows its title once and renders its body as markdown", () => {
  const entry: Entry = { kind: "plan", title: "My Plan", plan: "## My Plan\n\n- step one\n- step two" };
  const out = text(entryLines(entry, COLS));
  assert.equal((out.match(/My Plan/g) ?? []).length, 1, "the title is not repeated from the body's leading heading");
  assert.ok(out.includes("◆ My Plan"), "the title is marked");
  assert.ok(out.includes("step one") && out.includes("step two"), "the body renders as a list");
});

test("streamed text is boxed from the first token", () => {
  const rows = liveLines({ text: "hello world", reasoning: "" }, 0, 0, COLS, 20);
  const out = text(rows);
  assert.ok(out.includes("╭") && out.includes("╰"), "the live text has a border while it streams");
  assert.ok(out.includes("hello world"), "the streamed text is shown");
});

test("long streamed text is counted at the top, not silently cut", () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const rows = liveLines({ text: long, reasoning: "" }, 0, 0, COLS, 10);
  const out = text(rows);
  assert.ok(/↑ \d+ more lines?/.test(out), "the lines scrolled off the top are counted");
  assert.ok(out.includes("word59"), "the latest text is still shown");
});
