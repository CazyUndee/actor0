// The verdict: what the collected data supports, stated no stronger than the
// data. The whole measurement discipline (repeats, bad-patch exclusion,
// per-model separation, directional markers) exists to end at a conclusion
// that is exactly as strong as the evidence. This computes it per provider
// from what was actually collected, and says plainly when it is not decided.
//
//   node --import tsx apps/cli/scripts/benchmark/verdict.ts [--provider sapiens] [--quiet]
//
// Reads the one-shot reference file for the provider plus every loop run file
// in its results directory, excludes everything the verifier excludes, and
// refuses to decide on mixed-model or under-collected data.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskResult } from "./runner.js";
import { partitionResults } from "./verify-results.js";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const REPEATS_NEEDED = 3;

type Row = {
  id: string;
  turns: number;
  /** Repeats covering every task — confidence is set by the least-covered task. */
  repeats: number;
  completed: number;
  tasks: number;
  usage: number;
  costPerCompletion: number | null;
};

function aggregate(id: string, all: TaskResult[]): Row | undefined {
  if (all.length === 0) return undefined;
  const models = new Set(all.map((r) => r.model).filter((m): m is string => typeof m === "string"));
  if (models.size > 1) {
    // A verdict across models is not a verdict. Refuse rather than average. (A
    // legacy file without the model field yields an empty set — homogeneous by
    // definition, not mixed.)
    throw new Error(`${id}: results mix measurement models (${[...models].join(", ")}); verdicts are per-model`);
  }
  const byTask = new Map<string, TaskResult[]>();
  for (const r of all) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const counts = [...byTask.values()].map((rs) => rs.length);
  const completed = byTask.size - [...byTask.values()].filter((rs) => !rs.some((r) => r.completed)).length;
  const usages = all.map((r) => r.usageTokens);
  const total = usages.reduce((a, b) => a + b, 0);
  return {
    id,
    turns: all.length,
    repeats: Math.min(...counts),
    completed,
    tasks: byTask.size,
    usage: Math.round(total / usages.length),
    costPerCompletion: completed > 0 ? Math.round(total / completed) : null,
  };
}

function loadAll(refFile: string | undefined, resultsDir: string | undefined, batteryFile: string | undefined, id: string): TaskResult[] {
  const out: TaskResult[] = [];
  if (batteryFile && existsSync(batteryFile)) {
    const rep = JSON.parse(readFileSync(batteryFile, "utf8")) as { results?: TaskResult[] };
    out.push(...partitionResults(rep.results ?? []).comparable.filter((r) => r.candidate === id));
  }
  if (refFile && existsSync(refFile)) {
    const rep = JSON.parse(readFileSync(refFile, "utf8")) as { results?: TaskResult[] };
    out.push(...partitionResults(rep.results ?? []).comparable.filter((r) => r.candidate === id));
  }
  if (resultsDir && existsSync(resultsDir)) {
    const pattern = new RegExp(`^${id}-r\\d+\\.json$`);
    for (const f of readdirSync(resultsDir).filter((x) => pattern.test(x))) {
      const parsed = JSON.parse(readFileSync(join(resultsDir, f), "utf8")) as { results?: TaskResult[] };
      out.push(...partitionResults(parsed.results ?? []).comparable.filter((r) => r.candidate === id));
    }
  }
  return out;
}

function verdictFor(name: string, refFile: string | undefined, resultsDir: string | undefined, batteryFile: string | undefined, quiet: boolean): string | null {
  const rows: Row[] = [];
  for (const id of ["A", "B", "C", "C2", "D", "E"]) {
    const row = aggregate(id, loadAll(refFile, resultsDir, batteryFile, id));
    if (row) rows.push(row);
  }
  if (rows.length === 0) return null;
  const rank = [...rows].sort(
    (a, b) =>
      b.completed - a.completed ||
      (a.costPerCompletion ?? Infinity) - (b.costPerCompletion ?? Infinity) ||
      a.usage - b.usage,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const top = rank[0]!;
  const c = byId.get("C");
  const c2 = byId.get("C2");
  const e = byId.get("E");

  if (!quiet) {
  process.stdout.write(`\n=== verdict — ${name} (${top.turns} comparable turns, ${rows.length} candidates measured) ===\n`);
  for (const r of rank) {
    const repeatFlag = r.repeats >= REPEATS_NEEDED ? `${r.repeats} repeats` : `⚠ ${r.repeats}/${REPEATS_NEEDED} repeats`;
    process.stdout.write(
      `  ${r.id.padEnd(3)} ${String(r.completed).padStart(2)}/${String(r.tasks).padStart(2)} completed   ` +
      `${(r.costPerCompletion ?? "—").toString().padStart(6)} tok/task   ${repeatFlag}\n`,
    );
  }
  }

  let text: string;
  if (top.repeats < REPEATS_NEEDED || top.completed === 0) {
    if (top.completed === 0) {
      text = "no candidate completes any task on this model. That is a model-capability result, not an interface ranking — the benchmark measures the interface, and a model that cannot complete the tasks cannot rank interfaces.";
    } else {
      text = `${top.id} leads (${top.completed}/${top.tasks} completed @ ${top.costPerCompletion} tok/task) but on only ${top.repeats}/${REPEATS_NEEDED} repeats — directional, not a verdict. Keep collecting.`;
    }
  } else {
    const detail: string[] = [];
    if (c) detail.push(`C ${c.completed}/${c.tasks}@${c.costPerCompletion ?? "—"}`);
    if (c2) detail.push(`C2 ${c2.completed}/${c2.tasks}@${c2.costPerCompletion ?? "—"}`);
    if (e) detail.push(`E ${e.completed}/${e.tasks}@${e.costPerCompletion ?? "—"}`);
    let decision: string;
    if (c && c2 && e) {
      if (e.completed > c2.completed && e.completed > c.completed) {
        decision = "leave the grouped family: the deferred-discovery catalog (E) beats both grouped points, and deferral is the only breadth strategy that did.";
      } else if (c2.completed > c.completed && e.completed <= c2.completed) {
        decision = "stay in the grouped family and harden it: C2 beats C on completions, and nothing measured beats C2 — the loop's remaining knobs (trimmed pools, required-args descriptions) search around that point.";
      } else if (c.completed >= (c2.completed || 0) && c.completed >= (e.completed || 0)) {
        decision = "keep C as-is: neither the hardened point nor the catalog beat the permissive grouped tool on this model; its token edge is worth the first-call cost.";
      } else {
        decision = "no candidate decisively dominates — the gap between the top two is within repeat noise; collect more repeats before committing an interface.";
      }
    } else {
      decision = "incomplete reference set (need C, C2, and E together to decide the breadth strategy); the loop covers the missing points.";
    }
    text = `verdict: ${decision} [evidence: ${detail.join(", ")}]`;
  }
  if (!quiet)   process.stdout.write(`  → ${text}\n`);
  return text;
}

const quiet = process.argv.includes("--quiet");
const name = flag("--provider") ?? "active";
const ref = name === "active" ? "benchmark-results-full.json" : `benchmark-results-${name}.json`;
const dir = name === "active" ? "benchmark/optimize" : `benchmark/optimize-${name}`;
const batteryFile = name === "active" ? undefined : `benchmark-battery-${name}.json`;
const text = verdictFor(name, ref, dir, batteryFile, quiet);
if (quiet) process.stdout.write(`${name}: ${text ?? "no data yet; keep collecting"}\n`);
