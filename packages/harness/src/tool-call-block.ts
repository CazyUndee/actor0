import type { ToolCall } from "./types.js";

/**
 * The explicit tool-call protocol.
 *
 * When a model cannot use a native `tool_calls` transport it still has to
 * call tools, and the only reliable way to do that is to say so in a shape
 * that cannot be mistaken for prose. A model emits:
 *
 * ```json
 * {"type": "tool_call", "name": "set_title", "arguments": {"title": "…"}}
 * ```
 *
 * and the answer filter turns that into a real tool call, so the block never
 * reaches the message bubble.
 *
 * This is deliberately the *opposite* of sniffing for call-shaped text in
 * prose. `set_title(title: "x")` in a sentence is ambiguous —
 * it might be an explanation — and any heuristic that fires on it will
 * eventually fire on an explanation. A fenced JSON object with an explicit
 * `type` is unambiguous, and a block that is not one is released verbatim, so
 * ordinary JSON examples in answers are unaffected.
 *
 * Only a ```json fence is a candidate. A bare ``` fence is nearly always a
 * real code block, and buffering those would stall the stream of any
 * code-heavy answer waiting for a close that may be far away.
 */

/** Info strings that mark a block as a tool-call candidate. */
const OPEN_FENCE = /^```(?:json|jsonc|json5)[ \t]*\r?\n/i;
const CLOSE_FENCE = /^```[ \t]*\r?(\n|$)/gm;

/** Every opening fence we would accept, for prefix checks. */
const OPEN_CANDIDATES = ["```json", "```jsonc", "```json5"];

/**
 * Give up on a block that never closes. An unterminated fence must not
 * swallow the rest of the answer, and no legitimate tool call is this long.
 */
export const MAX_TOOL_BLOCK = 8_000;

let callSeq = 0;

/** True when `line` opens a tool-call candidate. */
export function matchOpenFence(text: string): { length: number } | null {
  const match = OPEN_FENCE.exec(text);
  return match ? { length: match[0].length } : null;
}

/**
 * True when `text` could still grow into an opening fence but is not one yet.
 *
 * A fence routinely straddles a delta boundary ("``" + "`json\n"), and
 * deciding per-delta would release the first half as text. This is the hold
 * that makes the protocol recognisable no matter how the stream is chunked.
 */
export function mayBeOpenFence(text: string): boolean {
  const lower = text.toLowerCase();
  return OPEN_CANDIDATES.some((candidate) => lower.length <= candidate.length && candidate.startsWith(lower));
}

/**
 * Locate the closing fence.
 *
 * Every fence is scanned, not just the first: the text handed in usually still
 * contains the opening fence, which must be skipped rather than mistaken for
 * the close. Mid-stream a close only counts once its newline has arrived, so a
 * buffer ending in "``" is left pending; at end of stream (`atEnd`) a fence
 * with no trailing newline is final and does count.
 */
export function matchCloseFence(text: string, atEnd = false): { index: number; length: number } | null {
  const re = new RegExp(CLOSE_FENCE.source, CLOSE_FENCE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index === undefined) return null;
    const closed = match[0].endsWith("\n");
    if (closed || atEnd) return { index: match.index, length: match[0].length };
    // A fence with no newline yet: keep looking, and do not let a zero-width
    // match spin the loop.
    if (match[0].length === 0) re.lastIndex++;
  }
  return null;
}

/** The JSON body of a complete block, without its fences. */
export function blockBody(block: string): string {
  return block.replace(OPEN_FENCE, "").replace(CLOSE_FENCE, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a complete fenced block into a tool call.
 *
 * Returns null — meaning "this is ordinary answer text" — unless the block is
 * a JSON object that says `type: "tool_call"`, carries a string `name`, and
 * that name is one the request actually offered. The name check is what stops
 * a model from inventing a tool; the `type` check is what stops every other
 * JSON example in every answer from being swallowed.
 */
export function parseToolCallBlock(block: string, toolNames: string[]): ToolCall | null {
  if (toolNames.length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(blockBody(block));
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (value.type !== "tool_call") return null;
  if (typeof value.name !== "string" || !toolNames.includes(value.name)) return null;

  const args = value.arguments;
  if (args !== undefined && !isPlainObject(args)) return null;

  return {
    id: `block_call_${++callSeq}`,
    type: "function",
    function: {
      name: value.name,
      arguments: JSON.stringify(args ?? {}),
    },
  };
}
