import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TaskResult } from "./runner.js";

/**
 * Verify a benchmark results file before comparing it.
 *
 * A turn the model never actually produced — a rate-limit (429) or other
 * transport failure before the first response — is recorded as an answer
 * beginning "(turn failed:". That is an artifact of the gateway, not a task
 * outcome, and comparing it as a failure would be unfair to the candidate. This
 * separates the real results from the artifacts so a comparison only counts
 * what the model actually did.
 *
 * With `--clean` the artifacts are removed from the file and the valid results
 * kept, so a `--resume` run re-runs exactly the missing ones and every valid,
 * already-completed pair is left untouched.
 *
 *   node --import tsx apps/cli/scripts/benchmark/verify-results.ts <file> [--clean]
 */

/** True when the turn failed before the model responded (rate-limit / transport). */
export const isInvalid = (result: TaskResult): boolean => result.answer.startsWith("(turn failed:");

export function partitionResults(results: TaskResult[]): { valid: TaskResult[]; invalid: TaskResult[] } {
  return { valid: results.filter((r) => !isInvalid(r)), invalid: results.filter(isInvalid) };
}

const isMain = (): boolean => (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("verify-results.ts");

if (isMain()) {
  const file = process.argv[2];
  if (!file || !existsSync(file)) {
    console.error("usage: verify-results.ts <results.json> [--clean]");
    process.exit(1);
  }
  const clean = process.argv.includes("--clean");
  const report = JSON.parse(readFileSync(file, "utf8")) as { results: TaskResult[] };
  const { valid, invalid } = partitionResults(report.results);
  for (const r of report.results) {
    const flag = isInvalid(r) ? "INVALID" : "valid  ";
    console.log(`${r.candidate}  ${r.taskId.padEnd(20)} ${flag}  completed=${r.completed}  calls=${r.toolCalls}`);
  }
  console.log(`\n${valid.length} valid, ${invalid.length} invalid (rate-limit / transport artifacts)`);
  if (clean && invalid.length > 0) {
    report.results = valid;
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`removed ${invalid.length} invalid; a --resume run re-runs exactly those.`);
  }
}
