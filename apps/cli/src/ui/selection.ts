/**
 * Text selection over the painted frame.
 *
 * The renderer already has what a selection needs and throws it away one line
 * too early: `buildGrid` builds `Seg[][]`, `fitWidth` pads every row to exactly
 * `innerW` visible columns, and `paint` turns each segment into a string with
 * its own colour and background. So a selection is not a new buffer — it is a
 * range over (row, column) that `paint` is told about, and the copied text is
 * recovered from the same segments.
 *
 * That matters because native terminal selection cannot coexist with the wheel:
 * `term.ts` enables SGR mouse reporting (`?1000h`, `?1006h`), which makes the
 * terminal hand drags to us instead of selecting. Owning selection is what lets
 * both work at once.
 *
 * This file is pure: points in, strings out, no screen and no clipboard, so the
 * arithmetic that is silent when it is wrong can be tested directly.
 */

/** A cell address in the painted frame: column and row are 0-based. */
export type Point = { col: number; row: number };

export type SelectionState = {
  /** Where the drag started. Null when nothing is selected. */
  anchor: Point | null;
  /** Where the pointer is now (or was on release). */
  focus: Point | null;
  /** True between mouse-down and mouse-up. */
  dragging: boolean;
};

export function emptySelection(): SelectionState {
  return { anchor: null, focus: null, dragging: false };
}

export function hasSelection(s: SelectionState): boolean {
  return s.anchor !== null && s.focus !== null;
}

/** Reading order: row first, then column. */
function compare(a: Point, b: Point): number {
  if (a.row !== b.row) return a.row < b.row ? -1 : 1;
  if (a.col !== b.col) return a.col < b.col ? -1 : 1;
  return 0;
}

/** Normalised bounds — start is always before end — or null when empty. */
export function bounds(s: SelectionState): { start: Point; end: Point } | null {
  if (!s.anchor || !s.focus) return null;
  return compare(s.anchor, s.focus) <= 0
    ? { start: s.anchor, end: s.focus }
    : { start: s.focus, end: s.anchor };
}

export function clampPoint(p: Point, rows: number, cols: number): Point {
  return {
    row: Math.max(0, Math.min(rows - 1, p.row)),
    col: Math.max(0, Math.min(cols - 1, p.col)),
  };
}

/** Begin a selection at `p`, clamped to the frame, replacing any previous one. */
export function begin(p: Point, rows: number, cols: number): SelectionState {
  const q = clampPoint(p, rows, cols);
  return { anchor: q, focus: q, dragging: true };
}

/** Extend the focus to `p`. A no-op when no drag is in progress. */
export function extend(s: SelectionState, p: Point, rows: number, cols: number): SelectionState {
  if (!s.anchor) return s;
  return { ...s, focus: clampPoint(p, rows, cols), dragging: true };
}

/** End the drag. The selection stays visible — the highlight is the receipt. */
export function finish(s: SelectionState): SelectionState {
  return s.dragging ? { ...s, dragging: false } : s;
}

/** Is the cell at (row, col) inside the selection? */
export function covers(s: SelectionState, row: number, col: number): boolean {
  const b = bounds(s);
  if (!b) return false;
  if (row < b.start.row || row > b.end.row) return false;
  if (row === b.start.row && col < b.start.col) return false;
  if (row === b.end.row && col > b.end.col) return false;
  return true;
}

/**
 * The selected text, given the visible rows as plain strings.
 *
 * Rows join with newlines. A row's selection starts at `start.col` on the first
 * row and runs to `end.col` on the last; rows between are taken whole. Trailing
 * whitespace is trimmed per row, because every row is padded to the full frame
 * width and copying that padding is never what anyone wants.
 *
 * Columns are string indices, which is exact for the text the transcript is
 * made of. Wide characters occupy two terminal columns but one string index, so
 * a selection over CJK or emoji can land a column off — documented rather than
 * papered over.
 */
export function selectedText(s: SelectionState, lines: string[]): string {
  const b = bounds(s);
  if (!b) return "";
  const out: string[] = [];
  for (let row = b.start.row; row <= b.end.row; row += 1) {
    const line = lines[row];
    if (line === undefined) break;
    const from = row === b.start.row ? b.start.col : 0;
    const to = row === b.end.row ? b.end.col + 1 : line.length;
    out.push(line.slice(from, Math.max(from, to)).replace(/\s+$/, ""));
  }
  return out.join("\n");
}

/**
 * The inclusive column spans a selection covers, one per row, for restyling.
 * Split out so the arithmetic is testable without a screen.
 */
export function spans(s: SelectionState, cols: number): { row: number; from: number; to: number }[] {
  const b = bounds(s);
  if (!b) return [];
  const out: { row: number; from: number; to: number }[] = [];
  for (let row = b.start.row; row <= b.end.row; row += 1) {
    const from = row === b.start.row ? b.start.col : 0;
    const to = row === b.end.row ? Math.min(b.end.col, cols - 1) : cols - 1;
    if (to >= from) out.push({ row, from, to });
  }
  return out;
}
