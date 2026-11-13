import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, HarnessEvent, ModelClient, ModelEvent } from "@actor0/harness";
import { Agent } from "./agent.js";
import { saveConfig } from "./config.js";
import { nodeBridge } from "./native/bridge.js";
import { listSessions } from "./sessions.js";
import type { AgentNotification } from "./protocol.js";

/**
 * The agent, end to end, with no socket and no network.
 *
 * The model client is injected, so these tests exercise the *host* half of a
 * turn — the part the harness deliberately does not own: that events reach the
 * UI in order, that the transcript is adopted only when a turn produces one,
 * that a cancel still leaves the work that happened in the session, and that a
 * second turn cannot start while one is streaming.
 */

let dir: string;
const envKeys = ["ACTOR0_CONFIG_DIR", "ACTOR0_DATA_DIR", "ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-desktop-agent-"));
  for (const key of envKeys) saved[key] = process.env[key];
  process.env.ACTOR0_CONFIG_DIR = join(dir, "config");
  process.env.ACTOR0_DATA_DIR = join(dir, "data");
  for (const key of ["ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_API_KEY"] as const) delete process.env[key];
});

after(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  saveConfig({
    model: "test-model",
    models: ["test-model"],
    providers: [{ name: "test", baseUrl: "https://api.test.example/v1", apiKey: "sk-test", model: "test-model", models: ["test-model"] }],
    activeProvider: "test",
  });
});

/** A client that streams a fixed answer, then finishes. */
function answeringClient(answer: string): ModelClient {
  return {
    async *stream(): AsyncIterable<ModelEvent> {
      for (const word of answer.split(" ")) {
        yield { type: "token", delta: `${word} ` };
      }
      yield { type: "done" };
    },
  };
}

/** A client that streams one token and then never finishes until aborted. */
function hangingClient(): ModelClient {
  return {
    async *stream(_messages: ChatMessage[], _tools, signal: AbortSignal): AsyncIterable<ModelEvent> {
      yield { type: "token", delta: "partial " };
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        void resolve;
      });
      yield { type: "done" };
    },
  };
}

describe("a turn", () => {
  it("streams the harness events, adopts the transcript, and persists the session", async () => {
    const collected: AgentNotification[] = [];
    const events: HarnessEvent[] = [];
    let finish: (value: Extract<AgentNotification, { type: "turn.finished" }>) => void = () => {};
    const finished = new Promise<Extract<AgentNotification, { type: "turn.finished" }>>((resolve) => (finish = resolve));

    const agent = new Agent({
      cwd: dir,
      bridge: nodeBridge(),
      version: "0.0.0",
      createClient: () => answeringClient("Hello there"),
      notify: (notification) => {
        collected.push(notification);
        if (notification.type === "turn.event") events.push(notification.event);
        if (notification.type === "turn.finished") finish(notification);
      },
    });

    const { turnId } = await agent["turn.send"]({ input: "hi" });
    const result = await finished;

    assert.equal(result.result.ok, true);
    assert.equal(result.turnId, turnId);
    // `attempt_start` opens an attempt so a `reset` can rewind exactly it.
    assert.deepEqual(events.map((event) => event.type), ["attempt_start", "token", "token", "done"]);

    const conversation = await agent["conversation.get"]();
    const messages = conversation.messages as ChatMessage[];
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[0]!.content, "hi");
    // No system message is persisted: it is re-seeded on every turn.
    assert.ok(!messages.some((message) => message.role === "system"));
    assert.match(messages[messages.length - 1]!.content, /Hello there/);

    const sessions = listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.model, "test-model");
    assert.equal(sessions[0]!.messages.length, 2);
  });

  it("refuses a second turn while one is streaming", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0", createClient: () => hangingClient() });
    await agent["turn.send"]({ input: "first" });
    await assert.rejects(() => agent["turn.send"]({ input: "second" }), /a turn is already running/);
    await agent["turn.cancel"]();
  });

  it("refuses an empty message", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0", createClient: () => answeringClient("x") });
    await assert.rejects(() => agent["turn.send"]({ input: "   " }), /cannot send an empty message/);
  });
});

describe("cancelling", () => {
  it("keeps the partial answer and the question in the saved session", async () => {
    const notices: AgentNotification[] = [];
    let finish: (value: Extract<AgentNotification, { type: "turn.finished" }>) => void = () => {};
    const finished = new Promise<Extract<AgentNotification, { type: "turn.finished" }>>((resolve) => (finish = resolve));

    const agent = new Agent({
      cwd: dir,
      bridge: nodeBridge(),
      version: "0.0.0",
      createClient: () => hangingClient(),
      notify: (notification) => {
        notices.push(notification);
        if (notification.type === "turn.finished") finish(notification);
      },
    });

    await agent["turn.send"]({ input: "do something long" });
    // Let the first token land before cancelling, or the test asserts nothing
    // about what a cancel preserves.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { cancelled } = await agent["turn.cancel"]();
    assert.equal(cancelled, true);

    const result = await finished;
    assert.equal(result.result.ok, false);
    assert.equal(result.result.error, "interrupted");
    assert.ok(notices.some((notification) => notification.type === "notice" && notification.tone === "warn" && notification.text === "Interrupted."));

    const conversation = await agent["conversation.get"]();
    const messages = conversation.messages as ChatMessage[];
    assert.equal(messages[0]!.content, "do something long");
    // The harness marks a cancelled answer, and the transcript the app saves is
    // the one the user watched happen — not a rewind to before the turn.
    assert.match(messages[messages.length - 1]!.content, /\[interrupted\]/);
    const sessions = listSessions();
    assert.ok(sessions.length >= 1);
    assert.ok(sessions[0]!.messages.some((message) => message.content.includes("[interrupted]")));
  });

  it("answers false when nothing is running", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0", createClient: () => answeringClient("x") });
    assert.deepEqual(await agent["turn.cancel"](), { cancelled: false });
  });
});

describe("when the provider cannot be resolved", () => {
  it("sends a notice and finishes the turn with the reason, rather than hanging", async () => {
    saveConfig({ model: "", models: [] });
    const notices: AgentNotification[] = [];
    let finish: (value: Extract<AgentNotification, { type: "turn.finished" }>) => void = () => {};
    const finished = new Promise<Extract<AgentNotification, { type: "turn.finished" }>>((resolve) => (finish = resolve));

    const agent = new Agent({
      cwd: dir,
      bridge: nodeBridge(),
      version: "0.0.0",
      createClient: () => answeringClient("x"),
      notify: (notification) => {
        notices.push(notification);
        if (notification.type === "turn.finished") finish(notification);
      },
    });

    await assert.rejects(() => agent["turn.send"]({ input: "hi" }), /No provider is configured/);
    const result = await finished;
    assert.equal(result.result.ok, false);
    assert.match(result.result.error ?? "", /No provider is configured/);
    assert.ok(notices.some((notification) => notification.type === "notice" && notification.tone === "error"));
  });
});

describe("configuration over the wire", () => {
  it("reports the endpoint, the model and a masked credential", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0", createClient: () => answeringClient("x") });
    const snapshot = await agent["config.get"]();
    assert.equal(snapshot.provider?.model, "test-model");
    assert.equal(snapshot.provider?.endpoint, "https://api.test.example/v1/chat/completions");
    assert.equal(snapshot.provider?.credential, "set — sk... (7 chars)");
    assert.deepEqual(snapshot.models, ["test-model"]);
    assert.equal(snapshot.activeProvider, "test");
  });

  it("switches the active provider and persists it", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0", createClient: () => answeringClient("x") });
    const added = await agent["provider.add"]({ entry: { name: "other", baseUrl: "https://other.example/v1", model: "m2" } });
    assert.equal(added.activeProvider, "other");
    const back = await agent["provider.activate"]({ name: "test" });
    assert.equal(back.activeProvider, "test");
    const removed = await agent["provider.remove"]({ name: "other" });
    assert.deepEqual(removed.providers.map((provider) => provider.name), ["test"]);
  });

  it("sets the model on the active provider", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0", createClient: () => answeringClient("x") });
    const snapshot = await agent["model.set"]({ model: "another-model" });
    assert.equal(snapshot.provider?.model, "another-model");
    assert.ok(snapshot.models.includes("another-model"));
  });

  it("reports the shell, the bridge and the working directory", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "9.9.9", createClient: () => answeringClient("x") });
    const info = await agent["agent.hello"]();
    assert.equal(info.version, "9.9.9");
    assert.equal(info.cwd, dir);
    assert.equal(info.bridge, "node");
    assert.ok(info.shell.length > 0);
  });

  it("summarises usage from the local log", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0", createClient: () => answeringClient("x") });
    const usage = await agent["usage.get"]({ period: "all" });
    assert.equal(usage.period, "all");
    assert.ok(Array.isArray(usage.byModel));
  });
});

describe("sessions over the wire", () => {
  it("starts a fresh conversation and lists what has been saved", async () => {
    let finish: (value: Extract<AgentNotification, { type: "turn.finished" }>) => void = () => {};
    const finished = new Promise<Extract<AgentNotification, { type: "turn.finished" }>>((resolve) => (finish = resolve));
    const agent = new Agent({
      cwd: dir,
      bridge: nodeBridge(),
      version: "0.0.0",
      createClient: () => answeringClient("done"),
      notify: (notification) => {
        if (notification.type === "turn.finished") finish(notification);
      },
    });
    await agent["turn.send"]({ input: "remember this" });
    await finished;

    const summaries = await agent["session.list"]();
    assert.ok(summaries.length >= 1);

    await agent["session.new"]();
    const cleared = await agent["conversation.get"]();
    assert.deepEqual(cleared.messages, []);

    const first = summaries[0]!;
    const loaded = await agent["session.load"]({ id: first.id });
    assert.ok(Array.isArray(loaded.messages));
  });
});
