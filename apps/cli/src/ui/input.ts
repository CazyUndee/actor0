/**
 * Our own input parser.
 *
 * Ink's `useInput` is fine for keys but it sits behind the stdin proxy we had to
 * drop, and it does nothing for mouse. So we read the raw TTY stream ourselves
 * and turn it into a small, explicit event stream the TUI dispatches on. It is a
 * few dozen lines and it is the whole input path — ours, so it can't fight a
 * renderer or silently eat a byte.
 */

export type KeyName =
  | "return"
  | "backspace"
  | "delete"
  | "escape"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-u"
  | "ctrl-l";

export type InputEvent =
  | { type: "text"; text: string }
  | { type: "key"; key: KeyName; ctrl?: boolean }
  | { type: "mouse"; x: number; y: number; button: "left" | "wheel-up" | "wheel-down"; release: boolean };

// eslint-disable-next-line no-control-regex -- matches the ESC that begins every SGR mouse report
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// eslint-disable-next-line no-control-regex -- matches the ESC that begins every CSI key sequence
const CSI = /\x1b\[([0-9;]*)([A-Za-z])/;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Turn one raw chunk into events, carrying any partial escape sequence forward
 * so a sequence split across reads is not mistaken for keystrokes.
 */
export function parseInput(buffer: string): { events: InputEvent[]; rest: string } {
  const events: InputEvent[] = [];
  let i = 0;
  const text = (): void => {
    // Accumulate a run of printable characters (not an escape introducer).
    let run = "";
    while (i < buffer.length && buffer[i] !== "\x1b") {
      const ch = buffer[i]!;
      i += 1;
      if (ch === "\r") { if (run) { events.push({ type: "text", text: run }); run = ""; } events.push({ type: "key", key: "return" }); continue; }
      if (ch === "\n") { if (run) { events.push({ type: "text", text: run }); run = ""; } events.push({ type: "key", key: "return" }); continue; }
      if (ch === "\x7f" || ch === "\b") { if (run) { events.push({ type: "text", text: run }); run = ""; } events.push({ type: "key", key: "backspace" }); continue; }
      if (ch === "\x03") { if (run) { events.push({ type: "text", text: run }); run = ""; } events.push({ type: "key", key: "ctrl-c" }); continue; }
      if (ch === "\x04") { if (run) { events.push({ type: "text", text: run }); run = ""; } events.push({ type: "key", key: "ctrl-d" }); continue; }
      if (ch === "\x15") { if (run) { events.push({ type: "text", text: run }); run = ""; } events.push({ type: "key", key: "ctrl-u" }); continue; }
      if (ch === "\x0c") { if (run) { events.push({ type: "text", text: run }); run = ""; } events.push({ type: "key", key: "ctrl-l" }); continue; }
      if (ch === "\t") { if (run) { events.push({ type: "text", text: run }); run = ""; } events.push({ type: "key", key: "tab" }); continue; }
      run += ch;
    }
    if (run) events.push({ type: "text", text: run });
  };

  while (i < buffer.length) {
    if (buffer[i] !== "\x1b") { text(); continue; }
    // A bracketed paste: everything up to the end marker is literal text.
    if (buffer.startsWith(PASTE_START, i)) {
      const end = buffer.indexOf(PASTE_END, i + PASTE_START.length);
      if (end === -1) break; // incomplete paste: hold the whole tail
      const body = buffer.slice(i + PASTE_START.length, end);
      if (body) events.push({ type: "text", text: body });
      i = end + PASTE_END.length;
      continue;
    }
    MOUSE.lastIndex = i;
    const m = MOUSE.exec(buffer);
    if (m && m.index === i) {
      const b = Number(m[1]);
      const button = b === 64 ? "wheel-up" : b === 65 ? "wheel-down" : "left";
      events.push({ type: "mouse", x: Number(m[2]), y: Number(m[3]), button, release: m[4] === "m" });
      i += m[0].length;
      continue;
    }
    const c = CSI.exec(buffer.slice(i));
    if (c) {
      const code = c[2];
      const map: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
      if (map[code]) events.push({ type: "key", key: map[code]! });
      else if (code === "~") {
        const n = c[1];
        if (n === "3") events.push({ type: "key", key: "delete" });
        else if (n === "5") events.push({ type: "key", key: "pageup" });
        else if (n === "6") events.push({ type: "key", key: "pagedown" });
        else if (n === "1" || n === "7") events.push({ type: "key", key: "home" });
        else if (n === "4" || n === "8") events.push({ type: "key", key: "end" });
      }
      i += c[0].length;
      continue;
    }
    // A bare ESC: the Escape key. Hold it only when it is the start of a
    // CSI or SS3 sequence that has not fully arrived (ESC [ … / ESC O …). A
    // lone ESC must fire now — holding it makes the Escape key never register
    // until an unrelated next key, which then arrives mis-routed in the same
    // batch (the escape's mode change is not visible to it yet).
    const next = buffer[i + 1];
    if (next === "[" || next === "O") break;
    events.push({ type: "key", key: "escape" });
    i += 1;
  }
  return { events, rest: buffer.slice(i) };
}
