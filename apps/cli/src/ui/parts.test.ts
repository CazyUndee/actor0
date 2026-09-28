import assert from "node:assert/strict";
import test from "node:test";
import { bannerActivity, bannerLines, fitTail, shortenPath, toolDetail, wrapText } from "./parts.js";

/**
 * The footer's layout arithmetic and the live region's height budget, without
 * a terminal.
 *
 * This used to cover the transcript's height budget as well — `fitEntries`,
 * `windowEntries`, `estimateEntryRows` — all of which existed to keep a bounded
 * window of the conversation on screen. The transcript now lives in the
 * terminal's scrollback, so there is no window to size and nothing to fit.
 *
 * What replaced them is `fitTail`, which bounds only the in-flight answer. That
 * one still matters: an unbounded frame is what puts Ink into the clear-and-
 * repaint mode that wipes the scrollback, so the budget is not cosmetic.
 */

test("a path that fits is left alone", () => {
  assert.equal(shortenPath("C:\\work\\app", 20), "C:\\work\\app");
  assert.equal(shortenPath("~/code/thing", 40), "~/code/thing");
});

test("shortening keeps the end of the path, not the start", () => {
  const full = "C:\\Users\\someone\\AppData\\Local\\Temp\\actor0-preview-abc123\\summary.md";
  const short = shortenPath(full, 30);
  assert.ok(short.length <= 30, `got ${short.length} chars: ${short}`);
  assert.ok(short.startsWith("…"), "the truncation marker leads");
  assert.ok(short.endsWith("summary.md"), `lost the filename: ${short}`);
});

test("shortening a path with no separators truncates from the left", () => {
  const short = shortenPath("a".repeat(80), 20);
  assert.ok(short.length <= 20);
  assert.ok(short.startsWith("…"));
});

test("shortening degrades gracefully at one character of budget", () => {
  const short = shortenPath("C:\\a\\b\\c\\d\\e", 4);
  assert.ok(short.length <= 4, `got ${short.length}: ${short}`);
});

test("the marker is paid for out of the budget, not added on top", () => {
  for (const max of [2, 3, 4, 5, 8, 12, 20]) {
    // The backslashes are doubled deliberately. Written as `"C:\a\b\c\d\e"`
    // this reads like a Windows path, but only `\b` is a real string escape —
    // it is a backspace — and `\a`, `\c`, `\d` and `\e` are not escapes at all,
    // so they collapse to the bare letters `a`, `c`, `d`, `e`. What reached
    // `shortenPath` was one unbroken segment with no separator anywhere in it,
    // which sent it down the single-segment early return and left the
    // multi-segment budget this test is named for completely unexercised.
    const short = shortenPath("C:\\a\\b\\c\\d\\e", max);
    assert.ok(short.length <= max, `max ${max} produced ${short.length} chars: ${short}`);
  }
});

test("a single-segment path never exceeds the budget either", () => {
  for (const max of [1, 2, 3, 5]) {
    const short = shortenPath("abcdefghij", max);
    assert.ok(short.length <= max, `max ${max} produced ${short.length}: ${short}`);
  }
});

test("text that fits is untouched", () => {
  assert.equal(fitTail("one\ntwo\nthree", 10, 80), "one\ntwo\nthree");
  assert.equal(fitTail("", 10, 80), "");
});

test("the tail is kept and the head dropped", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const kept = fitTail(lines.join("\n"), 5, 80);
  assert.deepEqual(kept.split("\n"), ["line 45", "line 46", "line 47", "line 48", "line 49"]);
});

test("wrapping is counted, so wide lines cannot slip past the budget", () => {
  // Four 201-character lines occupy three terminal rows each at 78 columns.
  // Counting them as four lines would pass all twelve rows through a seven-row
  // budget.
  const wide = `${0}${"x".repeat(200)}`;
  const source = Array.from({ length: 4 }, (_, i) => `${i}${"x".repeat(200)}`).join("\n");
  assert.equal(wide.length, 201);
  const kept = fitTail(source, 7, 80);
  assert.equal(kept.split("\n").length, 2, "only two 3-row lines fit in a 7-row budget");
});

test("the newest line survives even when it alone over-runs the budget", () => {
  // Dropping it would blank the live region exactly when there is something to
  // show, which reads as a stalled turn rather than a tall paragraph.
  const kept = fitTail("x".repeat(400), 3, 80);
  assert.equal(kept.length, 400);
});

test("a zero or negative budget yields nothing rather than throwing", () => {
  assert.equal(fitTail("anything", 0, 80), "");
  assert.equal(fitTail("anything", -5, 80), "");
});

test("a budget of one row still shows the newest line", () => {
  const kept = fitTail("old\nnewest", 1, 80);
  assert.equal(kept, "newest");
});

test("wrapping leaves no leading space on the continuation line", () => {
  // Ink wraps with trim:false and keeps the space it broke on, so pre-wrapping
  // is what keeps ordinary prose from looking mis-indented.
  const wrapped = wrapText("I am listing the files in the directory to understand it", 30);
  for (const line of wrapped.split("\n")) {
    assert.equal(line, line.trimStart(), `line has a leading space: ${JSON.stringify(line)}`);
  }
});

test("wrapping never loses or duplicates a word", () => {
  const source = "the quick brown fox jumps over the lazy dog again and again and again";
  assert.equal(wrapText(source, 20).split(/\s+/).join(" "), source);
});

test("a word longer than the line is cut rather than dropped", () => {
  const wrapped = wrapText("short " + "x".repeat(50), 20);
  assert.equal(wrapped.replace(/\s+/g, ""), ("short" + "x".repeat(50)).replace(/\s+/g, ""));
});

test("text that fits is not touched, and existing newlines are kept", () => {
  assert.equal(wrapText("one\ntwo", 80), "one\ntwo");
  assert.equal(wrapText("short line", 80), "short line");
});

const card = (over: Partial<Parameters<typeof bannerLines>[0]> = {}) =>
  bannerLines({
    title: "actor0",
    version: "0.1.0",
    model: "gpt-5.6-terra",
    endpoint: "aestral-chat.vercel.app",
    directory: "~/projects/actor0-cli",
    activity: "ready",
    width: 60,
    ...over,
  });
const text = (lines: ReturnType<typeof bannerLines>) => lines.map((line) => line.map((c) => c.text).join(""));

test("every line of the card is the same width, border to border", () => {
  // The short lines are the trap: a title and a blank row are far narrower than
  // the box, and without padding to the inner width the right border falls off
  // them and the card stops reading as a box.
  const rendered = text(card());
  const widths = new Set(rendered.map((line) => line.length));
  assert.equal(widths.size, 1, `ragged card: ${[...widths].join(", ")}`);
  assert.ok(rendered[0]!.startsWith("╭") && rendered[0]!.endsWith("╮"));
  assert.ok(rendered.at(-1)!.startsWith("╰") && rendered.at(-1)!.endsWith("╯"));
});

test("the card opens and closes with corners and sides with pipes", () => {
  const rendered = text(card());
  assert.match(rendered[0]!, /^╭─+╮$/);
  assert.match(rendered.at(-1)!, /^╰─+╯$/);
  for (const line of rendered.slice(1, -1)) {
    assert.ok(line.startsWith("│ ") && line.endsWith(" │"), `not sided: ${JSON.stringify(line)}`);
  }
});

test("the label column is the same width on every row", () => {
  const rendered = text(card());
  const rows = rendered.filter((line) => /^│ (model|endpoint|directory|activity):/.test(line));
  assert.equal(rows.length, 4);
  // `│ ` is two columns and the label column is eleven, so every value has to
  // begin at the same one or the card reads as four unrelated lines.
  const starts = rows.map((row) => {
    const at = row.slice(13).search(/\S/);
    return at === -1 ? -1 : at + 13;
  });
  assert.deepEqual([...new Set(starts)], [13], `values start at ${starts.join(", ")}`);
});

test("the hint is right-aligned in the value column", () => {
  const rendered = text(card({ hint: "/model to change" }));
  const model = rendered[3]!;
  // Strip the borders before asking whether it is flush: the line ends in " │",
  // which trimEnd cannot remove, and the hint would always look one short.
  const inner = model.slice(2, -2);
  assert.ok(inner.includes("gpt-5.6-terra"), "the value was pushed out by its hint");
  assert.ok(inner.trimEnd().endsWith("/model to change"), `the hint is not flush right: ${JSON.stringify(inner)}`);
});

test("a value too long for its column is cut, not wrapped", () => {
  const rendered = text(card({ model: "m".repeat(200), width: 50 }));
  for (const line of rendered) assert.ok(line.length <= 50, `line overflowed: ${line.length}`);
  assert.ok(rendered[3]!.includes("…"));
});

test("a narrow terminal still produces a closed card", () => {
  const rendered = text(card({ width: 10, model: "x".repeat(80) }));
  const widths = new Set(rendered.map((line) => line.length));
  assert.equal(widths.size, 1, "the card fell apart when squeezed");
});

test("the activity row reports the thing happening now", () => {
  const live = (over: Record<string, unknown> = {}) =>
    ({ text: "", reasoning: "", partial: false, ...over }) as Parameters<typeof bannerActivity>[0];
  assert.equal(bannerActivity(live()), "ready");
  assert.equal(bannerActivity(live({ status: "Checking repository access" })), "Checking repository access");
  assert.equal(bannerActivity(live({ tool: { name: "bash", target: "ls -F" } })), "bash ls -F");
  assert.equal(bannerActivity(live({ retrying: { attempt: 2 } })), "retrying (attempt 2)");
  assert.equal(bannerActivity(live({ text: "First sentence. The latest one." })), "The latest one.");
});

test("a successful call shows one line of what it returned", () => {
  assert.equal(toolDetail("ok", "notes.md\nREADME.md\nsrc"), "notes.md");
});

test("a successful call's line is flattened, so a wrapping table stays readable", () => {
  assert.equal(toolDetail("ok", "total  12\tdrwxr-xr-x  root  root"), "total 12 drwxr-xr-x root root");
});

test("a bare section label is skipped in favour of what it labels", () => {
  // The bash tool writes "stderr:" above the message. Reporting the label would
  // tell the reader nothing about why the command produced no stdout.
  assert.equal(
    toolDetail("ok", "stderr:\nwc: missing.md: No such file or directory\n\nCommand exited with code 1"),
    "wc: missing.md: No such file or directory",
  );
});

test("a message that merely contains a colon is not mistaken for a label", () => {
  assert.equal(toolDetail("ok", "error: disk full"), "error: disk full");
});

test("a command that succeeded silently says so", () => {
  assert.equal(toolDetail("ok", "(no output)"), "(no output)");
});

test("a successful call's line is capped rather than allowed to flood the trace", () => {
  const detail = toolDetail("ok", "x".repeat(400));
  assert.equal(detail.length, 100);
  assert.ok(detail.endsWith("…"));
});

test("empty output says nothing rather than printing a blank line", () => {
  assert.equal(toolDetail("ok", ""), "");
  assert.equal(toolDetail("ok", "   \n  "), "");
  assert.equal(toolDetail("error", ""), "");
});

test("a failure keeps every line, because the message is the point", () => {
  const message = "exit 127\nbash: ls: command not found";
  assert.equal(toolDetail("error", message), message);
});

test("a very long failure is capped and says how much was dropped", () => {
  const detail = toolDetail("error", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(detail.split("\n").length, 9);
  assert.match(detail.split("\n").at(-1)!, /22 more lines$/);
});
