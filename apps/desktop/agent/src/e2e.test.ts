import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Agent } from "./agent.js";
import { saveConfig } from "./config.js";
import { nodeBridge } from "./native/bridge.js";
import { startServer, type RunningServer } from "./server.js";
import { listSessions } from "./sessions.js";
import type { AgentNotification } from "./protocol.js";

/**
 * The whole stack, end to end.
 *
 * A real HTTP endpoint speaking OpenAI's SSE dialect, the real provider
 * transport, the real harness, the real agent, and the real WebSocket server —
 * driven by a real client. Nothing here is injected except the *endpoint*, and
 * that is deliberate: the last time this project tested a provider parser
 * against strings it had invented, every test passed and the code was wrong
 * about the wire. A stub server that has to speak the protocol is the closest
 * thing to the real thing that can run on every commit.
 */

let dir: string;
let endpoint: Server;
let endpointUrl: string;
const requests: { path: string; body: string }[] = [];
const envKeys = ["ACTOR0_CONFIG_DIR", "ACTOR0_DATA_DIR", "ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_API_KEY", "ACTOR0_PATH"] as const;
const saved: Record<string, string | undefined> = {};

/** The SSE frames an OpenAI-compatible endpoint sends for a short answer. */
function sseFor(text: string): string[] {
  const words = text.split(" ");
  const frames = words.map(
    (word, index) => `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: index === 0 ? word : ` ${word}` } }] })}`,
  );
  frames.push(`data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`);
  frames.push("data: [DONE]");
  return frames;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "actor0-desktop-e2e-"));
  for (const key of envKeys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ACTOR0_CONFIG_DIR = join(dir, "config");
  process.env.ACTOR0_DATA_DIR = join(dir, "data");

  endpoint = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body });
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const frame of sseFor("Hello from the endpoint")) response.write(`${frame}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const address = endpoint.address();
  const port = typeof address === "object" && address ? address.port : 0;
  endpointUrl = `http://127.0.0.1:${port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A tiny client that speaks the agent's protocol over a real socket. */
class TestClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly notifications: AgentNotification[] = [];
  private nextId = 1;
  private waiters: (() => boolean)[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.on("open", () => resolve());
      this.socket.on("error", reject);
    });
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { id?: string; result?: unknown; error?: { message?: string }; event?: AgentNotification };
      if (message.event) {
        this.notifications.push(message.event);
        // Re-check every waiter and keep the ones that are still waiting: a
        // waiter that is dropped on the first unrelated notification can never
        // observe the one it is waiting for.
        this.waiters = this.waiters.filter((waiter) => !waiter());
        return;
      }
      if (typeof message.id !== "string") return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  call(method: string, params?: unknown): Promise<unknown> {
    const id = `c${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Wait for a notification matching `match`, or reject after `timeoutMs`. */
  awaitNotification(match: (notification: AgentNotification) => boolean, timeoutMs = 15_000): Promise<AgentNotification> {
    const found = this.notifications.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for a notification; saw: ${this.notifications.map((notification) => notification.type).join(", ") || "nothing"}`,
            ),
          ),
        timeoutMs,
      );
      const check = (): boolean => {
        const found_ = this.notifications.find(match);
        if (!found_) return false;
        clearTimeout(timer);
        resolve(found_);
        return true;
      };
      this.waiters.push(check);
    });
  }

  close(): void {
    this.socket.close();
  }
}

describe("a turn through the real stack", () => {
  it("streams the endpoint's answer over the socket and saves the session", async () => {
    saveConfig({
      model: "stub-model",
      models: ["stub-model"],
      providers: [{ name: "stub", baseUrl: endpointUrl, apiKey: "sk-stub", model: "stub-model", models: ["stub-model"] }],
      activeProvider: "stub",
    });

    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0" });
    const server: RunningServer = await startServer({ agent, port: 0 });
    const client = new TestClient(`ws://127.0.0.1:${server.port}`);
    await client.open();

    try {
      const info = (await client.call("agent.hello")) as { version: string; bridge: string };
      assert.equal(info.bridge, "node");

      await client.call("turn.send", { input: "say hello" });
      const finished = (await client.awaitNotification((notification) => notification.type === "turn.finished")) as Extract<
        AgentNotification,
        { type: "turn.finished" }
      >;
      assert.equal(finished.result.ok, true);

      // The tokens arrived in order, before the turn finished.
      const tokens = client.notifications
        .filter((notification): notification is Extract<AgentNotification, { type: "turn.event" }> => notification.type === "turn.event")
        .map((notification) => notification.event)
        .filter((event) => event.type === "token")
        .map((event) => (event.type === "token" ? event.delta : ""));
      assert.equal(tokens.join(""), "Hello from the endpoint");

      // And the answer is what the endpoint actually sent.
      const conversation = (await client.call("conversation.get")) as { messages: { role: string; content: string }[] };
      assert.equal(conversation.messages[0]!.role, "user");
      assert.equal(conversation.messages[0]!.content, "say hello");
      assert.match(conversation.messages[conversation.messages.length - 1]!.content, /Hello from the endpoint/);

      // The request went where the config said, with the credential attached.
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.path, "/v1/chat/completions");
      const body = JSON.parse(requests[0]!.body) as { model: string; messages: { role: string }[]; tools?: unknown[] };
      assert.equal(body.model, "stub-model");
      assert.equal(body.messages[0]!.role, "system");
      // The system prompt is real policy, not a placeholder.
      assert.match(JSON.stringify(body.messages[0]), /actor0/);
      // Tools were advertised, so the model can actually call them.
      assert.ok(Array.isArray(body.tools) && body.tools.length >= 9);

      // The session is on disk, in the CLI's format.
      const sessions = listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.model, "stub-model");
      assert.equal(sessions[0]!.messages.length, 2);
    } finally {
      client.close();
      await server.close();
      agent.dispose();
    }
  });

  it("refuses an unknown method over the wire instead of hanging", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0" });
    const server = await startServer({ agent, port: 0 });
    const client = new TestClient(`ws://127.0.0.1:${server.port}`);
    await client.open();
    try {
      await assert.rejects(() => client.call("nope.nothing"), /unknown method "nope.nothing"/);
    } finally {
      client.close();
      await server.close();
      agent.dispose();
    }
  });

  it("requires the token when the server was given one", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0" });
    const server = await startServer({ agent, port: 0, token: "secret" });
    const denied = new TestClient(`ws://127.0.0.1:${server.port}`);
    await assert.rejects(() => denied.open(), /unexpected server response|socket hang up|ECONNRESET/i);
    const allowed = new TestClient(`ws://127.0.0.1:${server.port}?token=secret`);
    await allowed.open();
    try {
      const info = (await allowed.call("agent.hello")) as { version: string };
      assert.equal(info.version, "0.0.0");
    } finally {
      allowed.close();
      await server.close();
      agent.dispose();
    }
  });
});
