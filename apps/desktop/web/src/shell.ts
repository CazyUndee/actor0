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
 * Two environments, same UI:
 *
 *   - Packaged app (`neu build` + run): Neutralino writes `auth_info.json`
 *     with port + token in `NL_PATH/.tmp/`, and the UI reads it through the
 *     native filesystem API.
 *   - Dev mode (`neu run --neu-dev-extension`): `NL_PATH` is not set, but
 *     `window.Neutralino.os` is available, so the UI spawns `node
 *     resources/agent/agent.mjs` itself and reads the port off its stdout
 *     stream via `spawnedProcess` events.
 *
 * The same UI works in both; only the discovery changes. In a plain browser
 * (no Neutralino at all), `available()` is false and the UI falls back to the
 * dev default port — the agent must be started by hand.
 */

import type { NeutralinoApi, NeutralinoEvent, NeutralinoSpawnedProcess } from "./neutralino";


export const AGENT_INFO_PATH = ".tmp/agent.json";
const AGENT_BUNDLE = "resources/agent/agent.mjs";
const DEV_AGENT_PORT = 3000;

function shell(): NeutralinoApi | undefined {
  return typeof window !== "undefined" ? window.Neutralino : undefined;
}

/**
 * Is this UI running inside the Neutralino shell?
 *
 * True when the NativeAPI is present. `NL_PATH` may not be set in dev mode,
 * so we don't require it here — discovery figures out the right path per mode.
 */
export function available(): boolean {
  return Boolean(shell()?.os);
}

/** The command that starts the agent, relative to the app directory. */
export function agentCommand(): string {
  // `node` is the command-name form on purpose: `commandAllowList` matches the
  // program name, and a quoted absolute path with spaces in it is a quoting
  // problem on Windows for no benefit.
  return `node ${AGENT_BUNDLE}`;
}

/**
 * Start the agent and return its port, or return undefined when there is no
 * shell to supervise it.
 *
 * Two paths:
 *
 *   Packaged: read `auth_info.json` (port + token) that Neutralino exported
 *   to `NL_PATH/.tmp/`.
 *
 *   Dev mode: `os.spawnProcess("node resources/agent/agent.mjs")` and read the
 *   `{"actor0":"listening","port":NNNNN}` line from the agent's stdout via the
 *   `spawnedProcess` event stream.
 *
 * Resolves once the port is known; rejects if the shell can't start the agent.
 */
export async function startAgent(options: { cwd?: string; token?: string; timeoutMs?: number } = {}): Promise<number> {
  const api = shell();
  if (!api?.os || !api.events) {
    throw new Error("no Neutralino shell to start the agent through");
  }

  const base = typeof window !== "undefined" ? window.NL_PATH : ".";
  const timeoutMs = options.timeoutMs ?? 15_000;

  // --- dev mode: spawn the agent and read its port from stdout -------------

  let port: number | undefined;

  // Listen for stdout from every spawned process; the agent's first line is
  // `{"actor0":"listening","port":NNNNN}`.
  await api.events.on("spawnedProcess", (event: NeutralinoEvent) => {
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

  // Record it where `discoverAgentUrl` can read it back on reconnect.
  if (api.filesystem) {
    await api.filesystem.createDirectory(`${base}/.tmp`).catch(() => undefined);
    await api.filesystem.writeFile(`${base}/${AGENT_INFO_PATH}`, JSON.stringify({ port, pid: process.pid })).catch(() => undefined);
  }

  return port;
}

/**
 * Find the agent's endpoint.
 *
 * The shell writes `{port, token}` when it starts the agent, and the UI reads
 * it through the native API. A missing file is not an error — it means the UI
 * is not running under the shell (a browser, a test), and the dev default is
 * the honest answer there.
 */
/**
 * Find the agent's endpoint.
 *
 * Three sources, in the order they become known:
 *
 *   1. the port `boot()` captured off the agent's own stdout when it started
 *      it — the freshest fact, set by `setDiscoveredPort`;
 *   2. the file a previous launch wrote, when the agent outlived the UI;
 *   3. the dev default, when there is no shell at all and the agent is expected
 *      to have been started by hand.
 *
 * A wrong-but-available answer (guessing 3000 while a live agent sits on an
 * OS-assigned port) is worse than an honest failure, which is why the first
 * source exists.
 */
let discoveredPort: number | undefined;

/** Remember the port the agent reported at startup. */
export function setDiscoveredPort(port: number): void {
  discoveredPort = port;
}

export async function discoverAgentUrl(): Promise<{ url: string; token?: string }> {
  if (discoveredPort !== undefined) {
    return { url: `ws://127.0.0.1:${discoveredPort}` };
  }
  const Neutralino = typeof window !== "undefined" ? window.Neutralino : undefined;
  const base = typeof window !== "undefined" ? window.NL_PATH : undefined;
  if (Neutralino?.filesystem && base) {
    try {
      const raw = await Neutralino.filesystem.readFile(`${base}/${AGENT_INFO_PATH}`);
      const info = JSON.parse(raw) as { port?: number; token?: string };
      if (typeof info.port === "number" && info.port > 0) {
        return { url: `ws://127.0.0.1:${info.port}`, ...(info.token ? { token: info.token } : {}) };
      }
    } catch {
      // No record: fall through to the dev default.
    }
  }
  const envPort = typeof import.meta !== "undefined" ? import.meta.env?.VITE_AGENT_PORT : undefined;
  const port = envPort ? Number(envPort) : DEV_AGENT_PORT;
  return { url: `ws://127.0.0.1:${port}` };
}
