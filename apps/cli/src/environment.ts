import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { release as osRelease } from "node:os";
import { join } from "node:path";
import { resolveShell, type ResolvedShell } from "./tools.js";

/**
 * What this machine actually is.
 *
 * The system prompt tells the model which shell syntax to use, which is a fact
 * about shells. It cannot tell the model which commands exist, because that is
 * a fact about *this* box, and no amount of model knowledge produces it: a
 * model trained on the world's Linux writes `ss`, `jq` and `lsof` with total
 * confidence, and the shell answers only by failing.
 *
 * The published error analysis of agent runs on terminal tasks puts the single
 * largest class of execution failure at exactly this — commands that do not
 * exist, 35.1% of all execution errors — and is careful about what it means.
 * It is *not* that the model does not know Linux. It knows precisely which
 * command it wants; that command is not installed here. The gap is between
 * knowing a language and knowing the state of one machine, and the second is
 * absent from every training set because it came into existence after the
 * weights were frozen.
 *
 * So the cheapest reliable fix is to hand it over. This module measures the
 * handful of commands a coding agent reaches for most often and reports which
 * are present, and nothing here is ever a guess: a tool is listed as available
 * because `command -v` said so on this machine, moments before the prompt that
 * says so is sent.
 */

/**
 * The commands worth asking about.
 *
 * A full inventory would be unbounded and mostly noise, and the model does not
 * need one — it knows what a C compiler is. What it does not know is whether
 * this box has the particular handful it is about to assume, and the ones
 * below are the ones that are routinely present in one image and absent in the
 * next. Kept short enough to read in the prompt and long enough to cover the
 * guesses that actually happen.
 */
export const PROBED_COMMANDS = [
  // Search and text. The three-way `grep`/`rg`/`ag` split is the single most
  // common wrong assumption: all three are canonical for the same job.
  "rg", "ag", "grep", "sed", "awk", "jq", "yq", "fd", "find", "tree", "xxd",
  // Networking. `ss` versus `netstat`, and `nc` in either spelling, is the
  // other one that costs a round trip every session.
  "ss", "netstat", "lsof", "nc", "ncat", "curl", "wget", "ping", "dig", "nslookup",
  // Runtimes and toolchains.
  "python3", "pip3", "node", "npm", "pnpm", "bun", "go", "rustc", "cargo", "java", "mvn", "gradle",
  // Build, archive, and the things a debugging session reaches for.
  "make", "cmake", "git", "tar", "zip", "unzip", "gzip", "ps", "top", "strace", "gdb", "docker",
] as const;

export type Environment = {
  /** `linux`, `darwin`, `win32` — from `process.platform`. */
  platform: NodeJS.Platform;
  /** The kernel or OS release, when it can be read without a spawn. */
  release?: string;
  /** The shell the `shell` tool will actually use. */
  shell: ResolvedShell;
  /** Probed commands that exist here. */
  present: readonly string[];
  /** Probed commands that do not, which is the half the model needs. */
  absent: readonly string[];
  /** How this project is tested, when that could be established rather than assumed. */
  testCommand?: string;
};

/**
 * One shell invocation that answers "which of these exist?".
 *
 * A spawn per command would cost a second of startup for a prompt, and a
 * login shell per name is worse. The loop is built per shell family because
 * the whole point of this module is not to assume a machine, and a probe that
 * assumed bash would be the exact bug it exists to fix.
 */
function probeCommands(shell: ResolvedShell, names: readonly string[]): Set<string> {
  const found = new Set<string>();
  const quoted = names.map((name) => `'${name}'`).join(",");
  const looped = names.join(" ");
  const script =
    shell.family === "powershell"
      ? `$ErrorActionPreference='SilentlyContinue'; foreach ($c in @(${quoted})) { if (Get-Command $c -ErrorAction SilentlyContinue) { $c } }`
      : shell.family === "cmd"
        // `where` takes one name at a time, and cmd has no loop that reads well
        // on a command line, so the chain is generated rather than idiomatic.
        ? names.map((name) => `where ${name} >nul 2>&1 && echo ${name}`).join(" & ")
        : `for c in ${looped}; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done`;

  try {
    const run = spawnSync(shell.command, [...shell.prefixArgs, script], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    // A failed probe is not a failed session: it means the inventory is
    // unknown, so it is reported as unknown rather than as "nothing is
    // installed", which would be a lie with the opposite sign.
    if (run.error || run.status !== 0) return found;
    for (const line of (run.stdout ?? "").split(/\r?\n/)) {
      const name = line.trim();
      if (names.includes(name as (typeof PROBED_COMMANDS)[number])) found.add(name);
    }
  } catch {
    // Same reasoning as above: an empty set is "we could not tell".
  }
  return found;
}

/**
 * How to run this project's tests, when the answer is a measurement.
 *
 * Reported only where the project actually declares it. `npm test` is stated
 * only when package.json has a `test` script, because printing the convention
 * for a project that has none is precisely the failure this codebase is trying
 * not to commit: an instruction that reads like a finding and is not one, sent
 * to an agent that will run it, fail, and have learned something false.
 */
function detectTestCommand(cwd: string): string | undefined {
  const has = (name: string): boolean => existsSync(join(cwd, name));

  const pkg = join(cwd, "package.json");
  if (has("package.json")) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
      const scripts = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts;
      if (scripts && typeof scripts.test === "string") return "npm test";
    } catch {
      // Unparseable package.json: no claim is made about it.
    }
  }
  if (has("Makefile") || has("makefile")) return "make test";
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test";
  if (has("pyproject.toml") || has("pytest.ini") || has("tox.ini")) return "pytest";
  return undefined;
}

/**
 * The OS release, as a string.
 *
 * From `os.release()`, not `process.release()`. They are different things and
 * the names invite the confusion: `process.release` is *Node's* own release
 * ({name: "node", lts, sourceUrl}), so reaching for it put a version number in
 * front of the model that read like the operating system's and was not. The
 * first attempt stringified it instead, printing the honest-looking
 * "win32 ([object Object])" — the same false fact in a worse disguise.
 *
 * Either way the lesson is the one this module exists to act on: a number in
 * the prompt has to have been measured, and "I know what this field is called"
 * is not a measurement. Both versions were caught by printing the block on a
 * real machine, which is the only way a fact like this shows up.
 */
function releaseString(): string | undefined {
  const release = osRelease();
  return typeof release === "string" && release.trim() ? release.trim() : undefined;
}

let cached: Environment | undefined;

/** The machine's facts, measured once per process. */
export function detectEnvironment(cwd: string = process.cwd()): Environment {
  if (cached) return cached;
  const shell = resolveShell();
  const found = probeCommands(shell, PROBED_COMMANDS);
  const present = PROBED_COMMANDS.filter((name) => found.has(name));
  const absent = PROBED_COMMANDS.filter((name) => !found.has(name));
  const testCommand = detectTestCommand(cwd);
  const release = releaseString();
  const measured: Environment = {
    platform: process.platform,
    ...(release ? { release } : {}),
    shell,
    present: [...present],
    absent: [...absent],
    ...(testCommand ? { testCommand } : {}),
  };
  cached = measured;
  return measured;
}

/** Drops the measurement. For tests, and for a host that changes machine. */
export function resetEnvironmentCache(): void {
  cached = undefined;
}

/**
 * The `<environment>` block for the system prompt.
 *
 * Empty when nothing could be measured, so a prompt for a machine that refused
 * every probe is byte-identical to the prompt it was before this existed. The
 * block is facts and nothing else: no advice, no encouragement, no
 * instruction. Advice here would compete with the prompt's own for the model's
 * attention, and the reason this works is that it is not advice — it is the
 * one thing the model could not have known, handed over.
 */
export function formatEnvironment(environment: Environment): string {
  const lines: string[] = [];
  const os = environment.release ? `${environment.platform} (${environment.release})` : environment.platform;
  lines.push(`operating system: ${os}`);
  lines.push(`shell: ${environment.shell.name}`);
  // `chainsWithAnd` is probed rather than assumed, and getting it wrong hands
  // the model a command that produces no output and a non-zero exit, which
  // reads to it as the tool being broken.
  lines.push(`chain commands with &&: ${environment.shell.chainsWithAnd ? "yes" : "no"}`);

  if (environment.present.length) lines.push(`installed: ${environment.present.join(", ")}`);
  if (environment.absent.length) {
    lines.push(`not installed: ${environment.absent.join(", ")}`);
    lines.push(
      "These are absent. Using one is a guaranteed failure, not a risk — check this list before naming a command.",
    );
  }
  if (environment.testCommand) {
    lines.push(`tests: ${environment.testCommand} (declared by this project)`);
  }
  return `\n\n<environment>\n\nMeasured on this machine, before this conversation started:\n\n${lines.join("\n")}\n</environment>`;
}
