import { WebSocketServer, type WebSocket } from "ws";
import type { Agent } from "./agent.js";
import { isWireRequest, type AgentNotification, type WireResponse } from "./protocol.js";

/**
 * The transport: one localhost WebSocket, JSON both ways.
 *
 * The server is deliberately thin. It parses frames, calls the agent, and
 * writes replies — no state of its own beyond the set of open sockets. Every
 * decision worth testing lives in `Agent`, which is why the whole agent is
 * exercisable in a test with no port and no socket.
 *
 * It binds `127.0.0.1` and takes a token the shell generated, so the only
 * process that can drive the agent is the one the app started: a local port on
 * a shared machine is reachable by anything that can guess it, and an agent
 * that can write files should not be.
 */

export type ServerOptions = {
  agent: Agent;
  /** 0 asks the OS for a free port, which is what a launch wants. */
  port?: number;
  host?: string;
  /** Shared secret the client must present; when set, a mismatch is refused. */
  token?: string;
  onLog?: (line: string) => void;
};

export type RunningServer = {
  port: number;
  close: () => Promise<void>;
};

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const log = options.onLog ?? (() => {});
  const sockets = new Set<WebSocket>();

  const server = new WebSocketServer({
    host,
    port: options.port ?? 0,
    verifyClient: options.token
      ? (info: { req: { url?: string } }) => {
          const url = info.req.url ?? "";
          const presented = new URLSearchParams(url.split("?")[1] ?? "").get("token");
          return presented === options.token;
        }
      : undefined,
  });

  // Every notification goes to every open socket. Broadcasting rather than
  // unicasting is what lets a reloaded UI pick the stream back up mid-turn
  // instead of losing the tokens that streamed while it was gone.
  const broadcast = (notification: AgentNotification): void => {
    const frame = JSON.stringify({ event: notification });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
  };
  options.agent.setNotifier(broadcast);

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => log(`[server] socket error: ${error.message}`));

    socket.on("message", (raw) => {
      void handleMessage(socket, String(raw));
    });
  });

  async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log("[server] dropped a frame that was not JSON");
      return;
    }
    if (!isWireRequest(parsed)) {
      log("[server] dropped a frame that was not a request");
      return;
    }
    const { id, method, params } = parsed;
    const respond = (response: WireResponse): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(response));
    };
    const handler = (options.agent as unknown as Record<string, (p: unknown) => Promise<unknown>>)[method];
    if (typeof handler !== "function" || method.startsWith("_")) {
      respond({ id, error: { message: `unknown method "${method}"` } });
      return;
    }
    try {
      const result = await handler.call(options.agent, params);
      respond({ id, result });
    } catch (error) {
      respond({ id, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  return new Promise<RunningServer>((resolve, reject) => {
    server.on("error", reject);
    server.on("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
      // The port goes to stdout as one machine-readable line: the shell launched
      // this process and has to learn where to connect, and parsing a log
      // message is how that handshake goes wrong.
      process.stdout.write(`${JSON.stringify({ actor0: "listening", port })}\n`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.close();
            sockets.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
