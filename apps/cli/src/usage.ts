import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@actor0/harness";
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

export type UsageBucket = { tokens: number; turns: number };

/** Total tokens and turn count for entries at or after `since` (epoch ms). */
export function usageSince(entries: UsageEntry[], since: number): UsageBucket {
  return entries
    .filter((entry) => entry.t >= since)
    .reduce<UsageBucket>((acc, entry) => ({ tokens: acc.tokens + entry.total, turns: acc.turns + 1 }), { tokens: 0, turns: 0 });
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
