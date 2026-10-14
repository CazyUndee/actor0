import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, resolveProvider } from "../../src/config.js";
import { CANDIDATE_B, CANDIDATE_C, CANDIDATE_C2, CANDIDATE_D, captureCandidateA } from "./candidates.js";
import { buildReport } from "./report.js";
import { runCandidateOnTask, type TaskResult } from "./runner.js";
import { partitionResults } from "./verify-results.js";
import { TASKS } from "./tasks.js";

/**
 * Run the tool-interface benchmark: every candidate on every task, same model
 * and limits, and write a JSON report with the exact schema hashes.
 *
 *   node --import tsx apps/cli/scripts/benchmark/index.ts [--out results.json]
 *     [--candidate A|B|C|D] [--task <id>] [--resume]
 *
 * Uses the configured provider. A candidate the provider cannot run faithfully
 * (e.g. Candidate D's oneOf union, if the endpoint rejects it) fails its turns
 * and that is recorded, not masked.
 *
 * The report is written after every candidate, and `--resume` keeps results
 * already in the output file and only runs what is missing. That matters
 * because the gateway enforces a fair-share rate limit (~214s window): a single
 * 36-turn run exhausts it partway and the rest come back 429, which is an
 * artifact, not a result. Running one candidate per window with `--resume`
 * builds the full comparison without losing the candidates that already ran.
 */

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string): boolean => process.argv.includes(name);

const onlyCandidate = flag("--candidate");
const onlyTask = flag("--task");
const resume = has("--resume");
const providerName = flag("--provider");
// --pause: seconds between turns so a serial sweep never reads as a burst to a
// fair-share limiter. --ref: write the report to the reference file the loop
// leaderboard reads for this provider (benchmark-results-<provider>.json).
const PAUSE_S = Number(flag("--pause") ?? "0");
const ref = has("--ref");
const outPath = flag("--out") ?? (ref ? `benchmark-results-${providerName ?? "active"}.json` : "benchmark-results.json");

const provider = resolveProvider(providerName ? { ...loadConfig(), activeProvider: providerName } : loadConfig());
const all = [captureCandidateA(process.cwd()), CANDIDATE_B, CANDIDATE_C, CANDIDATE_C2, CANDIDATE_D];
const candidates = onlyCandidate ? all.filter((c) => c.id === onlyCandidate) : all;
const tasks = onlyTask ? TASKS.filter((t) => t.id === onlyTask) : TASKS;
if (candidates.length === 0) throw new Error(`no such candidate: ${onlyCandidate}`);
if (tasks.length === 0) throw new Error(`no such task: ${onlyTask}`);

const metadata = {
  model: provider.model,
  provider: providerName ?? "active",
  baseUrl: provider.baseUrl,
  date: new Date().toISOString(),
  tokenizerNote: "tool-definition tokens approximated at ~4 chars/token; the target model's tokenizer was not available",
  providerLimitations: [
    "Candidate D exposes a oneOf/const union; if the provider's structured tool-calling rejects it, D's turns fail and that is recorded, not masked.",
    "delete is an unsupported capability (Actor0 has no delete); every candidate fails it and it is documented, not invented.",
    "Candidate A is the exact production interface, which does not expose tree/index/web tools; the report does not adjust for that.",
    "The gateway enforces a fair-share rate limit (~214s window); a run interrupted by it records failed turns, so build a full comparison with --resume one candidate per window.",
  ],
};

// Keep any results already in the output file when resuming.
const key = (r: TaskResult): string => `${r.candidate}:${r.taskId}`;
let results: TaskResult[] = [];
if (resume && existsSync(outPath)) {
  try {
    const prior = JSON.parse(readFileSync(outPath, "utf8")) as { results?: TaskResult[] };
    if (Array.isArray(prior.results)) {
      // A resume rebuilds the set from kept files; drop transport artifacts, bad-patch
      // turns, and harness-miswired turns so a re-run covers exactly the gaps.
      results = partitionResults(prior.results).comparable;
    }
  } catch {
    // A corrupt prior file is ignored; we start fresh rather than crash.
  }
}
const writeReport = (): void => {
  writeFileSync(outPath, JSON.stringify(buildReport(results, all, metadata), null, 2));
};

for (const candidate of candidates) {
  const done = new Set(results.filter((r) => r.candidate === candidate.id).map((r) => r.taskId));
  const remaining = tasks.filter((t) => !(resume && done.has(t.id)));
  if (remaining.length === 0) {
    process.stderr.write(`… candidate ${candidate.id}: already complete, skipping (resume)\n`);
    continue;
  }
  for (const task of remaining) {
    process.stderr.write(`… candidate ${candidate.id} / task ${task.id}\n`);
    const result = await runCandidateOnTask({ candidate, task, provider });
    // Replace any prior record for this candidate+task, then persist immediately
    // so a rate-limited interruption keeps every candidate that finished.
    results = [...results.filter((r) => key(r) !== key(result)), result];
    writeReport();
    if (PAUSE_S > 0) await new Promise((r) => setTimeout(r, PAUSE_S * 1000));
  }
}

const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
for (const s of buildReport(results, all, metadata).summaries) {
  process.stdout.write(
    `${s.candidate}  hash=${s.schemaHash}  completed=${s.completed}/${s.tasks} (${pct(s.completionRate)})  ` +
    `first-call-valid=${pct(s.firstCallValidRate)}  recovery=${pct(s.recoveryRate)}  calls=${s.toolCalls}  ` +
    `schema-invalid=${s.schemaInvalid}  semantic-invalid=${s.semanticInvalid}  unsupported=${s.unsupported}  ` +
    `usage-tok=${s.usageTokens}  tooldef-tok=${s.toolDefTokens}  avg-ms=${s.avgLatencyMs}\n`,
  );
}
process.stdout.write(`\nwrote ${outPath}\n`);
