import { type CandidateId, exposedOperations, schemaHash, type RawCandidate } from "./candidates.js";
import type { TaskResult } from "./runner.js";

/**
 * Aggregate per-candidate results into a summary, and assemble the full report
 * with the exact schema hashes and metadata preserved in every record.
 */

export type CandidateSummary = {
  candidate: CandidateId;
  schemaHash: string;
  tasks: number;
  completed: number;
  completionRate: number;
  /** First-call schema validity, over tasks that made at least one tool call. */
  firstCallValidRate: number | null;
  /** Recovery after a schema-invalid call, over tasks that had one. */
  recoveryRate: number | null;
  toolCalls: number;
  schemaInvalid: number;
  semanticInvalid: number;
  unsupported: number;
  usageTokens: number;
  /** Tool-definition tokens — the interface's own standing cost, same for every task. */
  toolDefTokens: number;
  avgLatencyMs: number;
};

const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function summarize(results: TaskResult[], candidate: RawCandidate): CandidateSummary {
  const mine = results.filter((r) => r.candidate === candidate.id);
  const withCalls = mine.filter((r) => r.toolCalls > 0);
  const firstValid = withCalls.filter((r) => r.firstCallValid === true).length;
  const withInvalid = mine.filter((r) => r.recovered !== null);
  const recovered = withInvalid.filter((r) => r.recovered === true).length;
  const completed = mine.filter((r) => r.completed).length;
  return {
    candidate: candidate.id,
    schemaHash: schemaHash(candidate),
    tasks: mine.length,
    completed,
    completionRate: rate(completed, mine.length) ?? 0,
    firstCallValidRate: rate(firstValid, withCalls.length),
    recoveryRate: rate(recovered, withInvalid.length),
    toolCalls: mine.reduce((sum, r) => sum + r.toolCalls, 0),
    schemaInvalid: mine.reduce((sum, r) => sum + r.schemaInvalid, 0),
    semanticInvalid: mine.reduce((sum, r) => sum + r.semanticInvalid, 0),
    unsupported: mine.reduce((sum, r) => sum + r.unsupported, 0),
    usageTokens: mine.reduce((sum, r) => sum + r.usageTokens, 0),
    toolDefTokens: mine.length > 0 ? mine[0]!.toolDefTokens : 0,
    avgLatencyMs: mine.length > 0 ? Math.round(mine.reduce((sum, r) => sum + r.latencyMs, 0) / mine.length) : 0,
  };
}

export type BenchmarkReport = {
  metadata: {
    model: string;
    date: string;
    tokenizerNote: string;
    providerLimitations: string[];
  };
  schemas: { candidate: CandidateId; label: string; hash: string; toolCount: number; operations: string[] }[];
  summaries: CandidateSummary[];
  results: TaskResult[];
};

export function buildReport(
  results: TaskResult[],
  candidates: RawCandidate[],
  metadata: BenchmarkReport["metadata"],
): BenchmarkReport {
  return {
    metadata,
    schemas: candidates.map((c) => ({
      candidate: c.id,
      label: c.label,
      hash: schemaHash(c),
      toolCount: c.tools.length,
      operations: exposedOperations(c),
    })),
    summaries: candidates.map((c) => summarize(results, c)),
    results,
  };
}
