import type { ToolCall } from "./types.js";

/** A thrown value's message, for rejection reasons. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
 * A second envelope is accepted, the one this project's own chat product
 * teaches:
 *
 * <tool_calls>
 * {"type": "tool_call", "name": "set_title", "arguments": {"title": "…"}}
 * </tool_calls>
 *
 * It shows up when a request is proxied through an endpoint that injects its
 * own system prompt, so the model was told about *that* protocol instead of
 * this one. A named tag is as unambiguous as a fence, and unlike a call-shaped
 * phrase in prose it can never be an explanation.
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

const OPEN_ENVELOPE = /^<tool_calls>[ \t]*\r?\n?/i;
const CLOSE_ENVELOPE = /<\/tool_calls>/gi;

/** Longest run of the close tag that can sit in the previous buffer. */
const CLOSE_ENVELOPE_PREFIX = "</tool_calls>".length - 1;

/** Every opening envelope we would accept, for prefix checks. */
const OPEN_ENVELOPE_CANDIDATES = ["<tool_calls>"];

/** Which envelope a buffered block is waiting for. */
export type BlockKind = "fence" | "envelope";

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

/** True when `line` opens a `<tool_calls>` envelope. */
export function matchOpenEnvelope(text: string): { length: number } | null {
  const match = OPEN_ENVELOPE.exec(text);
  return match ? { length: match[0].length } : null;
}

/**
 * The `<tool_calls>` twin of `mayBeOpenFence`.
 *
 * SSE deltas are small enough that `<tool_` on one and `calls>` on the next is
 * routine, and releasing the first half as text would leave `calls>` orphaned
 * in the answer. Same hold, same reason.
 */
export function mayBeOpenEnvelope(text: string): boolean {
  const lower = text.toLowerCase();
  return OPEN_ENVELOPE_CANDIDATES.some(
    (candidate) => lower.length <= candidate.length && candidate.startsWith(lower)
  );
}

/**
 * Locate the closing `</tool_calls>`, resuming at `fromIndex`.
 *
 * `fromIndex` is the length of the part already buffered, and the scan starts
 * `CLOSE_ENVELOPE_PREFIX` characters earlier on purpose: a close can straddle
 * the boundary between the buffer and the new delta, and a delta boundary
 * landing mid-tag is the *normal* case for a small-chunked SSE stream. Resuming
 * exactly at `fromIndex` misses it forever, and the block then grows until it
 * is released as text. Resuming from 0 would be correct too, just quadratic on
 * a long unterminated block.
 */
export function matchCloseEnvelope(text: string, fromIndex = 0): { index: number; length: number } | null {
  const re = new RegExp(CLOSE_ENVELOPE.source, CLOSE_ENVELOPE.flags);
  re.lastIndex = Math.max(0, Math.min(fromIndex, text.length) - CLOSE_ENVELOPE_PREFIX);
  const match = re.exec(text);
  if (!match || match.index === undefined) return null;
  return { index: match.index, length: match[0].length };
}

/**
 * Locate the closing fence.
 *
 * Every fence is scanned, not just the first: the text handed in usually still
 * contains the opening fence, which must be skipped rather than mistaken for
 * the close. Mid-stream a close only counts once its newline has arrived, so a
 * buffer ending in "``" is left pending; at end of stream (`atEnd`) a fence
 * with no trailing newline is final and does count.
 *
 * Callers pass the whole buffered block, not just the newest delta: a fence can
 * straddle the two, and a close hidden in the accumulated half is as real as
 * one in the delta.
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

/** Sequence for synthetic call ids, so a rejected block still pairs. */
let rejectSeq = 0;

/**
 * A protocol block that was recognised but refused: it named a tool this
 * request never offered, or its arguments were not parseable JSON.
 *
 * Rejection is a protocol event, not prose. The old behaviour released the
 * block as answer text, which taught the model nothing — it re-emitted the
 * same block, and the user watched raw JSON scroll past. A rejected block now
 * becomes a synthetic call plus an error tool result, so the next round opens
 * with the model being told, in its own protocol, that the call was refused
 * and why. The UI shows the same pair it shows for a failing tool: a cross
 * against a name, with the reason.
 */
export type RejectedBlock = {
  /** The name the model asked for, offered or not. For the error message. */
  name: string;
  /** The synthetic call that will carry the error result. */
  call: ToolCall;
  /** One sentence a model (and a user) can act on. */
  reason: string;
};

/**
 * Build the rejection record for a block whose JSON parsed but named a tool
 * the request did not offer. The reason quotes the offered names so the model
 * can pick a real one instead of guessing again.
 */
export function rejectUnknownTool(name: string, offered: string[]): RejectedBlock {
  const call: ToolCall = {
    id: `block_rejected_${++rejectSeq}`,
    type: "function",
    function: { name, arguments: "{}" },
  };
  const list = offered.length > 0 ? offered.join(", ") : "none";
  return {
    name,
    call,
    reason:
      `Rejected: your tool-call block named "${name}", but that tool was not ` +
      `offered on this request (offered: ${list}). Use one of the offered ` +
      `tools, or answer in plain text.`,
  };
}

/**
 * Recover the intended tool name from a block whose JSON did not parse.
 *
 * The rejection transcript line reads "✗ <name>" — showing "unknown" when the
 * body plainly says which tool was meant is a worse error message than the
 * model deserves, and a regex is safe here: the name is read out of the raw
 * body only to *display* it, never to execute it, and the value is capped and
 * stripped to what a name can look like.
 */
function recoverName(body: string): string {
  const match = /"name"\s*:\s*"([^"\\]{1,64})"/.exec(body);
  return match?.[1] ?? "unknown";
}

/**
 * Build the rejection record for a block that looked like a tool call but
 * whose arguments were not valid JSON. The common cause is a raw newline or
 * tab inside a string literal — the model formatted the command like shell
 * output instead of escaping it — so the reason names that repair first. A
 * body with no usable "name" gets the name-specific hint instead; the
 * generic newline hint would be pointing at a fault it does not have.
 */
export function rejectMalformedArguments(detail: string, rawBody?: string): RejectedBlock {
  const name = rawBody !== undefined ? recoverName(rawBody) : "unknown";
  const call: ToolCall = {
    id: `block_rejected_${++rejectSeq}`,
    type: "function",
    function: { name, arguments: "{}" },
  };
  if (name === "unknown") {
    return {
      name,
      call,
      reason:
        `Rejected: your tool-call block was not valid JSON (${detail}). ` +
        `The block needs {"type": "tool_call", "name": "<offered tool>", "arguments": {…}} — ` +
        `a string "name" naming one of the offered tools. Re-emit it as valid JSON.`,
    };
  }
  return {
    name,
    call,
    reason:
      `Rejected: your "${name}" tool-call block was not valid JSON (${detail}). ` +
      `Most often a raw newline inside a string value — JSON strings cannot ` +
      `contain literal line breaks; use \\n. Re-emit the block with valid JSON ` +
      `on a single line.`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A body that opens with the protocol's own shape. A body that fails to parse
 * is ambiguous — a protocol block the model got wrong, or a JSON code example
 * holding prose — and only this prefix, verifiable by inspection, turns the
 * first into a rejection. Anything else is ordinary text.
 */
const PROTOCOL_INTENT = /^\s*\{\s*"type"\s*:\s*"tool_call"/;

/**
 * Parse a complete fenced block into a tool call.
 *
 * Returns null — meaning "this is ordinary answer text" — unless the block is
 * a JSON object that says `type: "tool_call"` and carries a string `name`.
 * The `type` check is what stops every other JSON example in every answer
 * from being treated as protocol.
 *
 * The result says what happened: a `call` when the name is one the request
 * actually offered, or a `rejected` record when it is not — including when
 * the body is protocol-shaped but not valid JSON, the field case being a raw
 * newline inside a string value. Rejected is not the same as text — the model
 * addressed the protocol; the harness answers in the same protocol (see
 * RejectedBlock).
 */
export function parseToolCallBlock(block: string, toolNames: string[]): ToolCall | RejectedBlock | null {
  if (toolNames.length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(blockBody(block));
  } catch (error) {
    if (PROTOCOL_INTENT.test(blockBody(block))) {
      return rejectMalformedArguments(errorMessage(error), blockBody(block));
    }
    return null;
  }
  return toToolCall(value, toolNames);
}

/** One protocol object → one call, a rejection, or null when it is not a call. */
function toToolCall(value: unknown, toolNames: string[]): ToolCall | RejectedBlock | null {
  if (!isPlainObject(value)) return null;
  if (value.type !== "tool_call") return null;
  if (typeof value.name !== "string") {
    return rejectMalformedArguments(
      'the object has no string "name" field — add "name": "<offered tool>"',
    );
  }
  if (!toolNames.includes(value.name)) return rejectUnknownTool(value.name, toolNames);

  const args = value.arguments;
  if (args !== undefined && !isPlainObject(args)) {
    return rejectMalformedArguments("\"arguments\" is not a JSON object");
  }

  return {
    id: `block_call_${++callSeq}`,
    type: "function",
    function: {
      name: value.name,
      arguments: JSON.stringify(args ?? {}),
    },
  };
}

/**
 * The `<tool_calls>` body: every top-level `{…}` object, in order.
 *
 * Braces inside strings are ignored, so a title containing `}` cannot end the
 * scan early. Anything that does not close is not an object and not a call.
 */
export function scanJsonObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth === 0) continue; // a stray close; not ours
      depth--;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
}

/**
 * Parse a closed `<tool_calls>` envelope into the calls it carries.
 *
 * All-or-nothing, like the fence: an envelope is protocol only if *every*
 * object in it is a call for a tool this request actually offered. One
 * `set_conversation_title` in a `<tool_calls>` envelope is not a partial tool
 * round to half-execute — it is a different assistant's protocol, and
 * executing half of it would hide the mismatch. The first non-call object in
 * the envelope therefore poisons the whole envelope: every call-shaped object
 * before it becomes a rejection (the model addressed the protocol and is told
 * so next round), and none of them executes.
 */
export function parseToolCallEnvelope(block: string, toolNames: string[]): { calls: ToolCall[]; rejected: RejectedBlock[] } {
  if (toolNames.length === 0) return { calls: [], rejected: [] };
  const body = block.replace(OPEN_ENVELOPE, "").replace(CLOSE_ENVELOPE, "");
  const candidates = scanJsonObjects(body);
  if (candidates.length === 0) return { calls: [], rejected: [] };

  type Parsed = { kind: "call"; call: ToolCall } | { kind: "reject"; block: RejectedBlock };
  const parsed: Parsed[] = [];
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      // A body that is not valid JSON is not protocol at all — release it as
      // text, exactly like a fence whose body does not parse. Nothing in an
      // unparseable body names a tool, so there is nothing to reject either.
      return { calls: [], rejected: [] };
    }
    const call = toToolCall(value, toolNames);
    if (call === null) {
      // An object with the wrong `type` — not protocol. The all-or-nothing
      // rule releases the whole envelope as text.
      return { calls: [], rejected: [] };
    }
    parsed.push("reason" in call ? { kind: "reject", block: call } : { kind: "call", call });
  }

  const poison = parsed.find((item): item is { kind: "reject"; block: RejectedBlock } => item.kind === "reject");
  if (!poison) return { calls: parsed.map((item) => (item as { kind: "call"; call: ToolCall }).call), rejected: [] };

  // All-or-nothing: the first refusal poisons every call in the envelope. A
  // well-formed call beside a refused one did not run either, and leaving it
  // silent would hide the refusal — the model would re-emit the whole
  // envelope next round believing half of it succeeded.
  const refused = poison.block;
  const list = toolNames.length > 0 ? toolNames.join(", ") : "none";
  const rejected = parsed.map((item) =>
    item.kind === "reject"
      ? item.block
      : {
          name: item.call.function.name,
          call: item.call,
          reason:
            `Rejected: the <tool_calls> envelope also carried "${refused.name}", which was not offered ` +
            `(offered: ${list}). The envelope is all-or-nothing, so your "${item.call.function.name}" ` +
            `call did not run either. Use only the offered tools, or answer in plain text.`,
        },
  );
  return { calls: [], rejected };
}
