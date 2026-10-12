import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage, TurnAudit } from "@actor0/harness";
import { dataDir } from "./paths.js";

/**
 * A local usage log — one line per turn — for `/usage`.
 *
 * Token counts are the one usage fact that is exact and universal: every
 * provider reports them, so today / this week / this month can be totalled
 * locally without a provider round trip. Quota *remaining* is provider-specific
 * and only some report it, so it is fetched separately and shown when available
 * rather than guessed here.
 *
 * Append-only JSONL, in the data dir beside sessions: a corrupt line is skipped
 * rather than failing the read, and a missing file is an empty log.
 */

export type UsageEntry = {
  /** Epoch ms when the turn finished. */
  t: number;
  model: string;
  prompt: number;
  completion: number;
  total: number;
};

const usageFile = (): string => join(dataDir(), "usage.jsonl");

/** Append one turn's token counts. */
export function recordUsage(model: string, usage: Usage): void {
  const entry: UsageEntry = {
    t: Date.now(),
    model,
    prompt: usage.prompt_tokens ?? 0,
    completion: usage.completion_tokens ?? 0,
    total: usage.total_tokens ?? 0,
  };
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(usageFile(), `${JSON.stringify(entry)}\n`, "utf8");
}

/** Every recorded turn, oldest first. */
export function readUsage(): UsageEntry[] {
  let raw: string;
  try {
    raw = readFileSync(usageFile(), "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as UsageEntry;
      if (typeof entry.t === "number" && typeof entry.total === "number") out.push(entry);
    } catch {
      // A torn or corrupt line is one dropped turn, not a broken /usage.
    }
  }
  return out;
}

/**
 * One turn's audit record — what it did, not just what it cost.
 *
 * `UsageEntry` is the token accounting every provider reports; this is the
 * rest of what a turn was, carried back on the harness's `RunResult.audit`
 * and written here with the model and a timestamp the harness does not know.
 * Append-only JSONL beside `usage.jsonl`, for the same reasons.
 */
export type AuditEntry = {
  /** Epoch ms when the turn finished. */
  t: number;
  model: string;
  rounds: number;
  complete: boolean;
  /** Tool calls the model made, by tool name. */
  toolCalls: Record<string, number>;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

const auditFile = (): string => join(dataDir(), "audit.jsonl");

/** Append one turn's audit record. */
export function recordAudit(model: string, audit: TurnAudit): void {
  const entry: AuditEntry = {
    t: Date.now(),
    model,
    rounds: audit.rounds,
    complete: audit.complete,
    toolCalls: audit.toolCalls,
    toolCallCount: audit.toolCallCount,
    promptTokens: audit.promptTokens,
    completionTokens: audit.completionTokens,
    totalTokens: audit.totalTokens,
  };
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(auditFile(), `${JSON.stringify(entry)}\n`, "utf8");
}

/** Every recorded audit, oldest first. */
export function readAudit(): AuditEntry[] {
  let raw: string;
  try {
    raw = readFileSync(auditFile(), "utf8");
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (typeof entry.t === "number" && typeof entry.rounds === "number") out.push(entry);
    } catch {
      // A torn or corrupt line is one dropped turn, not a broken read.
    }
  }
  return out;
}
export type UsageBucket = { tokens: number; turns: number };

/** Total tokens and turn count for entries at or after `since` (epoch ms). */
export function usageSince(entries: UsageEntry[], since: number): UsageBucket {
  return entries
    .filter((entry) => entry.t >= since)
    .reduce<UsageBucket>((acc, entry) => ({ tokens: acc.tokens + entry.total, turns: acc.turns + 1 }), { tokens: 0, turns: 0 });
}

/** Tokens grouped by model, largest first, for entries at or after `since`. */
export function usageByModel(entries: UsageEntry[], since = 0): { model: string; tokens: number }[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.t < since) continue;
    totals.set(entry.model, (totals.get(entry.model) ?? 0) + entry.total);
  }
  return [...totals.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** Midnight local time today. */
export function startOfDay(now: Date = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Midnight local time at the start of this week (Monday). */
export function startOfWeek(now: Date = new Date()): number {
  const day = (now.getDay() + 6) % 7; // Monday = 0
  return startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - day));
}

/** Midnight local time on the 1st of this month. */
export function startOfMonth(now: Date = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** A token count as a compact string: 1_234 → "1.2k", 2_500_000 → "2.5M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * A 10-cell context bar for a fraction used (0..1), e.g. `[████░░░░░░]`.
 * A visual gauge for the status line, where a bare percentage hides how close
 * to the edge the window is.
 */
export function contextBar(fraction: number): string {
  const cells = 10;
  const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
  return `[${"█".repeat(filled)}${"░".repeat(cells - filled)}]`;
}
