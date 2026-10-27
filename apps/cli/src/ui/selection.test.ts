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

test("extending without an anchor is a no-op", () => {
  // A release with no press, or a stray motion event, must not invent one.
  const s = emptySelection();
  assert.deepEqual(extend(s, { col: 1, row: 1 }, ROWS, COLS), s);
});
