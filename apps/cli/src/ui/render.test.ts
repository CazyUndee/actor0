import assert from "node:assert/strict";
import { test } from "node:test";
import { composerRows, entryLines, liveLines } from "./render.js";
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

test("a long prompt wraps into visible rows and keeps the caret on the right char", () => {
  const draft = "please explain in great detail how a hash map works internally including collisions";
  const built = composerRows({ cols: 40, draft, caret: draft.length, busy: false, maxHeight: 12 });
  const rows = built.rows.map((r) => r.map((s) => s.text).join(""));
  assert.ok(rows.length > 4, `the composer grew to hold the wrapped prompt (${rows.length} rows)`);
  assert.ok(rows.join("\n").includes("hash map works"), "the full prompt is visible, not truncated");
  // The caret at the end lands on the last content row, just past the last char.
  const caretRow = built.rows[built.inputRow]!.map((s) => s.text).join("");
  assert.equal(caretRow[built.inputCol - 2], "s", `the char before the caret is the last typed char (saw '${caretRow[built.inputCol - 2]}')`);
  // A GUI block cursor: a filled (background) cell at the caret column.
  const caretSegs = built.rows[built.inputRow]!;
  assert.ok(caretSegs.some((s) => s.bg !== undefined), "a filled block cursor is drawn on the caret row");
});

test("a prompt taller than the box scrolls and counts what is above", () => {
  const draft = "x".repeat(400);
  const built = composerRows({ cols: 40, draft, caret: draft.length, busy: false, maxHeight: 6 });
  const out = built.rows.map((r) => r.map((s) => s.text).join("")).join("\n");
  assert.ok(/↑ \d+ more lines?/.test(out), "the scrolled-off lines are counted");
  assert.ok(built.rows.length <= 6, "the box never exceeds its max height");
});

test("streaming reasoning is a titled multi-row card, not one line", () => {
  const reasoning = "First I weigh separate chaining, then open addressing, then the load factor and resizing cost, which is a fair amount of text.";
  const rows = liveLines({ text: "", reasoning }, 0, 0, COLS, 20);
  const out = text(rows);
  assert.ok(out.includes("∴ thinking"), "the streaming reasoning is a titled card");
  assert.ok(rows.length > 3, `it streams onto several rows (${rows.length})`);
  // Readable contrast: the body is the muted tone, not the near-invisible dim.
  assert.ok(rows.some((r) => r.some((s) => s.color !== undefined && s.text.trim().length > 0)), "the reasoning has visible text");
});
