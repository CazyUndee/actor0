import { writeFileSync } from "node:fs";
import { loadConfig, resolveProvider } from "../../src/config.js";
import { CANDIDATE_B, CANDIDATE_C, CANDIDATE_D, captureCandidateA } from "./candidates.js";
import { buildReport } from "./report.js";
import { runCandidateOnTask } from "./runner.js";
import { TASKS } from "./tasks.js";

/**
 * Run the tool-interface benchmark: every candidate on every task, same model
 * and limits, and write a JSON report with the exact schema hashes.
 *
 *   node --import tsx apps/cli/scripts/benchmark/index.ts [--out results.json]
 *
 * Uses the configured provider. A candidate the provider cannot run faithfully
 * (e.g. Candidate D's oneOf union, if the endpoint rejects it) fails its turns
 * and that is recorded, not masked.
 */

const outFlag = process.argv.indexOf("--out");
const out = outFlag >= 0 ? process.argv[outFlag + 1]! : "benchmark-results.json";

const provider = resolveProvider(loadConfig());
const candidates = [captureCandidateA(process.cwd()), CANDIDATE_B, CANDIDATE_C, CANDIDATE_D];

const results = [];
for (const candidate of candidates) {
  for (const task of TASKS) {
    process.stderr.write(`… candidate ${candidate.id} / task ${task.id}\n`);
    results.push(await runCandidateOnTask({ candidate, task, provider }));
  }
}

const report = buildReport(results, candidates, {
  model: provider.model,
  date: new Date().toISOString(),
  tokenizerNote: "tool-definition tokens approximated at ~4 chars/token; the target model's tokenizer was not available",
  providerLimitations: [
    "Candidate D exposes a oneOf/const union; if the provider's structured tool-calling rejects it, D's turns fail and that is recorded, not masked.",
    "delete is an unsupported capability (Actor0 has no delete); every candidate fails it and it is documented, not invented.",
    "Candidate A is the exact production interface, which does not expose tree/index/web tools; those tasks are weaker for A and the report does not adjust for it.",
  ],
});

writeFileSync(out, JSON.stringify(report, null, 2));

const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
for (const s of report.summaries) {
  process.stdout.write(
    `${s.candidate}  hash=${s.schemaHash}  completed=${s.completed}/${s.tasks} (${pct(s.completionRate)})  ` +
    `first-call-valid=${pct(s.firstCallValidRate)}  recovery=${pct(s.recoveryRate)}  calls=${s.toolCalls}  ` +
    `schema-invalid=${s.schemaInvalid}  semantic-invalid=${s.semanticInvalid}  unsupported=${s.unsupported}  ` +
    `usage-tok=${s.usageTokens}  tooldef-tok=${s.toolDefTokens}  avg-ms=${s.avgLatencyMs}\n`,
  );
}
process.stdout.write(`\nwrote ${out}\n`);
