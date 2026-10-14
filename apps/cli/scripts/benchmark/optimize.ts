import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, resolveProvider } from "../../src/config.js";
import { CANDIDATE_B, CANDIDATE_E, buildCatalogCandidate, captureCandidateA, type RawCandidate } from "./candidates.js";
import { schemaHash } from "./candidates.js";
import { runCandidateOnTask, type TaskResult } from "./runner.js";
import { probeGateway } from "./health.js";
import { TASKS } from "./tasks.js";
import { partitionResults } from "./verify-results.js";
import { buildGroupedCandidate, DEFAULT_PLAN, EAGER_PRESETS, variantId, type VariantConfig } from "./variants.js";

/**
 * The optimization loop for the grouped-tool interface.
 *
 * This is an optimization problem, not a one-off A/B: search a small space of
 * interface knobs, repeat each point to beat single-run noise, maximize task
 * completion and then minimize cost (usage tokens, then latency), with
 * first-call validity as a diagnostic rather than the objective — because C2
 * showed a first-call win can cost more than it saves.
 *
 * Each (variant, repeat) runs into its own results file, incrementally, and
 * `--resume` re-runs only what is missing or invalid — a 429/transport artifact
 * is verified out and retried, never counted as a result. So the loop spans as
 * many rate-limit windows as it needs without losing or double-counting work.
 * Comparing stays fair: the same runner, dispatcher, tasks, and limits for every
 * point; only the built candidate's descriptions and field pool differ.
 */

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const resultsDir = join(process.cwd(), "benchmark", flag("--out") ?? "optimize");
const repeats = Math.max(1, Number(flag("--repeats") ?? "2"));

// `--provider <name>` measures against a specific registered provider instead of
// the active one. The model under test is a variable in its own right — results
// across models are not comparable — so it is printed up front, not assumed.
const providerName = flag("--provider");
const provider = resolveProvider(
  providerName ? { ...loadConfig(), activeProvider: providerName } : loadConfig(),
);
process.stderr.write(
  `measuring: ${provider.model} @ ${provider.baseUrl}${providerName ? ` (override: ${providerName})` : ""}\n`,
);
mkdirSync(resultsDir, { recursive: true });

// Single-instance lock. Two concurrent loop processes against one rate-limited
// gateway degrade the model into flailing ("I have no tools", retry storms),
// which corrupts the very signal being measured — the turns stop reflecting the
// interface and start reflecting the load. Refuse to run a second copy.
const lockFile = join(resultsDir, ".lock");
// --status is read-only: it reports on the running loop, so it must not be
// excluded by the single-instance lock.
const STATUS_MODE = process.argv.includes("--status");
if (!STATUS_MODE && existsSync(lockFile)) {
  const pid = readFileSync(lockFile, "utf8").trim();
  const alive =
    !!pid &&
    spawnSync(process.platform === "win32" ? "tasklist" : "ps",
      process.platform === "win32" ? ["/FI", `PID eq ${pid}`] : ["-p", pid],
      { stdio: "ignore" }).status === 0;
  if (alive) {
    console.error(`optimize.ts already running (pid ${pid}); refusing to start a second concurrent loop.`);
    process.exit(1);
  }
} else if (!STATUS_MODE) {
  writeFileSync(lockFile, String(process.pid));
}
const releaseLock = (): void => {
  if (STATUS_MODE) return;
  rmSync(lockFile, { force: true });
};
process.on("exit", releaseLock);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
/** Release the lock and stop cleanly — the lock must not outlive the process. */
const finishLoop = (): void => {
  releaseLock();
  process.exit(0);
};

// A short pause between turns so a serial run never reads as a burst to the
// gateway's fair-share limiter. Cheap insurance against self-inflicted 429s.
const PAUSE_MS = Number(flag("--pause") ?? "1500");
const pause = (): Promise<void> => new Promise((r) => setTimeout(r, PAUSE_MS));

// Probe before each turn and wait out a bad patch instead of burning a measured
// turn to discover it. This gateway alternates between ~6s and ~69s on a trivial
// task, and in the slow phase every candidate's first-call validity collapses
// together — so a blind loop spends turns to learn the gateway is bad, then
// throws the data away. Probing costs ~5k tokens to protect a ~50k-token turn.
const NO_PROBE = process.argv.includes("--no-probe");
// After a failed probe burst the gateway may be dark for a long while. Instead of
// dying and asking a human to restart, fall back to deep sleep and keep going:
// that is what "collects across as many windows as it needs" actually means.
// --max-idle caps how many 300s deep-sleep cycles to survive (default 48).
const MAX_IDLE = Math.max(1, Number(flag("--max-idle") ?? "48"));
const waitForHealthy = async (): Promise<boolean> => {
  if (NO_PROBE) return true;
  let idle = 0;
  for (;;) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const check = await probeGateway({ providerName });
      if (check.health === "ok") {
        return true;
      }
      const waitMs = Math.min(120_000, 5_000 * 2 ** Math.min(attempt, 4));
      process.stderr.write(`… gateway ${check.health} (${check.reason}); waiting ${Math.round(waitMs / 1000)}s\n`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    idle += 1;
    if (idle > MAX_IDLE) {
      process.stderr.write(`… gateway still dark after ${idle - 1} deep-sleep cycles; stopping; --resume later\n`);
      return false;
    }
    process.stderr.write(`… gateway dark; deep sleep 300s (cycle ${idle}/${MAX_IDLE})\n`);
    await new Promise((r) => setTimeout(r, 300_000));
  }
};

const plan: RawCandidate[] = [
  ...DEFAULT_PLAN.map(buildGroupedCandidate),
  // The deferred-discovery candidate is the one genuinely different breadth
  // strategy — a small eager set plus find_tool, so the full tool set is never
  // carried. It runs on equal footing with the grouped variants, and the eager
  // presets search where its boundary should sit.
  CANDIDATE_E,
  ...EAGER_PRESETS.map((preset) => buildCatalogCandidate(`cat-${preset.id}`, preset.eager)),
  // The spec's full candidate set includes the production capture and the flat
  // set — the references the grouped family is judged against. A is re-captured
  // at each loop start: production is a moving target, and the run file embeds
  // the exact definitions it measured with.
  captureCandidateA(process.cwd()),
  CANDIDATE_B,
];

/**
 * Collection order, most decision-relevant first.
 *
 * A full sweep is ~297 turns (~1.6M tokens) and the gateway offers windows of a
 * few turns, so a blind sweep never finishes. The question that decides the
 * interface is narrow — does beating C require leaving the grouped family at
 * all? — so the loop collects in the order that answers it soonest: the
 * cheapest grouped point and the two catalog variants, and only then the rest.
 * `--full-plan` disables this and runs the sweep in declaration order.
 */
const PRIORITY: Record<string, number> = {
  "g-required-full": 0, // terse args, full pool: the cheapest hardened grouped point
  "g-none-full": 1, // C itself, the baseline every other point is measured against
  "cat-read-write": 2, // cheapest catalog point — can deferral beat the family?
  E: 3,
  "g-full-full": 4, // C2
  "cat-read-grep-edit-write": 5,
  "g-required-trimmed": 6,
  "g-full-trimmed": 7,
  "cat-plus-shell-glob": 8,
  A: 9, // production capture: the baseline the family is judged against
  B: 10, // flat set: the other family reference
};
const ordered = process.argv.includes("--full-plan")
  ? plan
  : [...plan].sort((a, b) => (PRIORITY[a.id] ?? 99) - (PRIORITY[b.id] ?? 99));
const runFile = (id: string, r: number): string => join(resultsDir, `${id}-r${r}.json`);

const loadValid = (file: string): TaskResult[] => {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { results?: TaskResult[] };
    return Array.isArray(parsed.results) ? partitionResults(parsed.results).comparable : [];
  } catch {
    return [];
  }
};

// --- read-only dashboard: collection progress without touching the gateway
if (process.argv.includes("--status")) {
  for (const candidate of ordered) {
    for (let r = 1; r <= repeats; r += 1) {
      const { valid, comparable } = partitionResults(loadValid(runFile(candidate.id, r)));
      const excluded = valid.length - comparable.length;
      const complete = comparable.length === TASKS.length;
      process.stdout.write(
        `  ${candidate.id.padEnd(22)} r${r}  ${comparable.length}/${TASKS.length} comparable (file kept ${comparable.length} of ${comparable.length + excluded})${complete ? "  complete" : ""}\n`,
      );
    }
  }
  process.stdout.write(`\nmodel: ${provider.model} @ ${provider.baseUrl} | dir: ${resultsDir}\n`);
}

let ran = 0;
if (!STATUS_MODE) for (const candidate of ordered) {
  for (let r = 1; r <= repeats; r += 1) {
    const file = runFile(candidate.id, r);
    const done = new Set(loadValid(file).map((x) => x.taskId));
    const remaining = TASKS.filter((t) => !done.has(t.id));
    if (remaining.length === 0) {
      process.stderr.write(`… ${variantId(candidate as unknown as VariantConfig)} r${r}: complete\n`);
      continue;
    }
    const results = loadValid(file);
    for (const task of remaining) {
      if (!(await waitForHealthy())) {
        process.stderr.write("… stopping; re-run with --resume when the gateway recovers\n");
        finishLoop();
      }
      process.stderr.write(`… ${candidate.id} r${r} / ${task.id}\n`);
      const result = await runCandidateOnTask({ candidate, task, provider });
      results.push(result);
      // Persist only valid results; artifacts are dropped so a later --resume
      // retries exactly them. This keeps the incremental output trustworthy.
      // Keep only comparable turns: artifacts and bad-patch turns are dropped
      // from the saved file, so a later --resume re-runs exactly them and the
      // leaderboard never averages a degraded turn into a candidate's score.
      const { comparable } = partitionResults(results);
      writeFileSync(file, JSON.stringify({
        variant: candidate.id,
        repeat: r,
        model: provider.model,
        schemaHash: schemaHash(candidate),
        definitions: candidate.tools,
        results: comparable,
      }, null, 2));
      ran += 1;
      await pause();
    }
  }
}

// --- leaderboard: aggregate over repeats, rank by completion then cost ------

/**
 * Spread of a set of numbers: max - min, or null when there is no spread
 * to report (fewer than two samples). A leaderboard row with a single run
 * cannot claim a mean is the candidate's behaviour — it is one draw, and the
 * measured gateway variance is far larger than most interface effects. Showing
 * the spread next to the mean is what stops a thin dataset being read as a
 * settled result.
 */
const spread = (values: number[]): number | null =>
  values.length < 2 ? null : Math.max(...values) - Math.min(...values);

type Row = {
  id: string;
  n: number;
  completed: number;
  tasks: number;
  usage: number;
  usageSpread: number | null;
  calls: number;
  firstCall: number | null;
  costPerCompletion: number | null;
  /** Distinct (run × task) completion outcomes — the completion signal's own spread. */
  outcomes: string;
  /** Every measurement model in this row. A run resumed under a different provider
   *  appends its results to the same file; a mixed row breaks the one-provider-
   *  per-run fairness invariant, so it is flagged, never averaged silently. */
  models: string[];
};

const aggregate = (id: string, all: TaskResult[]): Row => {
  const byTask = new Map<string, TaskResult[]>();
  for (const r of all) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const completed = [...byTask.values()].filter((rs) => rs.some((r) => r.completed)).length;
  const withCalls = all.filter((r) => r.toolCalls > 0);
  const firstValid = withCalls.length > 0 ? withCalls.filter((r) => r.firstCallValid === true).length / withCalls.length : null;
  const totalUsage = all.reduce((sum, r) => sum + r.usageTokens, 0);
  const usages = all.map((r) => r.usageTokens);
  return {
    id,
    n: all.length,
    completed,
    tasks: byTask.size,
    usage: Math.round(totalUsage / Math.max(1, all.length)),
    usageSpread: spread(usages),
    calls: Math.round((all.reduce((s, r) => s + r.toolCalls, 0) / Math.max(1, all.length)) * 10) / 10,
    firstCall: firstValid,
    costPerCompletion: completed > 0 ? Math.round(totalUsage / completed) : null,
    outcomes: [...byTask.values()].map((rs) => rs.filter((r) => r.completed).length).join("/"),
    models: [...new Set(all.map((r) => r.model).filter((m): m is string => typeof m === "string"))],
  };
};

const rows: Row[] = [];
for (const candidate of plan) {
  const all: TaskResult[] = [];
  for (let r = 1; r <= repeats; r += 1) all.push(...loadValid(runFile(candidate.id, r)));
  if (all.length > 0) rows.push(aggregate(candidate.id, all));
}

// Reference points from the committed full comparison (A/B/C/C2/D, one run each).
// Those numbers were produced on the default provider; under a --provider
// override they would sit next to results from a different model in the same
// leaderboard — a cross-model comparison this harness does not make. An
// override looks for its own reference file instead.
const refFile = providerName ? `benchmark-results-${providerName}.json` : "benchmark-results-full.json";
if (existsSync(refFile)) {
  const ref = JSON.parse(readFileSync(refFile, "utf8")) as { results: TaskResult[] };
  for (const id of ["A", "B", "C", "C2", "D"]) {
    const all = ref.results.filter((r) => r.candidate === id);
    if (all.length > 0) rows.push({ ...aggregate(id, all), n: 1, models: [] });
  }
}

rows.sort((a, b) => b.completed - a.completed || (a.costPerCompletion ?? Infinity) - (b.costPerCompletion ?? Infinity) || a.usage - b.usage);
const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
process.stdout.write(`\nleaderboard — ${provider.model} @ ${provider.baseUrl} (completion↓, then tokens-per-completed-task↓, then usage↓)\n`);
process.stdout.write(`per-task completion shows how many of n repeats passed: 3/1/2 = ran 3, passed 1, passed 2\n`);
for (const row of rows) {
  const warn = (row.n < 3 ? "  ⚠ n<3, directional only" : "") + (row.models.length > 1 ? `  ⚠ mixed models (${row.models.join(", ")})` : "");
  process.stdout.write(
    `${row.id.padEnd(26)} completed=${row.completed}/${row.tasks}  per-task=${row.outcomes}  n=${row.n}  ` +
    `first-call=${pct(row.firstCall)}  calls=${row.calls}  tok/task=${row.costPerCompletion ?? "—"}  ` +
    `usage=${row.usage}${row.usageSpread !== null ? `±${row.usageSpread}` : ""}${warn}\n`,
  );
}
if (!STATUS_MODE) process.stdout.write(`\nran ${ran} turn(s) this invocation; re-run with --resume to continue across windows.\n`);
