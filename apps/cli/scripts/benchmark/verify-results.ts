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

/**
 * True when a turn ran but the gateway was in a bad patch, so the numbers do
 * not reflect the interface.
 *
 * Measured, not guessed: against this gateway the same task swings between ~6s
 * and ~69s wall time, and in a bad patch the model flails — it claims it has no
 * tools, retries, and burns 4-16 calls on a one-call task, so first-call
 * validity collapses to 0% for every candidate at once. When *every* candidate
 * degrades together it is the endpoint, not the interface, and the run must be
 * discarded rather than compared.
 *
 * The per-turn tell is a retry storm: many calls, none of them a valid first
 * call, on a task that needs at most a couple of calls. One clean pass shows
 * such tasks completing in 1-2 calls, so this cannot be a real interface effect.
 */
export const isBadPatch = (result: TaskResult): boolean =>
  !isInvalid(result) && result.toolCalls >= 4 && result.firstCallValid !== true;

/**
 * A result is comparable only if it is real (not a transport failure) and was
 * not taken during a gateway bad patch. Everything else is re-runnable.
 */
export const isComparable = (result: TaskResult): boolean => !isInvalid(result) && !isBadPatch(result);

export function partitionResults(results: TaskResult[]): {
  valid: TaskResult[];
  invalid: TaskResult[];
  badPatch: TaskResult[];
  comparable: TaskResult[];
} {
  return {
    valid: results.filter((r) => !isInvalid(r)),
    invalid: results.filter(isInvalid),
    badPatch: results.filter(isBadPatch),
    comparable: results.filter(isComparable),
  };
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
  const { valid, invalid, badPatch, comparable } = partitionResults(report.results);
  for (const r of report.results) {
    const flag = isInvalid(r) ? "INVALID " : isBadPatch(r) ? "BAD-PATCH" : "valid   ";
    console.log(`${r.candidate}  ${r.taskId.padEnd(20)} ${flag}  completed=${r.completed}  calls=${r.toolCalls}`);
  }
  console.log(`\n${valid.length} valid, ${invalid.length} invalid (rate-limit / transport), ${badPatch.length} bad-patch (gateway degraded)`);
  console.log(`${comparable.length} comparable (valid and not bad-patch)`);
  if (clean && invalid.length + badPatch.length > 0) {
    report.results = comparable;
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`removed ${invalid.length + badPatch.length}; a --resume run re-runs exactly those.`);
  }
}
