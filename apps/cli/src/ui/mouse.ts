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
 * Wrap the real streams for Ink and start tracking. Call once, at boot; pass the
 * returned streams to `render`. `stdout` feeds the screen model; `stdin` strips
 * mouse reports so Ink sees only keys.
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

  const keyboard: string[] = [];
  const readable = new Set<() => void>();
  let residual = "";
  const onData = (chunk: Buffer | string): void => {
    residual += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const { inkText, clicks, scroll, hold } = filterMouseChunk(residual);
    residual = hold;
    for (const click of clicks) mouseLink.onClick?.(click);
    if (scroll !== 0) mouseLink.onScroll?.(scroll);
    // Forward to Ink only when it is actually reading — i.e. it registered a
    // 'readable' listener, which it does only on a TTY in raw mode. On a pipe
    // Ink ignores input, and buffering it would grow a slice nobody drains.
    if (inkText && readable.size > 0) {
      keyboard.push(inkText);
      for (const cb of readable) cb();
    }
  };

  // Always attached: the filter is a no-op without mouse tracking (no SGR
  // reports arrive), so draining stdin never costs keystrokes. Only the mouse
  // *escape writes* are TTY-gated above.
  stdin.setEncoding("utf8");
  stdin.on("data", onData);

  const wrappedStdin = {
    get isTTY() { return stdin.isTTY; },
    setRawMode(mode: boolean) { return stdin.setRawMode?.(mode); },
    setEncoding() { return undefined as void; }, // the real stream is already utf8 for onData
    ref() { return stdin.ref?.(); },
    unref() { return stdin.unref?.(); },
    pause() { return stdin.pause?.(); },
    resume() { return stdin.resume?.(); },
    read() { return keyboard.length > 0 ? (keyboard.shift() as string) : null; },
    addListener(event: string, cb: (...a: unknown[]) => void) {
      if (event === "readable") readable.add(cb as () => void);
      else (stdin as unknown as NodeJS.EventEmitter).on(event, cb);
      return this;
    },
    on(event: string, cb: (...a: unknown[]) => void) { return this.addListener(event, cb); },
    removeListener(event: string, cb: (...a: unknown[]) => void) {
      if (event === "readable") readable.delete(cb as () => void);
      else (stdin as unknown as NodeJS.EventEmitter).removeListener(event, cb);
      return this;
    },
  };

  return {
    stdin: wrappedStdin as unknown as NodeJS.ReadStream,
    stdout: wrappedStdout as unknown as NodeJS.WriteStream,
    dispose() {
      (stdin as unknown as NodeJS.EventEmitter).off("data", onData);
      stdout.off("resize", refreshColumns);
      if (tracking) { try { stdout.write(DISABLE); } catch { /* already gone */ } }
    },
  };
}
