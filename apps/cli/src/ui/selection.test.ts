import { test } from "node:test";
import assert from "node:assert/strict";
import {
  begin,
  bounds,
  covers,
  emptySelection,
  extend,
  finish,
  hasSelection,
  selectedText,
  spans,
} from "./selection.js";
import { highlight } from "./render.js";

const ROWS = 3;
const COLS = 10;
const lines = ["hello worl", "second row", "third  row"];

test("a fresh selection is empty and covers nothing", () => {
  const s = emptySelection();
  assert.equal(hasSelection(s), false);
  assert.equal(bounds(s), null);
  assert.equal(covers(s, 0, 0), false);
  assert.equal(selectedText(s, lines), "");
  assert.deepEqual(spans(s, COLS), []);
});

test("a drag selects between its endpoints, in either direction", () => {
  // Forward then backward must cover the same cells — a selection is a range,
  // not a direction.
  const forward = extend(begin({ col: 2, row: 0 }, ROWS, COLS), { col: 4, row: 0 }, ROWS, COLS);
  const backward = extend(begin({ col: 4, row: 0 }, ROWS, COLS), { col: 2, row: 0 }, ROWS, COLS);
  for (const s of [forward, backward]) {
    assert.equal(covers(s, 0, 2), true);
    assert.equal(covers(s, 0, 4), true);
    assert.equal(covers(s, 0, 1), false, "before the start is outside");
    assert.equal(covers(s, 0, 5), false, "after the end is outside");
  }
});

test("a multi-row selection takes the middle rows whole", () => {
  const s = extend(begin({ col: 3, row: 0 }, ROWS, COLS), { col: 2, row: 2 }, ROWS, COLS);
  // First row from col 3, middle row whole, last row to col 2 inclusive.
  assert.equal(selectedText(s, lines), "lo worl\nsecond row\nthi", "the last row stops at its end column, inclusive");
});

test("trailing padding is trimmed, because every row is padded", () => {
  const padded = ["ab        ", "cd        "];
  const s = extend(begin({ col: 0, row: 0 }, 2, COLS), { col: 9, row: 1 }, 2, COLS);
  assert.equal(selectedText(s, padded), "ab\ncd");
});

test("a selection is anchored to text rows, not screen rows", () => {
  // Scrolling the transcript changes which rows are on screen, but the
  // selection's row indices refer to the content array passed in, so the
  // same selection still selects the same text.
  const lines = ["alpha", "beta", "gamma"];
  const s = extend(begin({ col: 0, row: 1 }, 3, 5), { col: 4, row: 1 }, 3, 5);
  assert.equal(selectedText(s, lines), "beta");
  // Re-slicing (as a scroll would) keeps the selection valid on the same
  // content identity.
  assert.equal(selectedText(s, lines.slice()), "beta");
});

test("spans are inclusive per row and clamped to the width", () => {
  const s = extend(begin({ col: 2, row: 0 }, ROWS, COLS), { col: 4, row: 1 }, ROWS, COLS);
  assert.deepEqual(spans(s, COLS), [
    { row: 0, from: 2, to: COLS - 1 },
    { row: 1, from: 0, to: 4 },
  ]);
});

test("points are clamped to the frame, so a drag past the edge still selects", () => {
  const s = begin({ col: -5, row: -1 }, ROWS, COLS);
  assert.deepEqual(s.anchor, { col: 0, row: 0 });
  const far = extend(s, { col: 999, row: 999 }, ROWS, COLS);
  assert.deepEqual(far.focus, { col: COLS - 1, row: ROWS - 1 });
});

test("finishing keeps the selection visible and clears the drag flag", () => {
  const dragged = extend(begin({ col: 0, row: 0 }, ROWS, COLS), { col: 1, row: 0 }, ROWS, COLS);
  assert.equal(dragged.dragging, true);
  const done = finish(dragged);
  assert.equal(done.dragging, false);
  assert.equal(hasSelection(done), true, "the highlight is the receipt — it stays");
});

test("the highlight splits segments and keeps their colour", () => {
  // Syntax-highlighted text must not fragment: a background over columns 2..4
  // of a two-colour row stays two runs, each keeping its own foreground.
  const row = [
    { text: "ab", color: "#111111" },
    { text: "cdef", color: "#222222" },
  ];
  // Columns 2..4 sit inside the second segment (which covers 2..5), so it
  // splits once: "cde" highlighted, "f" untouched, and the first segment whole.
  const out = highlight(row, 2, 4, "#444444");
  assert.deepEqual(out, [
    { text: "ab", color: "#111111" },
    { text: "cde", color: "#222222", bg: "#444444" },
    { text: "f", color: "#222222" },
  ]);
  assert.equal(out.map((s) => s.text).join(""), "abcdef", "no character is lost or duplicated");
});

test("the highlight leaves rows it does not touch alone", () => {
  const row = [{ text: "abcd" }];
  assert.deepEqual(highlight(row, 10, 12, "#444444"), row);
  assert.deepEqual(highlight(row, 0, 3, "#444444"), [{ text: "abcd", bg: "#444444" }]);
});

test("extending without an anchor is a no-op", () => {
  // A release with no press, or a stray motion event, must not invent one.
  const s = emptySelection();
  assert.deepEqual(extend(s, { col: 1, row: 1 }, ROWS, COLS), s);
});
