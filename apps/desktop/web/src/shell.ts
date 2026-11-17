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
 *   3. it writes `{port,token}` to `.tmp/agent.json`, the one place the UI looks;
 *   4. it respawns the agent if it dies, because a crashed agent that never
 *      comes back is a window that is silently useless.
 *
 * Three environments, same UI:
 *
 *   - Packaged (`neu build --release`): the agent bundle is embedded in
 *     resources.neu, not on disk, and the user is not guaranteed to have Node.
 *     The first boot extracts `/resources/agent` into the app's data directory
 *     (Neutralino's resources API), and every boot spawns the *bundled* runtime
 *     — `runtime/node.exe` next to the shell exe, downloaded and SHA256-pinned
 *     at package time. A machine Node is used as fallback but never required.
 *   - Dev (`node scripts/run.mjs --window`): the launcher starts the agent and
 *     publishes its port as `/agent-port.json`; if that file is there the
 *     launcher owns the agent and this module must not spawn a second one.
 *   - Dev (`neu run`): spawn `node resources/agent/agent.mjs` through
 *     `os.spawnProcess` and read the port from the `spawnedProcess` events.
 *
 * In a plain browser (no Neutralino at all), `available()` is false and the UI
 * falls back to the dev default port — the agent must be started by hand.
 */

import type { NeutralinoApi, NeutralinoEvent, NeutralinoSpawnedProcess } from "./neutralino";

export const AGENT_INFO_PATH = ".tmp/agent.json";
const AGENT_BUNDLE = "resources/agent/agent.mjs";

function shell(): NeutralinoApi | undefined {
  return typeof window !== "undefined" ? window.Neutralino : undefined;
}

/**
 * Is this UI running inside the Neutralino shell?
 *
 * True when the NativeAPI is present. `NL_PATH` may not be set in some dev
 * modes, so we don't require it here — discovery figures out the right path
 * per mode.
 */
export function available(): boolean {
  return Boolean(shell()?.os);
}

/**
 * The command that starts the agent in dev-neu mode, relative to the app dir.
 *
 * `node` is the command-name form on purpose: `commandAllowList` matches the
 * program name, and a quoted absolute path with spaces in it is a quoting
 * problem on Windows for no benefit.
 */
export function agentCommand(): string {
  return `node ${AGENT_BUNDLE}`;
}

/**
 * Where the packaged agent lives on disk (inside the data dir) after the
 * first-boot extraction, and where the bundled runtime sits beside the exe.
 *
 * In the packaged app `NL_PATH` is the exe's directory, so `runtime/node.exe`
 * resolves to the file package.mjs staged. The agent bundle itself cannot run
 * from inside resources.neu, so it is extracted to `os.getPath('data')/agent`.
 */
async function packagedAgentPaths(api: NeutralinoApi): Promise<{ bundle: string; nodeExe: string } | undefined> {
  const base = typeof window !== "undefined" ? window.NL_PATH : undefined;
  if (!base || !api.os?.getPath) return undefined;
  // The bundled runtime is the packaged marker: dev mode has no runtime/ dir.
  const runtimeExe = `${base}/runtime/node.exe`;
  let dataDir: string;
  try {
    dataDir = await api.os.getPath("data");
  } catch {
    return undefined;
  }
  const agentDir = `${dataDir}/actor0/agent`;
  return { bundle: `${agentDir}/agent.mjs`, nodeExe: runtimeExe };
}

/**
 * Extract the agent bundle from resources.neu into the data directory.
 *
 * Idempotent: if the bundle already exists there (any prior boot, or the same
 * version re-run), the extraction is skipped — `extractDirectory` on a large
 * directory is not free, and there is nothing to gain from repeating it.
 */
export async function ensurePackagedAgent(api: NeutralinoApi, paths: { bundle: string }): Promise<void> {
  const fsApi = api.filesystem;
  if (!fsApi) return;
  const agentDir = paths.bundle.slice(0, paths.bundle.lastIndexOf("/"));
  try {
    await fsApi.readFile(paths.bundle);
    return; // already extracted by a previous boot
  } catch {
    // not there yet: first boot (or a data-dir wipe / half-finished extraction)
  }
  await fsApi.createDirectory(agentDir).catch(() => undefined);
  // Positional arguments: `resources.extractDirectory(path, destination)`.
  // An object form fails with NE_RT_NATRTER ("Required parameter is missing:
  // destination") and — if the caller swallows that, as an earlier version
  // did — leaves an empty directory that reads as a successful extraction and
  // a spawn that then cannot find the bundle. So the error is not swallowed,
  // and the result is verified by reading the file back.
  if (!api.resources?.extractDirectory) {
    throw new Error("the shell has no resources API to extract the bundled agent with");
  }
  await api.resources.extractDirectory("/resources/agent", agentDir);
  await fsApi.readFile(paths.bundle);
}

/**
 * Spawn the agent process.
 *
 * Split out from `startAgent` to keep one place owning the spawn command's
 * shape (bare program name for the allow-list, cwd, no envs — see the note
 * in the function body).
 */
async function spawnAgentOnce(
  api: NeutralinoApi,
  command: string,
  spawnCwd: string,
): Promise<NeutralinoSpawnedProcess> {
  // No `envs`, ever: in the packaged window mode a spawn with env vars fails
  // silently (pid 0, no process) — everything the agent needs arrives as argv.
  return api.os!.spawnProcess(command, {
    cwd: spawnCwd,
  });
}

/**
 * Start the agent and return its port.
 *
 * Resolves once the port is known; rejects if the shell can't start the agent.
 * The command runs with the shell's `commandAllowList`, which is the boundary
 * between "this app may run node" and "this app may run anything".
 */
export async function startAgent(options: { cwd?: string; token?: string; timeoutMs?: number } = {}): Promise<number> {
  const api = shell();
  if (!api?.os || !api.events) {
    throw new Error("no Neutralino shell to start the agent through");
  }

  const base = (typeof window !== "undefined" ? window.NL_PATH : ".") ?? ".";
  const timeoutMs = options.timeoutMs ?? 15_000;

  // --- decide what to run --------------------------------------------------

  const packaged = await packagedAgentPaths(api);
  let command: string;
  let spawnCwd = base;
  if (packaged) {
    await ensurePackagedAgent(api, packaged);
    // The bundled runtime: the whole point of the package. A machine node is
    // the fallback for a stripped-down install, never the requirement.
    //
    // The command names the program by bare basename (`node.exe`) and sets the
    // working directory to the runtime's own folder, because
    // `commandAllowList` matches argv[0] as a *name*: a quoted absolute path
    // like "D:/.../runtime/node.exe" matches nothing and the spawn is refused
    // with NE_OS_CMDNALW. The bundle path stays absolute (it is an argument,
    // not the program).
    const runtimeDir = packaged.nodeExe.slice(0, packaged.nodeExe.lastIndexOf("/"));
    command = `${packaged.nodeExe.split("/").pop()} "${packaged.bundle}"`;
    spawnCwd = runtimeDir;
  } else {
    command = agentCommand();
  }

  // --- spawn and read the port from stdout ---------------------------------

  let port: number | undefined;
  const seen: string[] = [];

  // Listen for stdout from every spawned process; the agent's first line is
  // `{"actor0":"listening","port":NNNNN}`. `seen` keeps every line that
  // arrived, so a timeout can say what the child actually printed rather than
  // just that nothing happened.
  await api.events.on("spawnedProcess", (event: NeutralinoEvent) => {
    if (event.detail.data) seen.push(`${event.detail.action}:${event.detail.data.slice(0, 80)}`);
    if (event.detail.action === "stdOut" && event.detail.data) {
      const match = /"port"\s*:\s*(\d+)/.exec(event.detail.data);
      if (match) port = Number(match[1]);
    }
  });

  // The handshake configuration goes on the command line, not in env vars:
  // the packaged app spawns through Neutralino's `os.spawnProcess`, which
  // silently fails (pid 0, no process) whenever `envs` is passed — measured
  // live in the packaged window. The agent reads --token/--port-file as argv
  // and env as equal alternates (see agent/src/index.ts).
  //
  // The port file is the reliable half of the handshake: in the packaged
  // window mode the `spawnedProcess` stdout events do not reach the page
  // either, so the page polls the file and the stdout listener is the fast
  // path for wherever it does work (dev).
  const portFile = packaged ? `${packaged.bundle.slice(0, packaged.bundle.lastIndexOf("/"))}/port.json` : undefined;
  // The shell's own coordinates, so the agent can reach the Neutralino native
  // API: NL_* are *page globals* in the webview, never process env vars, so a
  // spawned agent never inherits them — and without them the agent's file
  // bridge silently falls back to direct node:fs and the shell's filesystem
  // scopes (the security boundary neutralino.config.json declares) are
  // enforced on nothing. Passed as argv like the rest of the handshake
  // (spawnProcess cannot carry envs in the packaged window mode).
  const w = (typeof window !== "undefined" ? window : {}) as { NL_PATH?: string; NL_PORT?: string; NL_TOKEN?: string };
  const argString = [
    ...(options.token ? ["--token", options.token] : []),
    ...(portFile ? ["--port-file", portFile] : []),
    ...(w.NL_PATH ? ["--nl-path", w.NL_PATH] : []),
    ...(w.NL_PORT ? ["--nl-port", w.NL_PORT] : []),
    ...(w.NL_TOKEN ? ["--nl-token", w.NL_TOKEN] : []),
  ];
  const fullCommand =
    argString.length > 0
      ? `${command} ${argString.map((a) => (String(a).includes("/") ? `"${a}"` : String(a))).join(" ")}`
      : command;

  let process: NeutralinoSpawnedProcess | undefined;
  try {
    process = await spawnAgentOnce(api, fullCommand, spawnCwd);
  } catch (error) {
    // A shell that cannot spawn the agent is a real failure the user has to see,
    // not something to swallow into a silent "connecting…" forever.
    throw new Error(`could not start the agent: ${(error as Error).message}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (port === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The port file is the reliable handshake — but only when it was written
    // by *this* spawn. A previous launch's agent (or a previous boot's child,
    // dying while this one starts) can leave a file whose pid is not ours,
    // and accepting it hands the UI a dead port it retries forever — exactly
    // the "retrying… at ws://…(stale port)" a relaunch could show.
    if (port === undefined && portFile && api.filesystem) {
      try {
        const raw = await api.filesystem.readFile(portFile);
        const info = JSON.parse(raw) as { port?: number; pid?: number };
        if (typeof info.port === "number" && info.port > 0 && info.pid === process.pid) {
          port = info.port;
        }
      } catch {
        /* not written yet — this poll's job is to be cheap and quiet */
      }
    }
  }

  // Note: no respawn-with-retry here any more. The port file made the first
  // spawn sufficient (the child is alive and will write the file even if the
  // event transport is dead); a second spawn would only race the first agent
  // for the port. The retry this block used to do is what the port-file poll
  // above replaced.

  if (port === undefined) {
    throw new Error(`the agent did not report a port in time (command: ${command}; stdout seen: ${seen.join(" | ") || "none"})`);
  }

  // Record the port where `discoverAgentUrl` can read it back on reconnect. The
  // token is deliberately NOT persisted to disk (D-2): it is kept in
  // sessionStorage for this tab instead, so a local process that can read the
  // app directory cannot recover it.
  if (api.filesystem) {
    await api.filesystem.createDirectory(`${base}/.tmp`).catch(() => undefined);
    await api.filesystem
      .writeFile(
        `${base}/${AGENT_INFO_PATH}`,
        JSON.stringify({ port, pid: process.pid }),
      )
      .catch(() => undefined);
  }
  if (options.token && typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem("actor0.agentToken", options.token);
    } catch {
      /* sessionStorage may be unavailable; the in-memory discoveredToken covers this boot */
    }
  }

  return port;
}

/**
 * A random token for the agent's localhost socket.
 *
 * The socket exposes config.get (provider credentials) and turn.send (the whole
 * tool set). Without a token the server disables auth entirely, so this is the
 * one control that keeps a random local process from reading the config or
 * driving the tools. 32 random bytes, hex-encoded, from the Web Crypto the
 * webview already has.
 */
export function generateAgentToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
