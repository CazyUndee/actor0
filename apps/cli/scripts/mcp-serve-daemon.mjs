/**
 * Run the Actor0 MCP service — the "ChatGPT plugin" — as a background service.
 *
 * One script manages the two things that keep the harness reachable:
 *
 * 1. The local bridge: spawns `mcp-serve.ts` with its stdin held open for the
 *    daemon's whole life and forwards JSON lines between it and a localhost
 *    TCP socket. This is for local inspection and testing — talk to it with
 *    any MCP client over TCP.
 * 2. The OpenAI Secure MCP Tunnel: spawns `tunnel-client run --profile actor0`
 *    so ChatGPT's connector (chatgpt.com → Plugins → actor0) can reach the
 *    same tools through OpenAI's control plane. The tunnel profile's own
 *    mcp.command spawns the MCP server for ChatGPT — this script only keeps
 *    the daemon alive.
 *
 *   node apps/cli/scripts/mcp-serve-daemon.mjs [start|status|stop] [--port N]
 *
 *   start   launch both if not already up (idempotent; the default when no
 *           command is given). The tunnel half needs CONTROL_PLANE_API_KEY in
 *           the environment; without it the bridge still comes up and start
 *           reports the missing key (exit 2).
 *   status  report the bridge and the tunnel daemon
 *   stop    shut both down
 *
 * `daemon` and `tunnel` are hidden modes the spawned children run so they
 * execute in-process and never re-spawn themselves. They are not user
 * commands.
 *
 * State lives outside the checkout: pid files and logs under $HOME
 * (.mcp-serve-daemon-<port>.pid, .mcp-serve-tunnel.pid, .mcp-serve-tunnel.log).
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { existsSync, writeFileSync, readFileSync, rmSync, appendFileSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const args = process.argv.slice(2);
const command = args.includes("daemon") || args.includes("tunnel")
  ? (args.includes("tunnel") ? "tunnel" : "daemon")
  : (["start", "status", "stop"].find((a) => args.includes(a)) ?? "start");
const portFlag = args.indexOf("--port");
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : Number(process.env.MCP_SERVE_PORT ?? 47501);

// This script is at apps/cli/scripts/, so the repo root is three levels up.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(join(scriptDir, "..", "..", ".."));
const tsx = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
// Drive the file tools are confined to: the *projects* folder that holds the
// repo (not the whole drive), matching the tunnel's `repo-projects` sentinel.
// Confining to <drive>/projects keeps every project reachable while making
// rg/glob scans seconds instead of minutes (a whole-drive scan is the killer).
const projectsRoot = process.platform === "win32"
  ? repo.slice(0, 2) + "/projects/"
  : "/projects/";

// --- shared state ----------------------------------------------------------
const stateBase = join(homedir(), `.mcp-serve-daemon-${port}`);
const pidFile = `${stateBase}.pid`;
const logFile = `${stateBase}.log`;
const note = (message) => appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);

// Tunnel daemon state (independent of the bridge port; one tunnel profile).
const tunnelExe = join(homedir(), ".cache", "tunnel-client", "tunnel-client.exe");
const tunnelProfile = process.env.MCP_TUNNEL_PROFILE ?? "actor0";
const tunnelPidFile = join(homedir(), ".mcp-serve-tunnel.pid");
const tunnelLogFile = join(homedir(), ".mcp-serve-tunnel.log");
const tunnelHealthPort = 8080; // health.listen_addr in AppData\\Roaming\\tunnel-client\\actor0.yaml

/** Is a process with this pid alive on this platform? */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists but not ours to signal
  }
}

/**
 * The tunnel's runtime key. Read from the user-registered environment as a
 * fallback, because a Startup-folder batch file may run with a stale or empty
 * process env: `setx`-ed user vars do not always materialize in the logon
 * session that launches startup programs. On Windows the persistent value is
 * in the registry; elsewhere the caller's env is authoritative.
 */
function controlPlaneKey() {
  if (process.env.CONTROL_PLANE_API_KEY) return process.env.CONTROL_PLANE_API_KEY;
  if (process.platform !== "win32") return undefined;
  try {
    const output = spawnSync(
      "reg",
      ["query", "HKCU\\Environment", "/v", "CONTROL_PLANE_API_KEY"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = output.stdout.match(/CONTROL_PLANE_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(.+)\s*$/m);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Does anything accept TCP connections on this port? */
function portIsListening(port, ms = 3000) {
  return new Promise((resolvePromise) => {
    const socket = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => { socket.destroy(); resolvePromise(false); }, ms);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolvePromise(true); });
    socket.once("error", () => { clearTimeout(timer); resolvePromise(false); });
  });
}

/** Ask the bridge for an MCP handshake; true only if a JSON-RPC answer comes back. */
function bridgeHandshakes(port) {
  return new Promise((resolvePromise) => {
    const socket = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => { socket.destroy(); resolvePromise(false); }, 5000);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let index;
      while ((index = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, index).trim();
        buf = buf.slice(index + 1);
        if (line) {
          socket.destroy();
          clearTimeout(timer);
          try { resolvePromise(JSON.parse(line).id !== undefined); } catch { resolvePromise(false); }
          return;
        }
      }
    });
    socket.on("error", () => { clearTimeout(timer); resolvePromise(false); });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  });
}

/** Is the tunnel daemon answering its health endpoint? */
async function tunnelIsUp() {
  try {
    const response = await fetch(`http://127.0.0.1:${tunnelHealthPort}/readyz`, { signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

// --- the bridge (local inspection) -----------------------------------------

/** The bridge itself: spawn the server, hold its stdin open, serve it over TCP. */
function runDaemon() {
  const server = spawn(process.execPath, [tsx, "apps/cli/scripts/mcp-serve.ts", "--tools", "read,write,edit,glob,shell,rg", "--cwd", projectsRoot], {
    cwd: repo,
    stdio: ["pipe", "pipe", "inherit"],
  });
  writeFileSync(pidFile, `${process.pid}\n`);
  note(`daemon pid ${process.pid}, server pid ${server.pid}, port ${port}`);

  server.on("exit", (code) => { note(`server exited code=${code}; shutting the bridge down`); process.exit(code ?? 0); });
  server.on("error", (error) => { note(`server error ${error.message}`); });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      // Take the whole spawned tree down on Windows; a plain kill would orphan
      // the tsx node process behind it.
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else server.kill("SIGKILL");
      process.exit(0);
    });
  }

  const clients = new Set();
  let outBuf = "";
  server.stdout.on("data", (chunk) => {
    outBuf += chunk.toString("utf8");
    let index;
    while ((index = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, index + 1);
      outBuf = outBuf.slice(index + 1);
      for (const client of clients) client.write(line);
    }
  });

  const bridge = net.createServer((socket) => {
    clients.add(socket);
    note(`client connected (${clients.size} total)`);
    let inBuf = "";
    socket.on("data", (chunk) => {
      inBuf += chunk.toString("utf8");
      let index;
      while ((index = inBuf.indexOf("\n")) !== -1) {
        const line = inBuf.slice(0, index).trim();
        inBuf = inBuf.slice(index + 1);
        if (line) server.stdin.write(`${line}\n`);
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  bridge.listen(port, "127.0.0.1", () => note(`listening on 127.0.0.1:${port}`));
  bridge.on("error", (error) => { note(`bridge error ${error.message}`); process.exit(1); });
}

// --- the tunnel (ChatGPT) ---------------------------------------------------

/** Start the tunnel daemon detached; true if it is answering health after 20s. */
async function startTunnel() {
  if (await tunnelIsUp()) {
    console.log(`tunnel already up: 127.0.0.1:${tunnelHealthPort}/readyz answers (pid ${existsSync(tunnelPidFile) ? readFileSync(tunnelPidFile, "utf8").trim() : "?"})`);
    return true;
  }
  const recorded = existsSync(tunnelPidFile) ? Number(readFileSync(tunnelPidFile, "utf8").trim()) : NaN;
  if (alive(recorded)) {
    console.log(`a tunnel daemon claims this machine (pid ${recorded}) but ${tunnelHealthPort} is not answering. Investigate before restarting: ${tunnelLogFile}`);
    process.exitCode = Math.max(process.exitCode ?? 0, 1);
    return false;
  }
  const key = controlPlaneKey();
  if (!key) {
    console.log(`tunnel skipped: CONTROL_PLANE_API_KEY is not set in this shell or the user environment. Set it persistently with: setx CONTROL_PLANE_API_KEY "sk-…" (the key is at platform.openai.com → API keys, the runtime key for this tunnel), then re-run start.`);
    process.exitCode = Math.max(process.exitCode ?? 0, 2);
    return false;
  }
  rmSync(tunnelPidFile, { force: true });
  const logStream = openSync(tunnelLogFile, "a");
  const tunnel = spawn(tunnelExe, ["run", "--profile", tunnelProfile], {
    detached: true,
    env: { ...process.env, CONTROL_PLANE_API_KEY: key },
    stdio: ["ignore", logStream, logStream],
  });
  writeFileSync(tunnelPidFile, `${tunnel.pid}\n`);
  tunnel.unref();
  appendFileSync(tunnelLogFile, `${new Date().toISOString()} started detached tunnel-client (pid ${tunnel.pid}, profile ${tunnelProfile})\n`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await tunnelIsUp()) {
      console.log(`tunnel up: pid ${readFileSync(tunnelPidFile, "utf8").trim()}, health http://127.0.0.1:${tunnelHealthPort}/ui — refresh the ChatGPT connector and open a new conversation`);
      return true;
    }
    await wait(1000);
  }
  console.log(`tunnel-client launched (pid ${tunnel.pid}) but /readyz did not answer within 20s — see ${tunnelLogFile} (first-start may take longer: the cloudflared companion has to report ready)`);
  process.exitCode = Math.max(process.exitCode ?? 0, 2);
  return false;
}

/** Stop the tunnel daemon if one of ours is running. */
async function stopTunnel() {
  const recorded = existsSync(tunnelPidFile) ? Number(readFileSync(tunnelPidFile, "utf8").trim()) : NaN;
  if (!Number.isNaN(recorded) && alive(recorded)) {
    // A plain kill would orphan the cloudflared companion; take the tree.
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(recorded), "/T", "/F"], { stdio: "ignore" });
    else process.kill(recorded, "SIGKILL");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (await tunnelIsUp())) await wait(300);
  }
  rmSync(tunnelPidFile, { force: true });
}

// --- user commands -----------------------------------------------------------

async function start() {
  if (await bridgeHandshakes(port)) {
    console.log(`bridge already running: 127.0.0.1:${port} answers MCP handshakes (pid ${existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "?"})`);
  } else {
    const recorded = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
    if (alive(recorded)) {
      console.log(`a daemon claims this port (pid ${recorded}) but ${port} is not answering. Investigate before restarting; force it with: stop, then start.`);
      process.exitCode = 1;
      return;
    }
    rmSync(pidFile, { force: true });
    const daemon = spawn(process.execPath, [process.argv[1], "daemon", "--port", String(port)], { detached: true, stdio: "ignore" });
    daemon.unref();
    note(`started detached daemon (spawn pid ${daemon.pid})`);

    let listening = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      listening = await portIsListening(port);
      if (listening) break;
      await wait(500);
    }
    if (!listening || !(await bridgeHandshakes(port))) {
      console.log(`bridge launched but did not come up on ${port} within 20s — see ${logFile}`);
      process.exitCode = 1;
      return;
    }
    console.log(`bridge up: pid ${readFileSync(pidFile, "utf8").trim()}, 127.0.0.1:${port} (tools: read, write, edit, glob, shell, rg)`);
  }
  await startTunnel();
  // Start a detached watchdog so a real tunnel failure self-heals.
  const watchdogPidFile = `${stateBase}-watchdog.pid`;
  const watchdogRecorded = existsSync(watchdogPidFile) ? Number(readFileSync(watchdogPidFile, "utf8").trim()) : NaN;
  if (alive(watchdogRecorded)) {
    console.log(`watchdog already running (pid ${watchdogRecorded})`);
  } else {
    rmSync(watchdogPidFile, { force: true });
    const watchdog = spawn(process.execPath, [process.argv[1], "watchdog", "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    });
    watchdog.unref();
    note(`started detached watchdog (spawn pid ${watchdog.pid})`);
    console.log(`watchdog up: pid ${watchdog.pid}`);
  }
}

async function status() {
  const recorded = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "(no pid file)";
  const listening = await portIsListening(port);
  const answering = listening ? await bridgeHandshakes(port) : false;
  console.log(`bridge 127.0.0.1:${port}: ${answering ? "answering" : listening ? "listening but not answering" : "down"}${answering ? "" : Number.isNaN(Number(recorded)) ? "" : alive(Number(recorded)) ? " (pid file points at a live process)" : " (pid file points at a dead process)"}`);
  const tunnelUp = await tunnelIsUp();
  const tunnelRecorded = existsSync(tunnelPidFile) ? readFileSync(tunnelPidFile, "utf8").trim() : "(no pid file)";
  console.log(`tunnel ${tunnelHealthPort}/readyz: ${tunnelUp ? "up" : "down"} (profile ${tunnelProfile}, pid ${tunnelRecorded}${Number.isNaN(Number(tunnelRecorded)) ? "" : alive(Number(tunnelRecorded)) ? ", alive" : ", dead"})${controlPlaneKey() ? "" : ", CONTROL_PLANE_API_KEY not set anywhere"}`);
  if (tunnelUp) console.log(`health UI: http://127.0.0.1:${tunnelHealthPort}/ui`);
}

async function stop() {
  // Stop the watchdog first: it would otherwise restart the tunnel the moment
  // stopTunnel brings it down.
  stopWatchdog();
  await stopTunnel();
  const recorded = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
  if (!Number.isNaN(recorded) && alive(recorded)) {
    process.kill(recorded, "SIGTERM");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (await portIsListening(port))) await wait(300);
  }
  rmSync(pidFile, { force: true });
  if (await portIsListening(port)) {
    console.log(`stopped what I could, but ${port} is still listening (a stale process may hold it)`);
    process.exitCode = 1;
  } else {
    console.log("stopped: tunnel-client and bridge");
  }
}

/**
 * Keep the tunnel alive: poll the health endpoint, and when it stops answering
 * for longer than the grace period, restart tunnel-client. This closes the gap
 * where tunnel-client's own response to a dead stdio MCP command is to shut
 * itself down — without a watchdog the tunnel stays down until a reboot or a
 * manual `start`.
 *
 * A normal control-plane re-handshake keeps `readyz` answering, so it is never
 * mistaken for a real failure; the health check is the only signal that matters.
 */
async function watchdog() {
  const graceMs = 15_000;
  const intervalMs = 5_000;
  note(`watchdog started (pid ${process.pid}, port ${port})`);
  let downSince = null;
  writeFileSync(`${stateBase}-watchdog.pid`, `${process.pid}\n`);

  while (true) {
    const up = await tunnelIsUp();
    if (up) {
      if (downSince !== null) note(`watchdog: tunnel back up`);
      downSince = null;
    } else {
      if (downSince === null) {
        downSince = Date.now();
        note(`watchdog: tunnel health failed; grace period starts`);
      } else if (Date.now() - downSince >= graceMs) {
        note(`watchdog: tunnel down for ${Date.now() - downSince}ms; restarting`);
        await stopTunnel();
        await startTunnel();
        downSince = null;
      }
    }
    await wait(intervalMs);
  }
}

/** Stop the watchdog if one of ours is running. */
function stopWatchdog() {
  const file = `${stateBase}-watchdog.pid`;
  const recorded = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : NaN;
  if (!Number.isNaN(recorded) && alive(recorded)) {
    process.kill(recorded, "SIGTERM");
  }
  rmSync(file, { force: true });
}

void (command === "start" ? start() : command === "daemon" ? runDaemon() : command === "tunnel" ? startTunnel() : command === "status" ? status() : command === "watchdog" ? watchdog() : stop());
