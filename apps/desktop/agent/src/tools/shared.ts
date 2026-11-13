import { Buffer } from "node:buffer";
import type { FileBridge } from "../native/bridge.js";

/**
 * The shared numbers every tool's output obeys.
 *
 * They are contracts written for the model, not for us: a cap that names the
 * exact offset to resume at, an output budget that keeps the *tail* because
 * errors come last, a column cap so one minified line cannot consume a whole
 * context window. Those details are what separate a tool the model can drive
 * from one it fights.
 */

export const MAX_READ_LINES = 2_000;
export const MAX_READ_BYTES = 50_000;

/**
 * Columns kept from one line before it is cut.
 *
 * The byte cap bounds the *file*; it says nothing about a file that is one
 * line. A minified bundle, a lockfile entry or one CSV row passes a 50KB budget
 * as a single unreadable line, and a line number in front of it is no help
 * because there is only the one. ripgrep uses 500 for the same reason: it is a
 * width at which a human can still read the line.
 */
export const MAX_LINE_COLUMNS = 500;

export const MAX_OUTPUT_BYTES = 30_000;
export const MAX_TIMEOUT_SECONDS = 3_600;

/**
 * Bytes examined when deciding whether a file is binary.
 *
 * Git uses 8000 and so does this: the answer is settled long before it, and
 * reading the head means a 400MB video costs one small read instead of the
 * whole thing decoded to a string.
 */
export const BINARY_SNIFF_BYTES = 8_000;

/** Above this size the read tool reads a window rather than the whole file. */
export const LARGE_FILE_BYTES = 8_000_000;

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing required string parameter "${key}"`);
  }
  return value;
}

/**
 * A string that is allowed to be empty.
 *
 * `requireString` is right for a path and wrong for the two parameters whose
 * whole job is to carry content, because the one value a caller most often
 * needs to send is the empty one. `edit` with `new_string: ""` is how a model
 * deletes a block, and `write` with `content: ""` is how it empties a file.
 */
export function requireText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`missing required string parameter "${key}"`);
  }
  return value;
}

export function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Put a note under a body without stacking blank lines. */
export function withNotice(body: string, note: string): string {
  return `${body.replace(/\n+$/, "")}\n\n${note}`;
}

/** Cut one line to the column cap, reporting whether it was cut. */
export function cutLine(line: string): { text: string; cut: boolean } {
  if (line.length <= MAX_LINE_COLUMNS) return { text: line, cut: false };
  return {
    text: `${line.slice(0, MAX_LINE_COLUMNS)} [cut: +${line.length - MAX_LINE_COLUMNS} chars]`,
    cut: true,
  };
}

/**
 * Say which lines were cut, and how to read one whole.
 *
 * A count is not actionable: the model cannot `sed -n` "line 1 of 4,213" without
 * the number. So the numbers are listed — bounded, because a minified file has
 * one enormous line and a lockfile has thousands of merely long ones.
 */
export function cutNotice(numbers: number[], asked: string): string {
  const one = numbers.length === 1;
  const shown = numbers.slice(0, 5);
  const rest = numbers.length - shown.length;
  const where = one ? "" : `(lines ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""})`;
  return (
    `[${numbers.length} line${one ? "" : "s"} longer than ${MAX_LINE_COLUMNS} characters${where ? ` ${where}` : ""} ` +
    `${one ? "was" : "were"} cut above. To read ${one ? "it" : "one of them"} whole, use the shell tool: ` +
    `sed -n '${shown[0]}p' ${asked} | fold -w ${MAX_LINE_COLUMNS}.]`
  );
}

/**
 * Why `path` cannot be read as text, or undefined when it can.
 *
 * A NUL byte in the first few KB is git's own test, and the one that matters
 * here because of what it does to UTF-16: that encoding puts a NUL between
 * every ASCII character, so a readable file decodes to `h\0e\0l\0l\0o\0` —
 * which looks like text to a model and gets read as if it were.
 */
export async function binaryReason(
  bridge: FileBridge,
  target: string,
  asked: string,
  size: number,
): Promise<string | undefined> {
  const window = await bridge
    .readFile(target, { pos: 0, size: Math.min(BINARY_SNIFF_BYTES, size || BINARY_SNIFF_BYTES) })
    .catch(() => "");
  const at = window.indexOf("\0");
  if (at === -1) return undefined;
  return (
    `${asked} is not text: a NUL byte at offset ${at}. That is what a binary looks like ` +
    `decoded as UTF-8, and it can also mean the file is UTF-16. This tool returns UTF-8 text. ` +
    `Use the shell tool instead — \`file ${asked}\` to identify it, or \`iconv -f UTF-16 ${asked}\` to convert it.`
  );
}

/**
 * Take as many leading lines as the line and byte caps allow.
 *
 * Returns the text, how many lines were consumed, and which of them were cut at
 * the column cap. The *caller* decides the continuation offset, because only it
 * knows the file's own length — and a capped read that reports the window's end
 * instead of the file's is how a model comes to believe a 2,500-line file ends
 * at line 2,000.
 */
export function capLines(lines: string[], startLine: number, maxLines: number): { text: string; consumed: number; cuts: number[] } {
  let byteCount = 0;
  let end = 0;
  for (; end < lines.length && end < maxLines; end += 1) {
    const lineBytes = Buffer.byteLength(lines[end]!, "utf8") + 1;
    if (byteCount + lineBytes > MAX_READ_BYTES && end > 0) break;
    byteCount += lineBytes;
  }
  const cuts: number[] = [];
  const windowLines = lines.slice(0, end).map((line, index) => {
    const result = cutLine(line);
    if (result.cut) cuts.push(startLine + index);
    return result.text;
  });
  return { text: windowLines.join("\n"), consumed: end, cuts };
}

/** A `path (N lines):` style header, dropped from tool output in the transcript. */
export function stripLineStructureNotice(text: string): string {
  return text.replace(/^\S.*\(\d+ .*\):$/m, "").trim();
}
