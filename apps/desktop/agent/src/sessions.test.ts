import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "@actor0/harness";
import { sessionsDir } from "./paths.js";
import { listSessionSummaries, loadSession, newSessionId, saveSession, sessionLabel } from "./sessions.js";

/**
 * Sessions, as a shared file format.
 *
 * The desktop app and the CLI both read `sessions/*.json`, so these tests are
 * about durability and interoperation rather than about a class: a save that
 * survives a crash, a load that repairs a file an older build wrote, and an id
 * that cannot be used to read somewhere else on the disk.
 */

let dir: string;
let savedDataDir: string | undefined;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-desktop-sessions-"));
  savedDataDir = process.env.ACTOR0_DATA_DIR;
  process.env.ACTOR0_DATA_DIR = dir;
});

after(() => {
  if (savedDataDir === undefined) delete process.env.ACTOR0_DATA_DIR;
  else process.env.ACTOR0_DATA_DIR = savedDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const messages: ChatMessage[] = [
  { role: "user", content: "what is in the readme?" },
  { role: "assistant", content: "A short answer." },
];

describe("saving and loading", () => {
  it("round-trips a transcript with its metadata", () => {
    const id = newSessionId(new Date("2026-11-10T10:20:30.400Z"));
    saveSession({ id, createdAt: "2026-11-10T10:20:30.400Z", updatedAt: "2026-11-10T10:21:00.000Z", model: "m", messages });
    const loaded = loadSession(id);
    assert.ok(loaded);
    assert.equal(loaded.id, id);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.model, "m");
    assert.deepEqual(loaded.messages, messages);
  });

  it("writes a sortable, filesystem-safe id", () => {
    const id = newSessionId(new Date("2026-09-27T12:34:56.789Z"));
    assert.equal(id, "2026-09-27T12-34-56-789Z");
    assert.doesNotMatch(id, /[:.]/);
  });

  it("refuses an id that would escape the sessions directory", () => {
    assert.throws(() => saveSession({ id: "../escape", createdAt: "", updatedAt: "", model: "", messages: [] }), /invalid session id/);
    assert.equal(loadSession("../../etc/passwd"), undefined);
  });

  it("treats an unreadable file as no session rather than throwing", () => {
    writeFileSync(join(sessionsDir(), "broken.json"), "{not json");
    assert.equal(loadSession("broken"), undefined);
  });

  it("repairs a hand-edited file whose tool call lost its result", () => {
    const id = "2026-01-01T00-00-00-000Z";
    writeFileSync(
      join(sessionsDir(), `${id}.json`),
      JSON.stringify({
        id,
        createdAt: "",
        updatedAt: "",
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
        ],
      }),
    );
    const loaded = loadSession(id);
    assert.ok(loaded);
    assert.equal(loaded.messages.filter((message) => message.role === "tool").length, 1);
  });
});

describe("listing", () => {
  it("orders sessions most recently updated first, and summarises them", () => {
    const older = "2025-01-01T00-00-00-001Z";
    const newer = "2025-01-02T00-00-00-000Z";
    saveSession({ id: older, createdAt: "", updatedAt: "2025-01-01T00:00:00.000Z", model: "m1", messages: [messages[0]!] });
    saveSession({ id: newer, createdAt: "", updatedAt: "2025-01-02T00:00:00.000Z", model: "m2", messages });
    const summaries = listSessionSummaries();
    const order = summaries.map((summary) => summary.id);
    // Relative order, not an absolute first place: other cases in this file
    // write to the same directory.
    assert.ok(order.indexOf(newer) < order.indexOf(older), `expected ${newer} before ${older} in ${order.join(", ")}`);
    const summary = summaries.find((entry) => entry.id === newer)!;
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.model, "m2");
  });

  it("labels a session id readably", () => {
    assert.equal(sessionLabel("2026-11-10T14-23-45-123Z"), "2026-11-10 14:23");
    assert.equal(sessionLabel("not-an-id"), "not-an-id");
  });
});

describe("the stored file", () => {
  it("compacts stale tool payloads on save so a long session does not grow without bound", () => {
    const big = "y".repeat(6_000);
    const transcript: ChatMessage[] = [{ role: "user", content: "hi" }];
    for (let i = 0; i < 10; i += 1) {
      transcript.push(
        { role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", content: big, tool_call_id: `c${i}`, name: "read" },
      );
    }
    const id = "2026-02-02T00-00-00-000Z";
    saveSession({ id, createdAt: "", updatedAt: "", model: "m", messages: transcript });
    const onDisk = JSON.parse(readFileSync(join(sessionsDir(), `${id}.json`), "utf8")) as { messages: ChatMessage[] };
    assert.equal(onDisk.messages.length, transcript.length, "compaction must never drop a message");
    assert.ok(onDisk.messages.some((message) => message.content.includes("cleared from the saved transcript")));
  });
});
