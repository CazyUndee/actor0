import { extractPlanPrefix, needsMorePlanData } from "./plan-prefix.js";
import {
  MAX_TOOL_BLOCK,
  matchCloseFence,
  matchOpenFence,
  mayBeOpenFence,
  parseToolCallBlock,
} from "./tool-call-block.js";
import type { PlanPrefix, ToolCall } from "./types.js";

/** Incremental answer filtering for streamed model output. */
const MAX_STATUS_HOLD = 48;
const MAYBE_STATUS_PREFIX = /^(?:[ \t]*|[ \t]*\[[^\x5d\n]{0,40})$/;

/**
 * Status markers, in both shapes models actually write.
 *
 * `[·] Searching the web` is what the system prompt specifies: the bullet sits
 * alone inside the brackets and the action follows them. `[Searching the web]`
 * puts the action inside. Understanding only the second meant a `[·] …` line
 * was captured as the single character `·`, stripped to nothing, and its
 * action text was left sitting in the answer as an ordinary line — the marker
 * did not register *and* its text leaked.
 *
 * Markdown after a bracket means content, not a marker: `[label](url)` links,
 * `[text][ref]` references, `[^1]:` footnote definitions.
 */
const STATUS_BULLET_LINE = /^[ \t]*\[·\][ \t]*([^\n]{1,80})/;
const STATUS_BRACKET_LINE = /^[ \t]*\[([^\]\n]{1,80})\](?![([:])/;

type StatusMatch = { text: string; length: number };

/**
 * A marker owns its line when a newline follows it immediately, which is what
 * lets the trailing newline be swallowed so markers do not each prepend a
 * blank line to the answer. A marker with prose after it on the same line does
 * not own it, and the prose stays.
 */
function matchStatus(text: string): StatusMatch | null {
  const match = STATUS_BULLET_LINE.exec(text) ?? STATUS_BRACKET_LINE.exec(text);
  if (!match) return null;
  return { text: match[1] ?? "", length: match[0].length };
}

const ownsLine = (text: string, length: number): boolean => text.indexOf("\n", length) === length;

export type FilteredChunk = {
  text: string;
  statuses: string[];
  plan: PlanPrefix | null;
  /** Tool calls the model emitted as fenced JSON blocks (see tool-call-block.ts). */
  toolCalls: ToolCall[];
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
   * Non-null while inside a ```json block. Everything from the opening fence is
   * accumulated here and released in one go, so a block split across arbitrary
   * deltas is never half-shown, and the block's own text is only released if it
   * turns out not to be a tool call.
   */
  let block: string | null = null;

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
        const close = matchCloseFence(buffer, atEnd);
        if (!close) {
          block += buffer;
          buffer = "";
          if (block.length > MAX_TOOL_BLOCK) {
            // Unterminated: give up rather than swallow the rest of the answer.
            output += block;
            block = null;
            atLineStart = false;
          }
          continue;
        }
        block += buffer.slice(0, close.index + close.length);
        buffer = buffer.slice(close.index + close.length);
        const finished = block;
        block = null;
        const call = parseToolCallBlock(finished, toolNames);
        if (call) {
          toolCalls.push(call);
          // The block owned its line, so drop the newline that ends it.
          eatNewline = ownsLine(buffer, 0);
          atLineStart = true;
        } else {
          output += finished;
          atLineStart = ownsLine(finished, finished.length);
        }
        continue;
      }

      if (atLineStart) {
        const open = matchOpenFence(buffer);
        if (open) {
          block = buffer.slice(0, open.length);
          buffer = buffer.slice(open.length);
          continue;
        }
        // A fence split across deltas ("``" then "`json\n"): hold the
        // half-fence instead of releasing it as text. One or two characters,
        // released on the next push once this is clearly not a tool block.
        if (mayBeOpenFence(buffer)) {
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

      const status = matchStatus(buffer);
      if (status) {
        const text = status.text.replace(/^·\s*/, "").trim().slice(0, 80);
        if (text) statuses.push(text);
        buffer = buffer.slice(status.length).replace(/^[ \t]+/, "");
        if (ownsLine(buffer, 0)) eatNewline = true;
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
      const close = matchCloseFence(block, true);
      const finished = close ? block.slice(0, close.index + close.length) : block;
      const rest = close ? block.slice(close.index + close.length) : "";
      block = null;
      // Never execute a block that never closed: whatever it parses as, it is
      // the model showing the user JSON, not a protocol message.
      const call = close ? parseToolCallBlock(finished, toolNames) : null;
      if (call) {
        toolCalls.push(call);
        // The block is the protocol, not content: it must not also be shown.
        output += rest;
      } else {
        output += finished + rest;
      }
    }

    return { text: output, statuses, plan, toolCalls };
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
