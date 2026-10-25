// The model-porting fast path.
//
// A full sweep per model (one-shot reference + the whole optimization loop,
// ~480 turns) is not sustainable across models. What a new model actually
// needs to decide is the breadth question: which *kind* of interface — the
// six static candidates (A, B, C, C2, D, E) — wins on it. The knob search
// inside the grouped family is a follow-up, and only for the family that
// survives.
//
// So: pick the few tasks where the candidates historically diverge, and run
// only those. Selection is data-driven from a committed reference sweep —
// tasks where two candidates differ on completion are the discriminators;
// cost spread breaks ties and fills any remaining slot. Six candidates × 4
// battery tasks × 2 repeats = 48 turns, about one tenth of a full loop.
//
//   node --import tsx apps/cli/scripts/benchmark/battery.ts --provider sapiens
//   node --import tsx apps/cli/scripts/benchmark/battery.ts --provider X --dry-run
//
// Writes benchmark-battery-<provider>.json in the one-shot report shape, so
// verdict.ts can consume it directly. --dry-run prints the chosen battery
// without spending a turn.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProvider } from "../../src/config.js";
import { CANDIDATE_B, CANDIDATE_C, CANDIDATE_C2, CANDIDATE_D, CANDIDATE_E, captureCandidateA } from "./candidates.js";
import { runCandidateOnTask, type TaskResult } from "./runner.js";
import { probeGateway } from "./health.js";
import { TASKS } from "./tasks.js";
import { partitionResults } from "./verify-results.js";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const STATIC_CANDIDATES = (): (typeof CANDIDATE_B)[] => [
  captureCandidateA(process.cwd()),
  CANDIDATE_B,
  CANDIDATE_C,
  CANDIDATE_C2,
  CANDIDATE_D,
  CANDIDATE_E,
];

/**
 * Choose the battery tasks from a finished reference sweep.
 *
 * A task discriminates when some candidate completes it and another does not
 * — that is where the breadth decision is made. Tasks where everyone agrees
 * carry no decision value on completion and are used only to fill a slot, by
 * cost spread (where they separate candidates on the cost axis).
 */
export function selectBattery(results: TaskResult[], k = 4): string[] {
  const perTask = new Map<string, Map<string, boolean>>();
  for (const r of results) {
    const m = perTask.get(r.taskId) ?? new Map<string, boolean>();
    m.set(r.candidate, r.completed);
    perTask.set(r.taskId, m);
  }
  const usageByTask = new Map<string, number[]>();
  for (const r of results) usageByTask.set(r.taskId, [...(usageByTask.get(r.taskId) ?? []), r.usageTokens]);
  const spread = (task: string): number => {
    const us = usageByTask.get(task) ?? [];
    return us.length >= 2 ? Math.max(...us) - Math.min(...us) : 0;
  };
  const all = [...perTask.keys()];
  const split = all.filter((t) => {
    const flags = [...perTask.get(t)!.values()];
    return flags.some(Boolean) && !flags.every(Boolean);
  });
  const agreed = all.filter((t) => !split.includes(t));
  split.sort((a, b) => spread(b) - spread(a));
  agreed.sort((a, b) => spread(b) - spread(a));
  const chosen = [...split.slice(0, k)];
  for (const t of agreed) {
    if (chosen.length >= k) break;
    chosen.push(t);
  }
  return chosen;
}

// --- CLI ----------------------------------------------------------------------

const isMain = (): boolean => (process.argv[1] ?? "").replace(new RegExp("\\\\", "g"), "/").endsWith("battery.ts");

if (isMain()) {
const providerName = flag("--provider");
const dryRun = process.argv.includes("--dry-run");
const k = Number(flag("--tasks") ?? "4");
const pauseMs = Number(flag("--pause") ?? "4000");

if (!dryRun && !providerName) {
  console.error("usage: battery.ts --provider <name> [--tasks 4] [--pause 4000] [--dry-run]");
  process.exit(1);
}

const refFile = process.cwd() + "/benchmark-results-full.json";
if (!existsSync(refFile)) {
  console.error(`reference sweep not found: ${refFile}`);
  process.exit(1);
}
const ref = JSON.parse(readFileSync(refFile, "utf8")) as { results: TaskResult[] };
const battery = selectBattery(ref.results, k);

if (dryRun) {
  console.log(`battery (${k} slots, from the committed reference sweep):`);
  for (const id of battery) {
    const t = TASKS.find((x) => x.id === id);
    console.log(`  ${id.padEnd(22)} ${t ? t.capabilities.join(", ") : "?"}`);
  }
  const turns = STATIC_CANDIDATES().length * battery.length;
  console.log(`plan: ${STATIC_CANDIDATES().length} candidates x ${battery.length} slots = ${turns} turns (one comparable record per slot)`);
  process.exit(0);
}

const provider = resolveProvider({ ...loadConfig(), activeProvider: providerName });
const out = join(process.cwd(), `benchmark-battery-${providerName}.json`);
const candidates = STATIC_CANDIDATES();

// Resume: one comparable record per (candidate, task) slot. A slot whose
// record the verifier excluded (artifact / bad patch / harness error) is
// re-run; a filled slot is kept. 6 candidates x 4 slots = 24 turns.
let results: TaskResult[] = [];
if (existsSync(out)) {
  const prior = JSON.parse(readFileSync(out, "utf8")) as { results?: TaskResult[] };
  results = partitionResults(prior.results ?? []).comparable;
}
const key = (r: { candidate: string; taskId: string }): string => `${r.candidate}:${r.taskId}`;
const persist = (): void => {
  const metadata = {
    model: provider.model,
    provider: providerName,
    date: new Date().toISOString(),
    kind: "battery",
    battery: battery,
    note: "One comparable record per slot, selected from the committed reference sweep. Answers the breadth question; knob-level decisions need the full loop.",
  };
  writeFileSync(out, JSON.stringify({ metadata, results }, null, 2));
};

const waitForHealthy = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const check = await probeGateway({ providerName });
    if (check.health === "ok") return true;
    const waitMs = Math.min(120_000, 5_000 * 2 ** Math.min(attempt, 4));
    process.stderr.write(`… gateway ${check.health}; waiting ${Math.round(waitMs / 1000)}s${String.fromCharCode(92)}n`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  process.stderr.write("… gateway still unhealthy; stopping — re-run to resume.${String.fromCharCode(92)}n");
  return false;
};

for (const candidate of candidates) {
  for (const taskId of battery) {
    if (results.some((x) => key(x) === key({ candidate: candidate.id, taskId }))) {
      process.stderr.write(`… ${candidate.id} / ${taskId}: slot filled (resume)
`);
      continue;
    }
    const task = TASKS.find((t) => t.id === taskId);
    if (!task) {
      console.error(`battery task ${taskId} not found in the task set; skipping`);
      continue;
    }
    if (!(await waitForHealthy())) process.exit(0);
    process.stderr.write(`… ${candidate.id} / ${taskId}
`);
    const result = await runCandidateOnTask({ candidate, task, provider });
    results = [...results.filter((x) => key(x) !== key(result)), result];
    persist();
    await new Promise((r) => setTimeout(r, pauseMs));
  }
}
process.stderr.write(`
wrote ${out}
`);

}