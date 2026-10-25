/**
 * Run the Actor0 MCP server ("the ChatGPT plugin") as a background service.
 *
 * MCP's native transport is stdio, where the client (ChatGPT's connector,
 * Codex) spawns the server itself. This script is for the other case: keeping
 * a single long-lived instance up so it can be talked to and inspected on
 * demand. It wraps `mcp-serve.ts` in a small bridge that holds the server's
 * stdin open for its whole life and forwards JSON lines between the server
 * and a localhost TCP socket — every response line is broadcast to all
 * connected clients, every request line fed to the server's stdin.
 *
 *   node apps/cli/scripts/mcp-serve-daemon.mjs [start|status|stop] [--port N]
 *
 *   start   launch if not already up (idempotent; the default when no command
 *           is given)
 *   status  report whether the bridge is answering, and which pids own it
 *   stop    shut the whole tree down
 *
 * `daemon` is a hidden mode: the spawned child runs it so it executes the
 * bridge in-process and never re-spawns itself. It is not a user command.
 *
 * State lives outside the checkout: a pid file and a log under $HOME
 * (.mcp-serve-daemon-<port>.{pid,log}).
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, writeFileSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const args = process.argv.slice(2);
const command = args.includes("daemon")
  ? "daemon"
  : (["start", "status", "stop"].find((a) => args.includes(a)) ?? "start");
const portFlag = args.indexOf("--port");
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : Number(process.env.MCP_SERVE_PORT ?? 47501);

// This script is at apps/cli/scripts/, so the repo root is three levels up.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(join(scriptDir, "..", "..", ".."));
const tsx = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const stateBase = join(homedir(), `.mcp-serve-daemon-${port}`);
const pidFile = `${stateBase}.pid`;
const logFile = `${stateBase}.log`;
const note = (message) => appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);

/** Is a process with this pid alive on this platform? */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists but not ours to signal
  }
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

/** The bridge itself: spawn the server, hold its stdin open, serve it over TCP. */
function runDaemon() {
  const server = spawn(process.execPath, [tsx, "apps/cli/scripts/mcp-serve.ts", "--tools", "read,write,edit,glob,shell,rg"], {
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

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function start() {
  if (await bridgeHandshakes(port)) {
    console.log(`already running: 127.0.0.1:${port} answers MCP handshakes (pid ${existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "?"}). Stop it with: node ${process.argv[1]} stop --port ${port}`);
    return;
  }
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

  const deadline = Date.now() + 20_000;
  let listening = false;
  while (Date.now() < deadline) {
    listening = await portIsListening(port);
    if (listening) break;
    await wait(500);
  }
  if (!listening || !(await bridgeHandshakes(port))) {
    console.log(`daemon launched but the bridge did not come up on ${port} within 20s — see ${logFile}`);
    process.exitCode = 1;
    return;
  }
  console.log(`up: daemon pid ${readFileSync(pidFile, "utf8").trim()}, bridge on 127.0.0.1:${port} (tools: read, write, edit, glob, shell, rg). Stop with: node ${process.argv[1]} stop --port ${port}`);
}

async function status() {
  const recorded = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "(no pid file)";
  const listening = await portIsListening(port);
  const answering = listening ? await bridgeHandshakes(port) : false;
  console.log(`bridge 127.0.0.1:${port}: ${answering ? "answering" : listening ? "listening but not answering" : "down"}`);
  if (Number.isNaN(Number(recorded))) console.log(`pid file: ${recorded}`);
  else console.log(`daemon pid ${recorded}: ${alive(Number(recorded)) ? "alive" : "dead"}`);
}

async function stop() {
  const recorded = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
  if (!Number.isNaN(recorded) && alive(recorded)) {
    process.kill(recorded, "SIGTERM");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (await portIsListening(port))) await wait(300);
  }
  rmSync(pidFile, { force: true });
  if (await portIsListening(port)) {
    console.log(`stopped daemon but ${port} is still listening (a stale process may hold it)`);
    process.exitCode = 1;
  } else {
    console.log(`stopped${Number.isNaN(recorded) ? " (nothing to stop)" : ` (pid ${recorded} and its tree)`}`);
  }
}

void (command === "start" ? start() : command === "daemon" ? runDaemon() : command === "status" ? status() : stop());
