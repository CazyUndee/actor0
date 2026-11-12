/**
 * actor0 Desktop — agent core entry point.
 *
 * Sibling host shape to the CLI's print.ts (one-shot) and mcp-serve.ts
 * (stdio MCP). It:
 * 1. Starts the harness + providers.
 * 2. Exposes a localhost WebSocket with a JSON-RPC API.
 * 3. Streams HarnessEvents back to the UI over the same socket.
 * 4. Talks back into the Neutralino shell via os.* NativeAPI calls.
 *
 * This file is bundled into agent.bundle.mjs by esbuild during packaging.
 */

import { WebSocketServer } from "ws";

/**
 * Minimal no-op agent that accepts "echo" calls from the UI.
 *
 * TODO (M1): wire in @actor0/harness, @actor0/providers, ToolHost, and
 * HarnessObserver. See docs/desktop-architecture.md §4.
 */

const PORT = process.env.AGENT_PORT ? Number(process.env.AGENT_PORT) : 3000;

async function main() {
  console.log(`[agent] actor0 desktop agent core listening on ws://127.0.0.1:${PORT}`);

  const server = new WebSocketServer({ port: PORT });
  server.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "invalid json" }));
        return;
      }
      handle(ws, msg);
    });

    ws.send(JSON.stringify({ type: "ready", port: PORT }));
  });
}

function handle(ws, msg) {
  const { id, method, params } = msg;
  void params;
  let result;
  let error;

  try {
    switch (method) {
      case "ping":
        result = { pong: true };
        break;
      case "config.get":
        result = { providers: [], models: [], cwd: process.cwd() };
        break;
      case "agent.turn": {
        // TODO: run harness.runAgentTurn(...) here
        result = {
          turnId: msg.params?.turnId || "none",
          response: "Agent core not wired yet — this is the M0 mock.",
        };
        break;
      }
      default:
        error = { code: "NOT_IMPLEMENTED", message: `unknown method: ${method}` };
    }
  } catch (e) {
    error = { code: "INTERNAL", message: e.message };
  }

  ws.send(JSON.stringify({ id, result, error }));
}

main().catch((e) => {
  console.error("[agent] fatal:", e);
  process.exit(1);
});
