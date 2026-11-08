import assert from "node:assert/strict";
import { test } from "node:test";
import { addErrorRows, addKeyRows, addKindRows, addManualRows, addModelsRows, addUrlRows, addWorkingRows, composerRows, entryLines, formatTimer, liveLines, managePanelRows, mcpPanelRows, modelPickerRows, pickerRows, providerPanelRows, sessionPickerRows, slashPopupRows, thinkingPickerRows, usagePanelRows, windowRows } from "./render.js";
import type { Entry } from "../conversation.js";

/** Join rendered rows to plain text (no colour), for assertions. */
function text(rows: { text: string }[][]): string {
  return rows.map((r) => r.map((s) => s.text).join("")).join("\n");
}

const COLS = 80;

test("every menu and picker adapter uses the dedicated rounded menu style", () => {
  const menus = [
    providerPanelRows([{ name: "agnes", label: "Agnes", active: true }], 0, ""),
    managePanelRows({ name: "agnes", label: "Agnes", model: "flash", endpoint: "https://example.test", auth: "API key" }, 0),
    pickerRows({ title: "test picker", items: [{ label: "one" }], cursor: 0 }),
    modelPickerRows([{ model: "model-a", provider: "provider-a" }], 0),
    sessionPickerRows([{ id: "session-a", updatedAt: "now", messageCount: 2 }], 0),
    thinkingPickerRows([{ label: "high", effort: "high" }], 0),
    usagePanelRows([{ label: "today", tokens: 12, turns: 1, byModel: [{ model: "model-a", tokens: 12 }] }], 0),
    mcpPanelRows(),
    slashPopupRows([{ name: "help", description: "Show help" }], 0),
    addKindRows(false, [{ id: "openai", label: "OpenAI", auth: ["api-key"] }], 0),
    addUrlRows("OpenAI", "https://example.test").rows,
    addKeyRows("OpenAI", "secret").rows,
    addWorkingRows("Adding provider", "Fetching models"),
    addErrorRows("Could not connect"),
    addModelsRows("OpenAI", ["model-a"], 0, new Set(), 12),
    addManualRows("OpenAI", "model-a").rows,
  ];

  for (const [index, rows] of menus.entries()) {
    const rendered = text(rows);
    assert.ok(rendered.startsWith("╭"), "menu " + index + " starts with the rounded top border");
    assert.ok(rendered.includes("⌕") && rendered.includes("search"), "menu " + index + " uses the shared search row");
    assert.ok(rendered.includes("╰"), "menu " + index + " ends with the rounded bottom border");
  }
});

test("a tool call is a box headed by a clear tool name and its indented output", () => {
  const entry: Entry = { kind: "tool", name: "shell", target: "echo hi", status: "ok", output: { data: "hi\n", text: "hi\n" } };
  const out = text(entryLines(entry, COLS));
  assert.ok(out.includes("Bash"), "the shell tool is labelled Bash, not the cryptic $");
  assert.ok(out.includes("echo hi"), "the command is shown");
  assert.ok(out.includes("hi"), "the output is shown");
  assert.ok(!out.includes("⎿"), "no cryptic output marker");
});

test("tool output keeps its line structure and strips CR", () => {
  const entry: Entry = { kind: "tool", name: "shell", target: "echo a b", status: "ok", output: { data: "a\r\nb\r\nc\r\n", text: "a\r\nb\r\nc\r\n" } };
  const out = text(entryLines(entry, COLS));
  assert.ok(!out.includes("\r"), "carriage returns are stripped");
  assert.ok(out.includes("a") && out.includes("b") && out.includes("c"), "each output line is kept on its own row");
});

test("long tool output is cut to a count, not flooded", () => {
  const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const entry: Entry = { kind: "tool", name: "read", target: "big.txt", status: "ok", output: { data: output, text: output } };
  const out = text(entryLines(entry, COLS));
  assert.ok(/more lines?/.test(out), "long output is truncated with a count");
  assert.ok(!out.includes("line 39"), "the tail of a long output is not shown");
});

test("reasoning is collapsed to a one-line sentence by default", () => {
  const entry: Entry = { kind: "reasoning", text: "First I need to consider the options carefully and weigh them." };
  const collapsed = text(entryLines(entry, COLS));
  assert.ok(collapsed.includes("thinking"), "a one-line sentence, not the full body");
  assert.ok(!collapsed.includes("weigh them"), "the full body is hidden when collapsed");
  assert.equal(collapsed.split("\n").length, 4, "a rounded rectangle: border, one content row, border");
});

test("reasoning shows the thought duration when it was timed", () => {
  const entry: Entry = { kind: "reasoning", text: "First I need to consider the options.", durationSeconds: 12.25 };
  const collapsed = text(entryLines(entry, COLS));
  assert.ok(collapsed.includes("thought for 12.2s"), "the duration is truncated to 0.1s, not rounded");
});

test("reasoning does not show a duration when none was recorded", () => {
  const entry: Entry = { kind: "reasoning", text: "First I need to consider the options." };
  const collapsed = text(entryLines(entry, COLS));
  assert.ok(!collapsed.includes("thought for"), "no duration means no timer");
  assert.ok(collapsed.includes("thinking"), "just the thinking label");
});

test("reasoning expands to the full body when asked", () => {
  const entry: Entry = { kind: "reasoning", text: "First I need to consider the options carefully and weigh them." };
  const expanded = text(entryLines(entry, COLS, true));
  assert.ok(expanded.includes("weigh them"), "the full body is shown when expanded");
  assert.ok(!expanded.includes("…"), "no truncation when expanded");
});

test("formatTimer truncates instead of rounding", () => {
  assert.equal(formatTimer(12.25), "12.2s", "0.1s accuracy, truncated");
  assert.equal(formatTimer(5), "5.0s", "whole seconds still show a tenth");
  assert.equal(formatTimer(72), "1m 12s", "minutes and seconds");
  assert.equal(formatTimer(72.9), "1m 12s", "seconds truncated, not rounded");
  assert.equal(formatTimer(7980), "2h 13m", "hours and minutes");
  assert.equal(formatTimer(0), "0.0s", "zero");
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

test("long streamed text is not silently cut", () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const rows = liveLines({ text: long, reasoning: "" }, 0, 0, COLS, 10);
  const out = text(rows);
  assert.ok(out.includes("word59"), "the latest text is still shown");
});

test("a long prompt wraps into visible rows and keeps the caret on the right char", () => {
  const draft = "please explain in great detail how a hash map works internally including collisions";
  const built = composerRows({ cols: 40, draft, caret: draft.length, busy: false, maxHeight: 12 });
  const rows = built.rows.map((r) => r.map((s) => s.text).join(""));
  assert.ok(rows.length > 4, `the composer grew to hold the wrapped prompt (${rows.length} rows)`);
  assert.ok(rows.join("").includes("please explain"), "the full prompt is visible, not truncated");
});

test("a prompt taller than the box scrolls and counts what is above", () => {
  const draft = "x".repeat(400);
  const built = composerRows({ cols: 40, draft, caret: draft.length, busy: false, maxHeight: 6 });
  const out = built.rows.map((r) => r.map((s) => s.text).join("")).join("\n");
  assert.ok(/↑ \d+ more lines?/.test(out), "the scrolled-off lines are counted");
  assert.ok(built.rows.length <= 6, "the box never exceeds its max height");
});

test("streaming reasoning is a multi-row card, not one line", () => {
  const reasoning = "First I weigh separate chaining, then open addressing, then the load factor and resizing cost, which is a fair amount of text.";
  const rows = liveLines({ text: "", reasoning }, 0, 0, COLS, 20);
  const out = text(rows);
  assert.ok(out.includes("separate chaining"), "the streaming reasoning body is shown, expanded");
  assert.ok(rows.length > 3, `it streams onto several rows (${rows.length})`);
  // Readable contrast: the body is the muted tone, not the near-invisible dim.
  assert.ok(rows.some((r) => r.some((s) => s.color !== undefined && s.text.trim().length > 0)), "the reasoning has visible text");
});

test("composer topRight tears the hint into the top border", () => {
  const built = composerRows({ cols: 60, draft: "", caret: 0, busy: false, maxHeight: 6, topRight: "press ctrl c again to exit actor0" });
  const top = built.rows[0]!.map((s) => s.text).join("");
  assert.ok(top.includes("press ctrl c again to exit actor0"), `the hint is torn into the top border: ${top}`);
  assert.ok(top.startsWith("╭") && top.endsWith("╮"), "the border is still a rounded box");
});

test("a topRight wider than the box is clamped instead of spilling the border", () => {
  // Notices live in this slot now, and an error can be a whole sentence: a
  // label wider than the box would push the closing corner off the row.
  const label = "added example, but it didn't answer: no such host".repeat(3);
  const built = composerRows({ cols: 40, draft: "", caret: 0, busy: false, maxHeight: 6, topRight: label });
  const top = built.rows[0]!.map((s) => s.text).join("");
  assert.equal(top.length, 40, `the top border must stay the box's width: ${top}`);
  assert.ok(top.includes("…"), `the label is ellipsised, not cut mid-border: ${top}`);
  assert.ok(top.startsWith("╭") && top.endsWith("╮"), "the border is still a rounded box");
});

test("composer without topRight has a plain top border", () => {
  const built = composerRows({ cols: 60, draft: "", caret: 0, busy: false, maxHeight: 6 });
  const top = built.rows[0]!.map((s) => s.text).join("");
  assert.ok(!top.includes("press ctrl"), "no hint when topRight is absent");
  assert.ok(top.startsWith("╭") && top.endsWith("╮"), "the border is still a rounded box");
});

test("windowRows clamps offset at the top of the transcript", () => {
  const all = Array.from({ length: 100 }, (_, i) => `line-${i}`);
  const height = 20;
  // Offset 0 = bottom: shows last 20 lines
  const bottom = windowRows(all, height, 0);
  assert.equal(bottom.length, 20);
  assert.equal(bottom[0], "line-80");
  assert.equal(bottom[19], "line-99");

  // Offset way past max (1000) should clamp to max (80)
  const clamped = windowRows(all, height, 1000);
  assert.equal(clamped.length, 20);
  assert.equal(clamped[0], "line-0"); // top of transcript
  assert.equal(clamped[19], "line-19");
});

test("windowRows returns empty for zero height", () => {
  const all = ["a", "b", "c"];
  assert.deepEqual(windowRows(all, 0, 0), []);
  assert.deepEqual(windowRows(all, -1, 0), []);
});
