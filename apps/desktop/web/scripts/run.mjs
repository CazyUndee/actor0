#!/usr/bin/env node
/**
 * Launch the desktop app end-to-end: start the agent, write its port where the
 * UI can read it, then open Neutralino in chrome mode.
 *
 * This is the reliable dev path: it does not depend on the page being able to
 * call Neutralino's native API (which needs a valid client token — something
 * chrome mode does not inject into a fetchable globals file), and it does not
 * depend on the agent picking port 3000. The agent prints its port; this script
 * catches it and serves it to the UI as a static file.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const agentBundle = path.join(web, "resources", "agent", "agent.mjs");
const servedPortFile = path.join(web, "resources", "app", "agent-port.json");
const shellModeFile = path.join(web, "resources", "app", "shell-mode.json");
const authInfoFile = path.join(web, ".tmp", "auth_info.json");
const neuExe = path.join(web, "bin", "neutralino-win_x64.exe");

const children = new Set();
function killAll() {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
}
process.on("exit", killAll);
process.on("SIGINT", () => { killAll(); process.exit(130); });
process.on("SIGTERM", () => { killAll(); process.exit(143); });

async function startAgent() {
  const child = spawn("node", [agentBundle], {
    cwd: web,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    console.error(`[run] agent exited (code=${code} signal=${signal})`);
  });
  child.stderr.on("data", (d) => process.stderr.write(`[agent] ${d}`));

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("agent did not report a port within 15s")), 15_000);
    let buf = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      process.stdout.write(`[agent] ${text}`);
      buf += text;
      const m = /"port"\s*:\s*(\d+)/.exec(buf);
      if (m) { clearTimeout(timeout); resolve(Number(m[1])); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`agent exited early (code=${code})`)); });
  });

  await mkdir(path.dirname(servedPortFile), { recursive: true });
  await writeFile(servedPortFile, JSON.stringify({ port, pid: child.pid }), "utf8");
  console.log(`[run] agent ready on ws://127.0.0.1:${port} (wrote ${path.relative(web, servedPortFile)})`);
  return { child, port };
}

async function main() {
  const mode = process.argv.includes("--window") ? "window" : "chrome";
  const { port } = await startAgent();

  // Tell the UI which shell mode is active so it can load the Neutralino client
  // correctly (window mode needs the client for native APIs; chrome mode must not
  // load it against an empty token or the page is replaced with an error).
  await writeFile(shellModeFile, JSON.stringify({ mode }), "utf8");

  // Remove stale auth info so we never publish a previous instance's token.
  await rm(authInfoFile, { force: true }).catch(() => {});

  // The UI discovers the agent via the port file we just wrote. Chrome mode is
  // the default because window mode (WebView2) segfaults intermittently on some
  // machines; pass --window for the frameless native shell when it is stable.
  const neu = spawn(neuExe, ["--load-dir-res", "--path=.", `--mode=${mode}`], {
    cwd: web,
    stdio: "inherit",
  });
  children.add(neu);

  // Neutralino writes its auth info once the server is up; expose the token so
  // the page can connect the client library in window mode even when injection
  // does not run (without this, window controls and dragging APIs are no-ops).
  void (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(authInfoFile, "utf8");
        const auth = JSON.parse(raw);
        if (auth.nlToken && auth.nlPort) {
          await writeFile(shellModeFile, JSON.stringify({ mode, nlToken: auth.nlToken, nlPort: auth.nlPort, nlConnectToken: auth.nlConnectToken }), "utf8");
          return;
        }
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  neu.on("exit", async (code) => {
    children.delete(neu);
    await rm(servedPortFile, { force: true }).catch(() => {});
    await rm(shellModeFile, { force: true }).catch(() => {});
    killAll();
    process.exit(code ?? 0);
  });
  neu.on("error", (err) => {
    console.error(`[run] failed to start Neutralino: ${err.message}`);
    killAll();
    process.exit(1);
  });

  console.log(`[run] Neutralino launched (${mode} mode). Agent on ${port}. Close the window to exit.`);
}

main().catch((err) => {
  console.error(`[run] ${err.stack ?? err.message}`);
  killAll();
  process.exit(1);
});
