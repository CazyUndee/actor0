/**
 * actor0 Desktop — Neutralino main entry point.
 *
 * This is the shell that Neutralino runs. Its only job is to:
 * 1. Serve the React UI (handled by Neutralino's built-in static server).
 * 2. Supervise the agent core process (node + agent.bundle.mjs).
 * 3. Expose NativeAPI events so the agent can call back into the shell.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AGENT_PATH = join(__dirname, "resources", "neu", "agent.bundle.mjs");

let agentProcess = null;
let respawnTimer = null;

export function startAgent() {
  if (agentProcess) {
    agentProcess.kill();
  }

  agentProcess = spawn("node", [AGENT_PATH], { cwd: __dirname, stdio: "pipe" });

  agentProcess.stdout.on("data", (data) => {
    console.log(`[agent] ${data.toString("utf8")}`);
  });

  agentProcess.stderr.on("data", (data) => {
    console.error(`[agent] ${data.toString("utf8")}`);
  });

  agentProcess.on("exit", (code, signal) => {
    console.error(`[agent] exited with code ${code} signal ${signal} — respawning...`);
    if (respawnTimer) clearTimeout(respawnTimer);
    respawnTimer = setTimeout(startAgent, 1000);
  });
}

export function stopAgent() {
  if (agentProcess) agentProcess.kill();
  if (respawnTimer) clearTimeout(respawnTimer);
}

console.log("[main] actor0 desktop shell ready");
