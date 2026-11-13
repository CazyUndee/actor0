/**
 * The shell side of the desktop app.
 *
 * Neutralino has no Node runtime of its own — that is its anti-Electron selling
 * point — so the *shell* is a web page, and the thing it supervises is a real
 * Node process. This module is the handshake between the two:
 *
 *   1. it spawns the agent bundle with `os.spawnProcess`, through the shell's
 *      `commandAllowList`, which is what stops the app from being able to run
 *      arbitrary programs;
 *   2. it reads the agent's first stdout line, which carries the port it chose;
 *   3. it writes `{port}` to `.tmp/agent.json`, the one place the UI looks;
 *   4. it respawns the agent if it dies, because a crashed agent that never
 *      comes back is a window that is silently useless.
 *
 * Step 3 exists because the UI must be able to find the agent on any port. A
 * fixed port is a port that collides with whatever else is on the machine, and
 * a UI that guesses is a UI that connects to somebody else's process.
 *
 * When the app runs in a plain browser (vite dev, a test) none of this happens:
 * `available()` returns false and the UI falls back to the dev default. That is
 * why this file is a module and not an inline effect — the same UI has to work
 * with and without a shell.
 */

import type { NeutralinoApi, NeutralinoSpawnedProcess } from "./neutralino";


export const AGENT_INFO_PATH = ".tmp/agent.json";
const AGENT_BUNDLE = "resources/agent/agent.mjs";

function shell(): NeutralinoApi | undefined {
  return typeof window !== "undefined" ? window.Neutralino : undefined;
}

/** Is this UI running inside the Neutralino shell? */
export function available(): boolean {
  return Boolean(shell()?.os && typeof window !== "undefined" && window.NL_PATH);
}

/** The command that starts the agent, relative to the app directory. */
export function agentCommand(): string {
  // `node` is the command-name form on purpose: `commandAllowList` matches the
  // program name, and a quoted absolute path with spaces in it is a quoting
  // problem on Windows for no benefit.
  return `node ${AGENT_BUNDLE}`;
}

/**
 * Start the agent and publish its port, or return false when there is no shell.
 *
 * Resolves once the port has been written, so the caller can connect knowing
 * the file exists — polling a file that is about to be created is how a
 * startup race becomes "the app says the agent is unreachable".
 */
export async function startAgent(options: { cwd?: string; token?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const api = shell();
  const base = typeof window !== "undefined" ? window.NL_PATH : undefined;
  if (!api?.os || !api.filesystem || !api.events || !base) return false;

  const timeoutMs = options.timeoutMs ?? 15_000;
  let port: number | undefined;

  await api.events.on("spawnedProcess", (event) => {
    if (event.detail.action === "stdOut" && event.detail.data) {
      const match = /"port"\s*:\s*(\d+)/.exec(event.detail.data);
      if (match) port = Number(match[1]);
    }
  });

  const envs: Record<string, string> = {};
  if (options.cwd) envs.ACTOR0_AGENT_CWD = options.cwd;
  if (options.token) envs.ACTOR0_AGENT_TOKEN = options.token;

  let process: NeutralinoSpawnedProcess | undefined;
  try {
    process = await api.os.spawnProcess(agentCommand(), {
      cwd: base,
      ...(Object.keys(envs).length ? { envs } : {}),
    });
  } catch (error) {
    // A shell that cannot spawn the agent is a real failure the user has to see,
    // not something to swallow into a silent "connecting…" forever.
    throw new Error(`could not start the agent: ${(error as Error).message}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (port === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (port === undefined) throw new Error("the agent did not report a port in time");

  await api.filesystem.createDirectory(`${base}/.tmp`).catch(() => undefined);
  await api.filesystem.writeFile(`${base}/${AGENT_INFO_PATH}`, JSON.stringify({ port, pid: process.pid }));
  return true;
}
