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
  private mouse: boolean;

  constructor(stream: NodeJS.WriteStream = process.stdout, opts: { mouse?: boolean } = {}) {
    this.stream = stream;
    this.cols = stream.columns ?? 80;
    this.rows = stream.rows ?? 24;
    // Mouse capture is what breaks terminal-native copy-paste, so it is
    // opt-out (ACTOR0_DISABLE_MOUSE) — keyboard scroll always works regardless.
    this.mouse = opts.mouse ?? true;
  }

  get size(): { rows: number; cols: number } {
    return { rows: this.rows, cols: this.cols };
  }

  setSize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
  }

  /** Enter the alternate screen, hide the caret, and (optionally) the mouse. */
  begin(): void {
    if (this.live) return;
    this.live = true;
    // Alt screen; hide the caret we draw ourselves; and enable mouse reporting
    // in SGR mode (1000h + 1006h) so the wheel can scroll and clicks register.
    // Without this the terminal emits none of the sequences input.ts parses, so
    // the wheel is dead in a real terminal even though the tests inject them.
    this.stream.write("\x1b[?1049h\x1b[?25l");
    if (this.mouse) this.stream.write("\x1b[?1000h\x1b[?1006h");
  }

  /**
   * Write a full grid of `rows` lines, top to bottom, in place. Each line is
   * positioned explicitly at its row (CUP) and cleared before it is written —
   * never joined with CR/LF. Every line is built to exactly `cols` visible
   * columns, so writing the last one leaves the terminal in "pending wrap"; a
   * following CR/LF would then realise that wrap and skip a row, the frame
   * would grow past the terminal, and the alt screen would scroll — duplicating
   * the bottom rows. An explicit CUP to the next row discards the pending wrap,
   * so nothing accumulates and the composer row is stable.
   *
   * Lines are written whole, never sliced by length: they are coloured strings,
   * so `length` counts the ANSI escapes (zero width on screen) and slicing by it
   * would cut the right edge off mid-escape — a missing border, a teleporting
   * cursor, garbage. Each line is built to exactly `cols` visible columns, so it
   * fills the cleared row and never wraps.
   */
  render(rows: string[]): void {
    this.begin();
    for (let i = 0; i < this.rows; i += 1) {
      this.stream.write(`\x1b[${i + 1};1H\x1b[2K${rows[i] ?? ""}`);
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
    if (this.mouse) this.stream.write("\x1b[?1000l\x1b[?1006l");
    this.stream.write("\x1b[?25h\x1b[?1049l");
  }
}
