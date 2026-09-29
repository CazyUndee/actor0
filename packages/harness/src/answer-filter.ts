import { extractPlanPrefix, needsMorePlanData } from "./plan-prefix.js";
import {
  MAX_TOOL_BLOCK,
  matchCloseEnvelope,
  matchCloseFence,
  matchOpenEnvelope,
  matchOpenFence,
  mayBeOpenEnvelope,
  mayBeOpenFence,
  parseToolCallBlock,
  parseToolCallEnvelope,
  type BlockKind,
  type RejectedBlock,
} from "./tool-call-block.js";
import type { PlanPrefix, ToolCall } from "./types.js";

/** Incremental answer filtering for streamed model output. */
const MAX_STATUS_HOLD = 48;
const MAYBE_STATUS_PREFIX = /^(?:[ \t]*|[ \t]*\[[^\x5d\n]{0,40})$/;

/**
 * Status text kept from one line.
 *
 * A line that opens with the marker is a status line, and its text runs to
 * the end of that line. Past this many characters it stops being a status and
 * becomes the answer again, which is what keeps a runaway line from taking the
 * rest of the response with it.
 */
export const MAX_STATUS_CHARS = 80;

/**
 * Status markers.
 *
 * Only the bullet form is recognised: `[·] Searching the web`. That is the
 * shape the system prompt specifies, and it is the only one that can be told
 * apart from content by inspection rather than by guesswork.
 *
 * The bare bracket form, `[Searching the web]`, used to be accepted too. It is
 * not any more, because it is genuinely indistinguishable from the link text a
 * model writes: asked for a landing page, it emitted `[Get Started for Free]`
 * and `[**Start Building**]`, and both were silently deleted from the answer
 * along with the call to action. Nothing else in prose looks like `[·]`.
 *
 * The asymmetry is deliberate. Missing a status leaves a visible `[·] thing`
 * line in the answer, which is ugly. Eating a link label is silent content
 * loss. The ugly failure is the better one.
 *
 * One known blind spot, left alone on purpose: a marker-shaped line inside an
 * ordinary (non-protocol) fenced code block is still eaten as a status. The
 * filter has no notion of a code fence — only a ```json fence is a block it
 * tracks, because buffering a bare fence would stall any code-heavy answer
 * waiting for a close that may never come. Adding fence state to get this
 * right means implementing CommonMark's opening and closing rules for a line
 * shape that essentially never occurs, and getting them subtly wrong stalls
 * the stream. Recorded rather than fixed.
 */

/**
 * A marker owns its line when a newline follows it immediately, which is what
 * lets the trailing newline be swallowed so markers do not each prepend a
 * blank line to the answer.
 */
const ownsLine = (text: string, length: number): boolean => text.indexOf("\n", length) === length;

/** The marker itself, with the indentation and the space that follow it. */
const STATUS_MARKER = /^[ \t]*\[\u00b7\][ \t]*/;

/** A status line found at the start of the buffer. */
type StatusLine = {
  /** The text shown as the status, already trimmed and capped. */
  text: string;
  /** How much of the buffer the line occupies, newline included. */
  end: number;
  /**
   * False when the line has not finished arriving.
   *
   * This is the whole difficulty. Where a status ends is only knowable from
   * the newline that ends it, and SSE deltas are far smaller than a line —
   * a status split across two deltas used to be decided on the first one,
   * which is how "[\u00b7] Search" followed by "ing the web" produced the
   * status "Search" and then printed "ing the web" into the answer as prose,
   * with no marker on it to say what it had been. The filter holds the
   * fragment instead and decides when the line is complete.
   */
  complete: boolean;
};

function matchStatusLine(text: string, atEnd: boolean): StatusLine | null {
  const marker = STATUS_MARKER.exec(text);
  if (!marker) return null;
  const rest = text.slice(marker[0].length);
  const text_ = (value: string): string => value.replace(/^\u00b7+\s*/, "").trim().slice(0, MAX_STATUS_CHARS);
  const newline = rest.indexOf("\n");
  if (newline !== -1) {
    // A line past the cap stops being a status halfway: the rest of it is
    // content, and the newline that ends it is content's, not the status's.
    const capped = newline > MAX_STATUS_CHARS;
    return {
      text: text_(rest.slice(0, newline)),
      end: marker[0].length + (capped ? MAX_STATUS_CHARS : newline + 1),
      complete: true,
    };
  }
  if (!atEnd && rest.length <= MAX_STATUS_CHARS) return { text: "", end: 0, complete: false };
  return { text: text_(rest), end: marker[0].length + MAX_STATUS_CHARS, complete: true };
}

export type FilteredChunk = {
  text: string;
  statuses: string[];
  plan: PlanPrefix | null;
  /** Tool calls the model emitted as protocol blocks (see tool-call-block.ts). */
  toolCalls: ToolCall[];
  /**
   * Blocks the protocol refused — a call for an unoffered tool, or arguments
   * that were not valid JSON. Each becomes a synthetic call plus an error
   * tool result, so the model is told next round that the call was wrong and
   * why; nothing here is ever released into the answer text.
   */
  rejected: RejectedBlock[];
};

export type AnswerFilter = {
  push(delta: string): FilteredChunk;
  flush(): FilteredChunk;
  reset(): void;
};

/**
 * @param toolNames names from the request's tool list. A block naming
 *   anything else is not a call and is shown as ordinary text.
 */
export function createAnswerFilter(toolNames: string[] = []): AnswerFilter {
  let held = "";
  let atLineStart = true;
  let eatNewline = false;
  let planDone = false;
  /**
   * Non-null while inside a protocol block — a ```json fence or a
   * `<tool_calls>` envelope. Everything from the opening delimiter is
   * accumulated here and released in one go, so a block split across arbitrary
   * deltas is never half-shown, and the block's own text is only released if it
   * turns out not to be a tool call.
   */
  let block: string | null = null;
  let blockKind: BlockKind = "fence";

  /**
   * Where the block's closer is.
   *
   * `pending` is the whole block so far, not just the newest delta: a closing
   * delimiter can straddle a push boundary, and one that lands half in the
   * buffer and half in the delta is the normal case for a small-chunked SSE
   * stream. An envelope resumes its scan where the last one stopped, because
   * the accumulated half has already been searched and had no close in it.
   */
  const findClose = (pending: string, atEnd: boolean) =>
    blockKind === "envelope"
      ? matchCloseEnvelope(pending, block?.length ?? 0)
      : matchCloseFence(pending, atEnd);

  /** The calls and rejections a closed block carries. */
  const parseClosed = (finished: string): { calls: ToolCall[]; rejected: RejectedBlock[] } => {
    if (blockKind === "envelope") return parseToolCallEnvelope(finished, toolNames);
    const result = parseToolCallBlock(finished, toolNames);
    if (result === null) return { calls: [], rejected: [] };
    if ("reason" in result) return { calls: [], rejected: [result] };
    return { calls: [result], rejected: [] };
  };

  /**
   * The one place text is turned into visible answer, statuses and tool calls.
   *
   * push() and flush() both go through here rather than keeping parallel
   * copies of the rules: a fence parked in `held` by the plan-prefix logic is
   * still in the buffer when the stream ends, and a flush path that did not
   * re-run the loop would show it as text instead of a tool call.
   *
   * @param atEnd end of stream — a closing fence is final even without its
   *   trailing newline, and a block that never closed is released as text.
   */
  const run = (delta: string, atEnd: boolean): FilteredChunk => {
    let output = "";
    const statuses: string[] = [];
    const toolCalls: ToolCall[] = [];
    const rejected: RejectedBlock[] = [];
    let plan: PlanPrefix | null = null;
    let buffer = held + delta;
    held = "";

    if (!planDone) {
      const extracted = extractPlanPrefix(buffer);
      if (extracted.plan) {
        planDone = true;
        plan = extracted.plan;
        buffer = extracted.rest;
      }
    }

    while (buffer.length > 0) {
      if (eatNewline) {
        eatNewline = false;
        if (buffer.startsWith("\r\n")) buffer = buffer.slice(2);
        else if (buffer.startsWith("\n")) buffer = buffer.slice(1);
        continue;
      }

      // Inside a candidate block: nothing may be shown until it closes.
      if (block !== null) {
        const pending = block + buffer;
        const close = findClose(pending, atEnd);
        if (!close) {
          block = pending;
          buffer = "";
          if (block.length > MAX_TOOL_BLOCK) {
            // Unterminated: give up rather than swallow the rest of the answer.
            output += block;
            block = null;
            atLineStart = false;
          }
          continue;
        }
        const finished = pending.slice(0, close.index + close.length);
        buffer = pending.slice(close.index + close.length);
        block = null;
        const parsed = parseClosed(finished);
        if (parsed.rejected.length > 0) {
          rejected.push(...parsed.rejected);
          // The block owned its line, so drop the newline that ends it.
          eatNewline = true;
          atLineStart = true;
        } else if (parsed.calls.length > 0) {
          toolCalls.push(...parsed.calls);
          // The block owned its line, so drop the newline that ends it.
          //
          // Unconditionally, and that is the point: the newline ending a
          // block is very often the next delta to arrive, and deciding from
          // a buffer that does not hold it yet is how a blank line appeared in
          // the answer only when the stream happened to be finely chunked. The
          // flag is cleared by the next character whatever it is, so setting
          // it for a block followed by anything else costs nothing.
          eatNewline = true;
          atLineStart = true;
        } else {
          output += finished;
          atLineStart = ownsLine(finished, finished.length);
        }
        continue;
      }

      if (atLineStart) {
        const fence = matchOpenFence(buffer);
        const envelope = fence ? null : matchOpenEnvelope(buffer);
        const open = fence ?? envelope;
        if (open) {
          blockKind = fence ? "fence" : "envelope";
          block = buffer.slice(0, open.length);
          buffer = buffer.slice(open.length);
          continue;
        }
        // A delimiter split across deltas ("``" then "`json\n", or "<tool_"
        // then "calls>"): hold the half rather than releasing it as text. A
        // handful of characters, released on the next push once this is
        // clearly not a tool block.
        if (mayBeOpenFence(buffer) || mayBeOpenEnvelope(buffer)) {
          held = buffer;
          buffer = "";
          continue;
        }
      }

      if (!atLineStart) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          output += buffer;
          buffer = "";
        } else {
          output += buffer.slice(0, newline + 1);
          buffer = buffer.slice(newline + 1);
          atLineStart = true;
        }
        continue;
      }

      const status = matchStatusLine(buffer, atEnd);
      if (status) {
        if (!status.complete) {
          // More of the line may still be coming. Held for exactly as long as
          // it takes to find out, and no longer: a fragment that is already
          // over the cap stops being a status and falls through to the answer.
          held = buffer;
          buffer = "";
          continue;
        }
        if (status.text) statuses.push(status.text);
        buffer = buffer.slice(status.end);
        continue;
      }

      // The two "wait and see" holds are only legitimate mid-stream. At the
      // end there is no more input coming, so holding would strand the text
      // forever — a plan-shaped prefix must not swallow a tool-call block that
      // follows it.
      if (!atEnd) {
        if (buffer.length < MAX_STATUS_HOLD && MAYBE_STATUS_PREFIX.test(buffer)) {
          held = buffer;
          buffer = "";
          continue;
        }

        if (!planDone && output.length === 0 && !plan && needsMorePlanData(buffer)) {
          held = buffer;
          buffer = "";
          continue;
        }
      }

      atLineStart = false;
    }

    // A block still open when the buffer runs dry is only decidable at the end
    // of the stream: its closing fence may be the last thing that arrives, or
    // it may never come. Left alone it would be dropped — neither shown nor
    // run — so it is resolved here.
    if (atEnd && block !== null) {
      const close = findClose(block, true);

      const finished = close ? block.slice(0, close.index + close.length) : block;
      const rest = close ? block.slice(close.index + close.length) : "";
      block = null;
      // Never execute a block that never closed: whatever it parses as, it is
      // the model showing the user JSON, not a protocol message.
      const parsed = close ? parseClosed(finished) : { calls: [], rejected: [] };
      if (parsed.rejected.length > 0) {
        rejected.push(...parsed.rejected);
        // The block is the protocol, not content: it must not also be shown.
        output += rest;
      } else if (parsed.calls.length > 0) {
        toolCalls.push(...parsed.calls);
        output += rest;
      } else {
        output += finished + rest;
      }
    }

    return { text: output, statuses, plan, toolCalls, rejected };
  };

  return {
    push(delta: string): FilteredChunk {
      return run(delta, false);
    },

    flush(): FilteredChunk {
      atLineStart = true;
      eatNewline = false;
      const result = run("", true);
      // `run` may have parked a final fragment (a half fence, a status
      // prefix). Nothing more is coming, so release it as answer text.
      if (held) {
        result.text += held;
        held = "";
      }
      return result;
    },

    reset(): void {
      held = "";
      atLineStart = true;
      eatNewline = false;
      planDone = false;
      block = null;
    },
  };
}
