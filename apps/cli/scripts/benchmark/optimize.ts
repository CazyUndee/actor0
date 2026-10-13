import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, resolveProvider } from "../../src/config.js";
import { CANDIDATE_E, type RawCandidate } from "./candidates.js";
import { runCandidateOnTask, type TaskResult } from "./runner.js";
import { TASKS } from "./tasks.js";
import { partitionResults } from "./verify-results.js";
import { buildGroupedCandidate, DEFAULT_PLAN, variantId, type VariantConfig } from "./variants.js";

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

const resultsDir = join(process.cwd(), "benchmark", "optimize");
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const repeats = Math.max(1, Number(flag("--repeats") ?? "2"));

const provider = resolveProvider(loadConfig());
mkdirSync(resultsDir, { recursive: true });

// Single-instance lock. Two concurrent loop processes against one rate-limited
// gateway degrade the model into flailing ("I have no tools", retry storms),
// which corrupts the very signal being measured — the turns stop reflecting the
// interface and start reflecting the load. Refuse to run a second copy.
const lockFile = join(resultsDir, ".lock");
if (existsSync(lockFile)) {
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
}
writeFileSync(lockFile, String(process.pid));
const releaseLock = () => rmSync(lockFile, { force: true });
process.on("exit", releaseLock);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// A short pause between turns so a serial run never reads as a burst to the
// gateway's fair-share limiter. Cheap insurance against self-inflicted 429s.
const PAUSE_MS = Number(flag("--pause") ?? "1500");
const pause = (): Promise<void> => new Promise((r) => setTimeout(r, PAUSE_MS));

const plan: RawCandidate[] = [
  ...DEFAULT_PLAN.map(buildGroupedCandidate),
  // The deferred-discovery candidate is the one genuinely different breadth
  // strategy — a small eager set plus find_tool, so the full tool set is never
  // carried. It runs on equal footing with the grouped variants.
  CANDIDATE_E,
];
const runFile = (id: string, r: number): string => join(resultsDir, `${id}-r${r}.json`);

const loadValid = (file: string): TaskResult[] => {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { results?: TaskResult[] };
    return Array.isArray(parsed.results) ? partitionResults(parsed.results).valid : [];
  } catch {
    return [];
  }
};

let ran = 0;
for (const candidate of plan) {
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
      process.stderr.write(`… ${candidate.id} r${r} / ${task.id}\n`);
      const result = await runCandidateOnTask({ candidate, task, provider });
      results.push(result);
      // Persist only valid results; artifacts are dropped so a later --resume
      // retries exactly them. This keeps the incremental output trustworthy.
      const { valid } = partitionResults(results);
      writeFileSync(file, JSON.stringify({ variant: candidate.id, repeat: r, results: valid }, null, 2));
      ran += 1;
      await pause();
    }
  }
}

// --- leaderboard: aggregate over repeats, rank by completion then cost ------

type Row = { id: string; n: number; completed: number; tasks: number; usage: number; latency: number; calls: number; firstCall: number | null };

const aggregate = (id: string, all: TaskResult[]): Row => {
  const byTask = new Map<string, TaskResult[]>();
  for (const r of all) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const completed = [...byTask.values()].filter((rs) => rs.some((r) => r.completed)).length;
  const withCalls = all.filter((r) => r.toolCalls > 0);
  const firstValid = withCalls.length > 0 ? withCalls.filter((r) => r.firstCallValid === true).length / withCalls.length : null;
  return {
    id,
    n: all.length,
    completed,
    tasks: byTask.size,
    usage: Math.round(all.reduce((s, r) => s + r.usageTokens, 0) / Math.max(1, all.length)),
    latency: Math.round(all.reduce((s, r) => s + r.latencyMs, 0) / Math.max(1, all.length)),
    calls: Math.round((all.reduce((s, r) => s + r.toolCalls, 0) / Math.max(1, all.length)) * 10) / 10,
    firstCall: firstValid,
  };
};

const rows: Row[] = [];
for (const candidate of plan) {
  const all: TaskResult[] = [];
  for (let r = 1; r <= repeats; r += 1) all.push(...loadValid(runFile(candidate.id, r)));
  if (all.length > 0) rows.push(aggregate(candidate.id, all));
}

// Reference points from the committed full comparison (A/B/C/C2/D, one run each).
const refFile = "benchmark-results-full.json";
if (existsSync(refFile)) {
  const ref = JSON.parse(readFileSync(refFile, "utf8")) as { results: TaskResult[] };
  for (const id of ["A", "B", "C", "C2", "D"]) {
    const all = ref.results.filter((r) => r.candidate === id);
    if (all.length > 0) rows.push({ ...aggregate(id, all), n: 1 });
  }
}

rows.sort((a, b) => b.completed - a.completed || a.usage - b.usage || a.latency - b.latency);
const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
process.stdout.write(`\nleaderboard (completion↓, then usage↓, then latency↓):\n`);
for (const row of rows) {
  process.stdout.write(
    `${row.id.padEnd(16)} completed=${row.completed}/${row.tasks}  n=${row.n}  first-call=${pct(row.firstCall)}  ` +
    `calls=${row.calls}  usage=${row.usage}  avg-ms=${row.latency}\n`,
  );
}
process.stdout.write(`\nran ${ran} turn(s) this invocation; re-run with --resume to continue across windows.\n`);
