import type { ReasoningSummary } from "./types.js";

const MAX_TITLE = 90;
const MAX_SUMMARY = 900;

/**
 * One line of model reasoning with the markup stripped off.
 *
 * A heading marker, a bold run or a list bullet means something to a markdown
 * renderer and nothing to anyone reading a terminal. Left in, it is the
 * transcript showing the model its own syntax: a conversation containing a
 * literal "##" looks like a log dump rather than a thought.
 *
 * Exported because every surface that shows reasoning has to strip it, and a
 * second copy of this in a renderer is a second set of rules for the same job.
 */
export function stripReasoningMarkup(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\[·?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatReasoningSummary(text: string): ReasoningSummary {
  const lines = text.split("\n").map(stripReasoningMarkup).filter((line) => line.length > 0);
  if (lines.length === 0) return { title: "", summary: "" };

  const bracketed = /^\[(?:·\s*)?([^\]]{2,60})\]$/.exec(lines[0] ?? "");
  let title = "";
  let body = lines;
  if (bracketed) {
    title = (bracketed[1] ?? "").trim().slice(0, MAX_TITLE);
    body = lines.slice(1);
  } else if (lines.length > 1) {
    const first = text.split("\n")[0] ?? "";
    if (/^\s{0,3}(?:#{1,6}\s+|\*\*)/.test(first)) {
      title = (lines[0] ?? "").slice(0, MAX_TITLE);
      body = lines.slice(1);
    }
  }
  const summary = body.join(" ").slice(0, MAX_SUMMARY);
  if (!title && summary) {
    title = (summary.split(/(?<=[.!?])\s/)[0] ?? "").slice(0, MAX_TITLE);
  }
  return { title, summary };
}
