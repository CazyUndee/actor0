/**
 * A deliberately small model of the terminal screen, fed the exact byte stream
 * Ink writes to stdout. Its one job is to answer a single question that Ink does
 * not expose: *where on the screen is the composer's send button right now?*
 *
 * A `<Box onClick>`-style component in a stock Ink render has no idea where its
 * pixels landed — Ink positions the whole live frame with relative cursor moves
 * and erases with line-kills, and the frame's absolute row drifts with the
 * scrollback above it. Mouse clicks arrive at absolute terminal rows, so the
 * only way to hit-test one is to reconstruct those rows from Ink's own output.
 *
 * It is intentionally not a full VT. It handles only what Ink (via log-update)
 * actually emits here — printable text, `\n`, `\r`, and the cursor/erase CSI
 * forms in the switch below — plus resizes. Anything else is ignored, which is
 * safe: the tracked quantity is the last non-empty row, and an unmodelled
 * sequence cannot make a written row un-written.
 */
export class ScreenModel {
  private rows: number;
  private cols: number;
  private grid: string[];
  private row = 0;
  private col = 0;
  // Ink may split a CSI sequence across write() chunk boundaries; hold the
  // incomplete tail until the rest arrives, exactly as the stdin filter does.
  private pending = "";

  constructor(rows: number, cols: number) {
    this.rows = Math.max(1, rows);
    this.cols = Math.max(1, cols);
    this.grid = Array.from({ length: this.rows }, () => "");
  }

  resize(rows: number, cols: number): void {
    this.rows = Math.max(1, rows);
    this.cols = Math.max(1, cols);
    if (this.grid.length > this.rows) this.grid.length = this.rows;
    while (this.grid.length < this.rows) this.grid.push("");
  }

  /** Feed a chunk of Ink's stdout. Cheap enough to run on every write. */
  feed(data: string): void {
    this.pending += data;
    let i = 0;
    while (i < this.pending.length) {
      const ch = this.pending[i];
      if (ch === "\x1b") {
        // eslint-disable-next-line no-control-regex -- ESC begins every CSI sequence ink emits
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(this.pending.slice(i));
        if (!m) break; // incomplete (or non-CSI) escape: wait for the rest of it
        const nums = m[1] ? m[1].split(";").map((x) => Number.parseInt(x, 10)) : [];
        this.clamp();
        switch (m[2]) {
          case "A": this.row = Math.max(0, this.row - (nums[0] || 1)); break;
          case "B": this.row = Math.min(this.rows - 1, this.row + (nums[0] || 1)); break;
          case "C": this.col += nums[0] || 1; break;
          case "D": this.col = Math.max(0, this.col - (nums[0] || 1)); break;
          case "G": this.col = Math.max(0, (nums[0] || 1) - 1); break;
          case "H": this.row = Math.max(0, (nums[0] || 1) - 1); this.col = Math.max(0, (nums[1] || 1) - 1); break;
          // Erase-in-line: the repaint loop Ink uses to clear the previous
          // frame walks up a line at a time and clears each with `2K`. Not
          // modelling this leaves the old frame's rows behind and inflates
          // lastContentRow(), putting the send row below the screen.
          case "K": this.eraseLine(nums[0] || 0); break;
          case "J": if ((nums[0] || 0) === 2) { this.row = 0; this.col = 0; this.grid.fill(""); } break;
          default: break; // "m" and "?"-prefixed private modes carry no positional weight
        }
        i += m[0].length;
        continue;
      }
      if (ch === "\n") { this.row = Math.min(this.rows - 1, this.row + 1); this.col = 0; }
      else if (ch === "\r") { this.col = 0; }
      else this.put(ch);
      i += 1;
    }
    this.pending = this.pending.slice(i);
  }

  private clamp(): void {
    if (this.row > this.rows - 1) this.row = this.rows - 1;
    if (this.col > this.cols - 1) this.col = this.cols - 1;
  }

  private eraseLine(mode: number): void {
    const line = this.grid[this.row] ?? "";
    if (mode === 2) this.grid[this.row] = "";
    else if (mode === 1) this.grid[this.row] = " ".repeat(Math.min(this.col, line.length)) + line.slice(this.col);
    else this.grid[this.row] = line.slice(0, this.col);
  }

  private put(ch: string) {
    const line = (this.grid[this.row] ?? "").split("");
    while (line.length < this.col) line.push(" ");
    line[this.col] = ch;
    this.grid[this.row] = line.join("");
    this.col += 1;
    if (this.col > this.cols - 1) this.col = this.cols - 1; // ink writes full rows explicitly; no soft wrap
  }

  /** The row index (0-based) of the last row that holds any text, or -1. */
  lastContentRow(): number {
    for (let i = this.grid.length - 1; i >= 0; i -= 1) if ((this.grid[i] ?? "").trim().length > 0) return i;
    return -1;
  }

  /** A copy of the tracked rows. Used by tests to locate a row by content. */
  lines(): string[] {
    return [...this.grid];
  }
}
