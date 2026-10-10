import { ScreenModel } from "./screen-model.js";

/**
 * Real mouse-to-send, the thing a stock Ink render does not give you: a click
 * on the composer's send button submits the draft, exactly like Enter.
 *
 * There are two halves, and each hides a trap:
 *
 * 1. **Enabling tracking pollutes the keystroke stream.** The moment mouse mode
 *    is on, every click arrives on stdin as an SGR escape (`\x1b[<…M/m`). Ink
 *    reads that same stdin and would turn each click into garbage typed into the
 *    composer. So stdin is handed to Ink through a proxy that strips the mouse
 *    sequences off before Ink ever sees them and forwards only real keys.
 *
 * 2. **The button's position is not knowable from React.** Ink lays out the
 *    live frame with relative cursor moves and the frame drifts with the
 *    scrollback above it, so there is no constant row to hit. The stdout written
 *    to the terminal is fed through {@link ScreenModel}, which reconstructs the
 *    rows; the send button is a fixed offset above the last row of the frame.
 *
 * Clicking does nothing unless it lands squarely on the button, so a mis-track
 * degrades to "unclickable", never to "sends the wrong thing".
 */

/** Enable press/release reporting in SGR mode (works past 223 columns). */
const ENABLE = "\x1b[?1000h\x1b[?1006h";
const DISABLE = "\x1b[?1000l\x1b[?1006l";

/**
 * The send button sits this many rows above the last row of the live frame
 * (the footer). Structural, not incidental: footer, then the status chips, then
 * the composer box's bottom border, then the send row. Pinned by
 * screen-model.test.ts, which renders the real UI and measures it.
 */
export const SEND_ROWS_ABOVE_FOOTER = 4;

/**
 * The send button is right-aligned in the composer; a click anywhere in this
 * many columns of the right edge counts. Kept generous so the highlight's
 * padding is clickable, but well clear of the left-aligned key hints.
 */
export const SEND_X_MARGIN = 12;

export type MouseClick = { x: number; y: number };

// eslint-disable-next-line no-control-regex -- matches the ESC that begins every SGR mouse report
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// A trailing partial CSI — everything an incomplete `\x1b[…` could still grow
// into. Held back until it completes so a sequence split across chunks is not
// mistaken for keys. A bare ESC (the Escape key) has no `[`, so it is never
// held and Escape keeps working.
// eslint-disable-next-line no-control-regex -- holds an incomplete ESC-led CSI
const PARTIAL_CSI = /\x1b\[[0-9;<>?]*$/;

/**
 * Split one stdin chunk into what Ink should see, where a click landed, and
 * whether the wheel turned.
 *
 * Complete SGR mouse reports are lifted out entirely (so none of them is typed
 * into the composer): a left-button release (`m`, b===0) becomes a click;
 * wheel-up (`M`, b===64) and wheel-down (`M`, b===65) accumulate into `scroll`
 * (positive is up, in notches). The leftover text is what Ink gets. A trailing
 * incomplete CSI is returned as `hold` (not forwarded) so a sequence split
 * across chunks reassembles instead of leaking half an escape into the composer.
 * A bare ESC has no `[`, so the Escape key is never held.
 */
export function filterMouseChunk(input: string): { inkText: string; clicks: MouseClick[]; scroll: number; hold: string } {
  const clicks: MouseClick[] = [];
  let scroll = 0;
  let text = "";
  let last = 0;
  MOUSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MOUSE_RE.exec(input))) {
    text += input.slice(last, m.index);
    last = m.index + m[0].length;
    const button = Number(m[1]);
    if (m[4] === "m" && button === 0) clicks.push({ x: Number(m[2]), y: Number(m[3]) });
    else if (m[4] === "M" && button === 64) scroll += 1;
    else if (m[4] === "M" && button === 65) scroll -= 1;
  }
  const rest = input.slice(last);
  const partial = PARTIAL_CSI.exec(rest);
  const hold = partial ? partial[0] : "";
  text += partial ? rest.slice(0, partial.index) : rest;
  return { inkText: text, clicks, scroll, hold };
}

export type MouseStreams = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  dispose: () => void;
};

/** Shared between `installMouse` (wired at boot) and the App (which owns send). */
export const mouseLink: {
  screen: ScreenModel | null;
  onClick: ((c: MouseClick) => void) | null;
  /** Wheel notches; +1 is up, -1 is down, per event. */
  onScroll: ((notches: number) => void) | null;
  columns: number;
} = { screen: null, onClick: null, onScroll: null, columns: 80 };

let realStdout: NodeJS.WriteStream | null = null;
let tracking = false;

/** Ask the terminal to start (or stop) reporting clicks. No-op without a TTY. */
export function enableMouse(): void {
  tracking = true;
  if (realStdout?.isTTY) realStdout.write(ENABLE);
}

export function disableMouse(): void {
  tracking = false;
  if (realStdout?.isTTY) realStdout.write(DISABLE);
}

/** Shared between `installMouse` (wired at boot) and the App (which owns send). */

/**
 * Wrap the real streams for Ink and start tracking. Call once, at boot; pass
 * the returned `stdout` to `render` and leave `stdin` as the returned (same)
 * stream. `stdout` feeds the screen model; `stdin.read` is wrapped in place so
 * mouse bytes are stripped before Ink reads them.
 *
 * Ink keeps the *native* `process.stdin` — its isTTY, raw-mode and quit handling
 * are untouched, because those are exactly what breaks if stdin is replaced
 * with a look-alike. Only the payload `read()` returns is filtered.
 */
export function installMouse(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): MouseStreams {
  realStdout = stdout;
  const screen = new ScreenModel(stdout.rows ?? 24, stdout.columns ?? 80);
  mouseLink.screen = screen;
  mouseLink.columns = stdout.columns ?? 80;

  const refreshColumns = (): void => {
    screen.resize(stdout.rows ?? 24, stdout.columns ?? 80);
    mouseLink.columns = stdout.columns ?? 80;
    // Terminals drop the SGR mouse mode on resize; re-assert it while active.
    if (tracking && stdout.isTTY) stdout.write(ENABLE);
  };

  if (stdout.isTTY && stdin.isTTY) {
    stdout.on("resize", refreshColumns);
    // Never leave the terminal in mouse-tracking mode: it would break normal
    // text selection in the shell after actor0 exits, including on a crash.
    process.on("exit", () => { if (tracking) { try { stdout.write(DISABLE); } catch { /* already gone */ } } });
  }

  const wrappedStdout = {
    get columns() { return stdout.columns; },
    get rows() { return stdout.rows; },
    write(chunk: unknown, encoding?: BufferEncoding, callback?: () => void): boolean {
      screen.feed(typeof chunk === "string" ? chunk : String(chunk));
      return stdout.write(chunk as string | Uint8Array, encoding, callback);
    },
    on(...a: Parameters<NodeJS.WriteStream["on"]>) { return stdout.on(...a); },
    once(...a: Parameters<NodeJS.WriteStream["on"]>) { return stdout.once(...a); },
    off(...a: Parameters<NodeJS.WriteStream["on"]>) { return stdout.off(...a); },
  };

  // Strip mouse reports out of what Ink reads, in place. Ink reads stdin with
  // the paused/'readable' + `read()` protocol, so wrapping `read()` is enough
  // and keeps everything else native. Adding a 'data' listener instead would put
  // the stream in flowing mode and stop 'readable' from ever firing — the
  // invisible way a real terminal ends up with no keyboard at all.
  const readStream = stdin as unknown as { read: (...args: unknown[]) => unknown };
  const originalRead = readStream.read.bind(readStream);
  let residual = "";
  readStream.read = (...args: unknown[]): unknown => {
    const chunk = originalRead(...args);
    if (chunk === null || chunk === undefined) return chunk;
    residual += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    const { inkText, clicks, scroll, hold } = filterMouseChunk(residual);
    residual = hold;
    for (const click of clicks) mouseLink.onClick?.(click);
    if (scroll !== 0) mouseLink.onScroll?.(scroll);
    return inkText;
  };
  if (stdin.isTTY) stdin.setEncoding("utf8");

  return {
    stdin,
    stdout: wrappedStdout as unknown as NodeJS.WriteStream,
    dispose() {
      readStream.read = originalRead;
      stdout.off("resize", refreshColumns);
      if (tracking) { try { stdout.write(DISABLE); } catch { /* already gone */ } }
    },
  };
}
