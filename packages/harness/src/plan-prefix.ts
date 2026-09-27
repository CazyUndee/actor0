import type { PlanPrefix } from "./types.js";

const MAX_HEADING_LEN = 100;
const MAX_PLAN_LEN = 1_200;

function headingText(line: string): string | null {
  const match = /^\s{0,3}#{1,6}\s+(\S.*?)\s*#*\s*$/.exec(line);
  if (!match) return null;
  const text = (match[1] ?? "").trim();
  if (!text || text.length > MAX_HEADING_LEN) return null;
  return text;
}

export function parsePlanPrefix(buffer: string): PlanPrefix | null {
  const newline = buffer.indexOf("\n");
  if (newline === -1) return null;
  const title = headingText(buffer.slice(0, newline));
  if (!title) return null;

  let start = newline + 1;
  let end = buffer.indexOf("\n\n", start);
  if (buffer.startsWith("\n", start)) {
    const second = buffer.indexOf("\n\n", start + 1);
    const between = second === -1 ? "" : buffer.slice(start + 1, second);
    if (second !== -1 && between.length > 0 && between.length <= MAX_PLAN_LEN) {
      start += 1;
      end = second;
    } else {
      start = newline + 1;
      end = newline;
    }
  }
  if (end === -1) return null;
  const body = buffer.slice(start, end);
  if (body.length > MAX_PLAN_LEN) return null;
  return {
    title,
    plan: buffer.slice(0, end).replace(/\s+$/, ""),
    consumed: end + 2,
  };
}

export function needsMorePlanData(buffer: string): boolean {
  if (!/^\s{0,3}(?:#{1,6}\s+|#{0,6}\s*$)/.test(buffer)) return false;
  const newline = buffer.indexOf("\n");
  if (newline === -1) return true;
  if (!headingText(buffer.slice(0, newline))) return false;
  return !buffer.includes("\n\n");
}

export function extractPlanPrefix(buffer: string): { plan: PlanPrefix | null; rest: string } {
  const plan = parsePlanPrefix(buffer);
  return plan
    ? { plan, rest: buffer.slice(plan.consumed) }
    : { plan: null, rest: buffer };
}
