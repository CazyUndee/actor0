import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ToolDefinition } from "@actor0/harness";
import { MAX_OUTPUT_BYTES, MAX_TIMEOUT_SECONDS, optionalBoolean, optionalNumber, optionalText, requireString, withNotice } from "./shared.js";
import { within } from "./within.js";
import type { ToolContext } from "./context.js";

/**
 * The shell tool, and the native-shell resolver behind it.
 *
 * "Native shell" is the whole point of this module: the command runs through
 * the shell this machine actually has — PowerShell on Windows, `sh`/`bash` on
 * POSIX — rather than through a fixed one. A prompt that says "bash" on a
 * machine with only PowerShell is a prompt that lies, and the model then writes
 * `&&` chains that a `cmd.exe` cannot run.
 *
 * There is deliberately **no default timeout**. A 120-second default once
 * killed real installs and long test runs mid-flight; the ceiling exists only
 * so a runaway cannot hang forever, and it is an hour because a real build can
 * take one. A caller that wants a bound passes `timeout`.
 */

export type ShellFamily = "posix" | "powershell" | "cmd";

export type ResolvedShell = {
  family: ShellFamily;
  /** The command run for `shell`, with the user's command appended. */
  command: string;
  /** Fixed leading arguments, before the user's command. */
  prefixArgs: string[];
  /** What this shell is, in one clause, for the prompt and the transcript. */
  label: string;
};

const PROBE = "echo actor0-probe";

/** A cached resolution; the probe spawns a process, so it runs once. */
let cached: ResolvedShell | undefined;

function probe(shell: ResolvedShell): boolean {
  try {
    const result = spawnSync(shell.command, [...shell.prefixArgs, PROBE], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return result.status === 0 && (result.stdout ?? "").includes("actor0-probe");
  } catch {
    return false;
  }
}

/**
 * The candidates, in preference order, for the machine's own shell.
 *
 * PowerShell first on Windows because it is the one that is actually there and
 * understands the scripting the model writes; `pwsh` (the cross-platform 7+)
 * is preferred over `powershell` (Windows PowerShell 5.1) when both exist, but
 * both are accepted since either is a working native shell.
 */
function candidates(): ResolvedShell[] {
  if (process.platform === "win32") {
    return [
      { family: "powershell", command: "pwsh", prefixArgs: ["-NoProfile", "-Command"], label: "PowerShell 7+" },
      { family: "powershell", command: "powershell", prefixArgs: ["-NoProfile", "-Command"], label: "Windows PowerShell" },
      { family: "cmd", command: "cmd", prefixArgs: ["/d", "/s", "/c"], label: "cmd.exe" },
    ];
  }
  return [
    { family: "posix", command: "bash", prefixArgs: ["-c"], label: "bash" },
    { family: "posix", command: "sh", prefixArgs: ["-c"], label: "sh" },
  ];
}

/** The shell to run commands with, probed once and remembered. */
export function resolveShell(): ResolvedShell {
  if (cached) return cached;
  for (const candidate of candidates()) {
    if (probe(candidate)) {
      cached = candidate;
      return candidate;
    }
  }
  // Nothing probed: fall back to the platform's own first choice and let the
  // command's failure carry the reason, rather than refusing to run at all.
  cached = candidates()[0]!;
  return cached;
}

/** Override the cached shell (tests, and a host that measures it elsewhere). */
export function setCachedShell(shell: ResolvedShell): void {
  cached = shell;
}

/** What this shell implies, for the system prompt. */
export function shellNotes(shell: ResolvedShell): string {
  switch (shell.family) {
    case "powershell":
      return [
        `Commands run in ${shell.label}. Use PowerShell syntax: \`$env:NAME\` for`,
        "environment variables, `Get-ChildItem`/`Select-String` when you want them,",
        "and `;` rather than `&&` to sequence. `&&` is supported from PowerShell 7 only.",
      ].join(" ");
    case "cmd":
      return [
        "Commands run in cmd.exe. Use `%NAME%` for environment variables and `&` to",
        "sequence commands; there is no `$(...)` substitution.",
      ].join(" ");
    default:
      return "Commands run in a POSIX shell. `$NAME`, `&&`, pipes and `$(...)` all work as written.";
  }
}

/** How long a command may run when the caller names no limit. */
export const SHELL_DEFAULT_TIMEOUT_MS = 0;
export const SHELL_MAX_TIMEOUT_MS = MAX_TIMEOUT_SECONDS * 1_000;

export const shellDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "shell",
    description:
      "Run a shell command and return its combined output and exit code. Use it for build and test runners, package managers, git, and system commands — not for reading, searching or editing files, which have their own tools. No default timeout: pass `timeout` (seconds) to bound it. Command output is capped; the tail is kept because errors come last.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        cwd: { type: "string", description: "Directory to run in. Defaults to the working directory." },
        timeout: { type: "number", description: "Seconds before the command is killed. 0 or omitted means no limit." },
        background: { type: "boolean", description: "Start the command detached and return its pid immediately." },
      },
      required: ["command"],
    },
  },
};

/** Kill a process and everything it started — a build spawns children. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    // A negative pid signals the whole process group, which is why the child is
    // spawned detached below; without that, a killed `npm test` leaves its
    // runner running.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runShell(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = requireString(args, "command");
  const cwdArg = optionalText(args, "cwd")?.trim();
  const cwd = cwdArg ? await within(ctx.cwd, cwdArg, false) : ctx.cwd;
  const timeoutSeconds = Math.max(0, optionalNumber(args, "timeout") ?? 0);
  const timeoutMs = Math.min(timeoutSeconds * 1_000, SHELL_MAX_TIMEOUT_MS);
  const background = optionalBoolean(args, "background") ?? false;
  const shell = resolveShell();

  const child = spawn(shell.command, [...shell.prefixArgs, command], {
    cwd,
    env: { ...process.env, ACTOR0: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  if (background) {
    child.unref();
    return `[started in the background: ${shell.label} pid ${child.pid ?? "unknown"}]`;
  }

  let output = "";
  let truncatedHead = false;
  const append = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (output.length > MAX_OUTPUT_BYTES) {
      // Keep the tail: a failure's cause is at the end of its output, which is
      // the opposite of every other cap in this app and is why it is called out.
      output = output.slice(output.length - MAX_OUTPUT_BYTES);
      truncatedHead = true;
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : undefined;

  const onAbort = (): void => killTree(child);
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });

  if (timer) clearTimeout(timer);
  ctx.signal.removeEventListener("abort", onAbort);

  const body = output.replace(/\r\n/g, "\n").trimEnd();
  const notes: string[] = [];
  if (truncatedHead) notes.push(`[earlier output dropped; showing the last ${MAX_OUTPUT_BYTES.toLocaleString()} characters, where errors land.]`);
  const code = exit.code === null ? "unknown" : String(exit.code);
  notes.push(`Command exited with code ${code}${timedOut ? ` (killed after ${timeoutSeconds}s)` : ""}.`);
  return withNotice(body || "(no output)", notes.join("\n"));
}

/** Did this shell result end in a non-zero exit? */
export function exitedNonZero(output: string): boolean {
  const match = /\n\nCommand exited with code (\d+|unknown)$/.exec(output.trimEnd());
  if (!match) return false;
  return match[1] !== "0";
}
