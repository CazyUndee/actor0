import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import type { ReactNode } from "react";
import type { Entry } from "../conversation.js";
import { entryRows, liveRows, windowRows, stateFace } from "./scroll.js";
import { ScreenModel } from "./screen-model.js";

/** Render rows through a screen model and return the non-empty lines. */
function rowLines(nodes: ReactNode[], columns = 80): string[] {
  const screen = new ScreenModel(60, columns);
  const stdout = new PassThrough();
  stdout.on("data", (c: Buffer) => screen.feed(c.toString("utf8")));
  Object.assign(stdout, { columns, rows: 60 });
  const instance = render(<Box flexDirection="column">{nodes}</Box>, { stdout: stdout as never, debug: true });
  // debug writes the full frame during the initial (synchronous) render.
  const lines = screen.lines().filter((line) => line.trim().length > 0);
  instance.unmount();
  return lines;
}

test("a user entry is a single content row", () => {
  assert.equal(rowLines(entryRows({ kind: "user", text: "hi there" }, 80)).length, 1);
});

test("a wrapped answer occupies one row per wrapped line", () => {
  const entry: Entry = { kind: "assistant", text: "x".repeat(200), partial: false };
  // 200 x's wrap to 3 rows at the 78-column prose width.
  assert.equal(rowLines(entryRows(entry, 80)).length, 3);
});

test("a partial answer adds a trailing warning row", () => {
  assert.ok(rowLines(entryRows({ kind: "assistant", text: "done", partial: false }, 80)).every((l) => !l.includes("ended before completion")));
  assert.ok(rowLines(entryRows({ kind: "assistant", text: "done", partial: true }, 80)).some((l) => l.includes("ended before completion")));
});

test("a code line is one row however long — never wrapped", () => {
  const long = "a-very-long-command-".repeat(10); // 190 chars, far wider than the terminal
  const entry: Entry = { kind: "assistant", text: "```\n" + long + "\n```", partial: false };
  // open fence + the one long body row + close fence. Wrapping the body would
  // turn this into a dozen rows; it stays one, however long, and is truncated.
  assert.equal(rowLines(entryRows(entry, 80)).length, 3);
});

test("a tool row shows the tool's label and a ⎿ gutter for its output", () => {
  const entry: Entry = { kind: "tool", name: "shell", target: "ls", status: "ok", output: "a.ts\nb.ts" };
  const text = rowLines(entryRows(entry, 80)).join("\n");
  assert.ok(text.includes("$"), "the shell tool renders as $");
  assert.ok(text.includes("ls"), "the target is shown");
  assert.ok(text.includes("⎿"), "output sits under the ⎿ gutter");
});

test("liveRows is empty when nothing is happening", () => {
  assert.equal(liveRows({ text: "", reasoning: "", partial: false }, 0, 0, 80, 10).length, 0);
});

test("liveRows surfaces a tool in flight", () => {
  const rows = liveRows({ text: "", reasoning: "", partial: false, tool: { name: "shell", target: "ls" } }, 0, 0, 80, 10);
  assert.ok(rowLines(rows).join("\n").includes("shell"));
});

/** windowRows: the scrolling primitive behind "wheel moves the transcript only". */
test("windowRows shows the tail when pinned to the bottom", () => {
  const rows = Array.from({ length: 30 }, (_, i) => `row ${i}`);
  assert.deepEqual(windowRows(rows, 10, 0), rows.slice(20));
});

test("windowRows scrolls up by the offset, clamped to the content", () => {
  const rows = Array.from({ length: 30 }, (_, i) => `row ${i}`);
  assert.deepEqual(windowRows(rows, 10, 5), rows.slice(15, 25));
  assert.deepEqual(windowRows(rows, 10, 999), rows.slice(0, 10), "an offset past the top clamps to the start");
});

test("windowRows shows everything when content is shorter than the window", () => {
  assert.deepEqual(windowRows(["a", "b"], 10, 0), ["a", "b"]);
});

test("stateFace reads the mood off the conversation state, worst first", () => {
  const quiet = { text: "", reasoning: "", partial: false };
  assert.equal(stateFace({ live: quiet, lastEntry: { kind: "notice", tone: "error", text: "e" }, blocked: false, busy: false }), "dead", "an API error is dead");
  assert.equal(stateFace({ live: quiet, lastEntry: { kind: "tool", name: "shell", target: "", status: "error", output: "" }, blocked: false, busy: false }), "suffering", "a failed tool is suffering, not dead");
  assert.equal(stateFace({ live: quiet, lastEntry: undefined, blocked: true, busy: false }), "confused", "a blocked turn is confused");
  assert.equal(stateFace({ live: { ...quiet, reasoning: "hmm" }, lastEntry: undefined, blocked: false, busy: true }), "thinking", "reasoning is thinking");
  assert.equal(stateFace({ live: { ...quiet, text: "hi" }, lastEntry: undefined, blocked: false, busy: true }), "normal", "a turn producing output is normal");
  assert.equal(stateFace({ live: quiet, lastEntry: undefined, blocked: false, busy: false }), "idle", "nothing happening is idle");
});
