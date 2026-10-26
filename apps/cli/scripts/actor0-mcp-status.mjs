#!/usr/bin/env node
/**
 * actor0-mcp-status — a one-shot, human-readable status check for the actor0
 * MCP bridge + OpenAI tunnel. No config, no credentials; it just reads the
 * running health endpoints and the pid files. Run it whenever ChatGPT looks
 * "down" and you need to know which layer is actually broken.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const HEALTH = 8080;
const BRIDGE_PORT = Number(process.env.MCP_SERVE_PORT ?? 47501);

async function fetchJson(url, ms = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

function pidFile(name) {
  const p = `${homedir()}/${name}`;
  if (!existsSync(p)) return { alive: false, pid: null };
  const pid = Number(readFileSync(p, "utf8").trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
  return { alive, pid };
}

function msSince(t0) {
  const s = (Date.now() - t0) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

async function main() {
  const t0 = Date.now();
  const tunnelPid = pidFile(".mcp-serve-tunnel.pid");
  const bridgePid = pidFile(`.mcp-serve-daemon-${BRIDGE_PORT}.pid`);

  // 1. is the tunnel process alive?
  let tunnelProc = "missing";
  try {
    const out = await (await fetchJson(`http://127.0.0.1:${HEALTH}/healthz`)).text();
    tunnelProc = out.trim() === "live" ? "live" : "DEAD";
  } catch {
    tunnelProc = tunnelPid.alive ? "unreachable (pid alive)" : "down";
  }

  // 2. is the bridge answering JSON-RPC?
  let bridge = "down";
  try {
    const net = await import("node:net");
    const ok = await new Promise((resolve) => {
      const s = net.connect(BRIDGE_PORT, "127.0.0.1");
      const timer = setTimeout(() => { s.destroy(); resolve(false); }, 2000);
      s.once("connect", () => {
        s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
        let buf = "";
        s.on("data", (c) => {
          buf += c.toString();
          const idx = buf.indexOf("\n");
          if (idx !== -1) {
            clearTimeout(timer); s.destroy();
            try { resolve(JSON.parse(buf.slice(0, idx)).id !== undefined); } catch { resolve(false); }
          }
        });
        s.on("error", () => { clearTimeout(timer); resolve(false); });
      });
      s.on("error", () => { clearTimeout(timer); resolve(false); });
    });
    bridge = ok ? "answering" : "listening but no JSON-RPC";
  } catch {
    bridge = "down";
  }

  // 3. health UI reachable?
  let ui = "unreachable";
  try {
    const res = await fetchJson(`http://127.0.0.1:${HEALTH}/readyz`);
    ui = res.status < 500 ? "up" : "degraded";
  } catch {}

  // 4. quick latency sample: one real tools/call through the bridge.
  let sample = "—";
  if (bridge === "answering") {
    try {
      const net = await import("node:net");
      const res = await new Promise((resolve, reject) => {
        const s = net.connect(BRIDGE_PORT, "127.0.0.1");
        let buf = "";
        const timer = setTimeout(() => { s.destroy(); reject(new Error("timeout")); }, 45000);
        s.on("data", (c) => {
          buf += c.toString();
          for (let i = 0; ; i++) {
            const idx = buf.indexOf("\n");
            if (idx === -1) break;
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            const m = JSON.parse(line);
            if (m.id === 2) { clearTimeout(timer); s.destroy(); resolve(m); return; }
          }
        });
        s.on("error", reject);
        s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
        s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rg", arguments: { pattern: "export", include: "package.json", path: "actor0" } } }) + "\n");
      });
      const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res);
      sample = `${(text.split("\n").length)} lines in ${Date.now() - t0}ms total (incl. handshake)`;
    } catch (e) {
      sample = `sample failed: ${e.message}`;
    }
  }

  console.log(`
  actor0 MCP status
  ─────────────────────────────────────
  tunnel-client   : ${tunnelProc}${tunnelPid.alive ? ` (pid ${tunnelPid.pid})` : ""}
  bridge ${BRIDGE_PORT}     : ${bridge}${bridgePid.alive ? ` (pid ${bridgePid.pid})` : ""}
  health UI       : ${ui}   http://127.0.0.1:${HEALTH}/ui
  rg sample       : ${sample}

  If tunnel-client is down but bridge is up, the ChatGPT tunnel half is broken.
  If both are up but ChatGPT still says "down", Refresh the actor0 connector
  in chatgpt.com → Plugins.
  `);
}

main().catch((e) => { console.error(`status check failed: ${e.message}`); process.exit(1); });
