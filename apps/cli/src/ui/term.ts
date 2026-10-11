import process from "node:process";

/**
 * Our own fullscreen renderer.
 *
 * Ink is the wrong tool for this TUI and every symptom followed from fighting
 * it: a full-height frame makes the terminal scroll on every repaint (top cut
 * off, a stray line at the bottom), and re-rendering that tree on every streamed
 * token dropped characters and lagged. So we draw the screen ourselves.
 *
 * The model is the one Codex's TUI uses: the alternate screen, a grid we own and
 * rewrite in place each frame, the composer pinned to the bottom, and scrolling
 * that moves a transcript offset within the grid. No layout engine, no frame as
 * tall as the terminal, no per-token reconciliation of the whole tree — just
 * strings written at rows we choose. It is small, and it is ours, so it cannot
 * fight a renderer.
 */
export class Screen {
  private stream: NodeJS.WriteStream;
  private rows = 24;
  private cols = 80;
  private live = false;

  constructor(stream: NodeJS.WriteStream = process.stdout) {
    this.stream = stream;
    this.cols = stream.columns ?? 80;
    this.rows = stream.rows ?? 24;
  }

  get size(): { rows: number; cols: number } {
    return { rows: this.rows, cols: this.cols };
  }

  setSize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
  }

  /** Enter the alternate screen and hide the caret — we draw our own. */
  begin(): void {
    if (this.live) return;
    this.live = true;
    this.stream.write("\x1b[?1049h\x1b[?25l");
  }

  /**
   * Write a full grid of `rows` lines, top to bottom, in place. Home, then each
   * line cleared and written — the alternate screen never scrolls, so this only
   * ever repaints the visible frame and the composer row is stable.
   */
  render(rows: string[]): void {
    this.begin();
    this.stream.write("\x1b[H");
    for (let i = 0; i < this.rows; i += 1) {
      this.stream.write("\x1b[2K");
      const line = rows[i] ?? "";
      this.stream.write(line.length > this.cols ? line.slice(0, this.cols) : line);
      this.stream.write(i < this.rows - 1 ? "\r\n" : "");
    }
  }

  /** Park the caret at an absolute 1-based row/column (the composer input). */
  caret(row: number, col: number): void {
    this.stream.write(`\x1b[${Math.max(1, Math.min(this.rows, row))};${Math.max(1, Math.min(this.cols, col))}H\x1b[?25h`);
  }

  /** Hide the caret (when no text input is focused). */
  hideCaret(): void {
    this.stream.write("\x1b[?25l");
  }

  /** Restore the terminal on the way out. */
  dispose(): void {
    if (!this.live) return;
    this.live = false;
    this.stream.write("\x1b[?25h\x1b[?1049l");
  }
}
