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
  { role: "assistant", content: "A short answer.", reasoning: "Check the readme before answering." },
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

  it("keeps both display fields of reasoning across a save and a load", () => {
    // The text and its duration are one fact: "thought for 3.4s" is only true
    // while the number that produced it came back with the text. `repairHistory`
    // rebuilds messages on load, so this asserts it rebuilds them *without*
    // dropping what the renderer needs — a transcript that reloads as "thought"
    // is a duration that was measured, stored, and then quietly discarded.
    const id = newSessionId(new Date("2026-11-10T11:00:00.000Z"));
    saveSession({
      id,
      createdAt: "2026-11-10T11:00:00.000Z",
      updatedAt: "2026-11-10T11:00:05.000Z",
      model: "m",
      messages: [
        { role: "user", content: "why" },
        { role: "assistant", content: "because", reasoning: "weighed it up", reasoningMs: 3_400 },
      ],
    });
    const loaded = loadSession(id);
    assert.ok(loaded);
    const assistant = loaded.messages.find((message) => message.role === "assistant");
    assert.equal(assistant?.reasoning, "weighed it up");
    assert.equal(assistant?.reasoningMs, 3_400, "the duration survives repairHistory");
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

describe("M3 — session sharing with the CLI", () => {
  // M3 is exactly this: a session written by one host opens in the other, and
  // a round trip through the desktop never breaks the CLI's reader. Both hosts
  // share ~/.local/share/actor0/sessions and the StoredSession shape, but
  // nothing but a test holds the two honest as the formats drift (the desktop
  // added cwd/title in build 84; the CLI has its own budget-based compaction).
  // These tests pin the interoperation with a CLI-shaped file built by hand —
  // no CLI import, so the desktop suite stays boundary-clean.

  /** The CLI's StoredSession shape: exactly these keys, and no cwd/title. */
  function writeCliSession(id: string, msgs: ChatMessage[]): void {
    const payload = {
      version: 1,
      id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
      model: "cli-model",
      messages: msgs,
    };
    writeFileSync(join(sessionsDir(), `${id}.json`), JSON.stringify(payload, null, 2), "utf8");
  }

  const cliShape = (raw: string): Record<string, unknown> => JSON.parse(raw) as Record<string, unknown>;

  it("loads a CLI-written session, including one with cleared tool payloads", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "read the config" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] },
      // The CLI's own compaction marker — a desktop resume must show it as-is.
      { role: "tool", content: "[cleared: read 4,000 chars to save context]", tool_call_id: "t1", name: "read" },
      { role: "assistant", content: "The config sets the model." },
    ];
    writeCliSession("2026-03-03T00-00-00-000Z", msgs);
    const loaded = loadSession("2026-03-03T00-00-00-000Z");
    assert.ok(loaded, "a CLI-written session must load");
    assert.equal(loaded.messages.length, 4);
    assert.match(loaded.messages[2]!.content, /cleared/);
  });

  it("keeps every message through a desktop round trip, so the CLI can reopen it", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hello from the CLI" },
      { role: "assistant", content: "hello from the model" },
    ];
    writeCliSession("2026-04-04T00-00-00-000Z", msgs);
    const loaded = loadSession("2026-04-04T00-00-00-000Z")!;
    // A desktop resume persists the session again (title/cwd added, transcript kept).
    saveSession({
      id: loaded.id,
      createdAt: loaded.createdAt,
      updatedAt: new Date().toISOString(),
      model: loaded.model,
      messages: loaded.messages,
      cwd: "d:/somewhere",
      title: "a CLI conversation",
    });
    const roundTripped = cliShape(readFileSync(join(sessionsDir(), `${loaded.id}.json`), "utf8"));
    // The fields the CLI reads are intact, and unknown-to-CLI fields are
    // additive — a CLI load of this file keeps working (its loader filters by
    // shape and ignores extras).
    assert.equal((roundTripped.messages as { role: string }[]).length, 2);
    assert.equal(roundTripped.id, loaded.id);
    assert.equal(roundTripped.model, "cli-model");
    assert.equal(typeof roundTripped.cwd, "string");
    assert.equal(roundTripped.title, "a CLI conversation");
  });

  it("lists a CLI session in the picker with no title and no cwd", () => {
    writeCliSession("2026-05-05T00-00-00-000Z", [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]);
    const summaries = listSessionSummaries();
    const cli = summaries.find((summary) => summary.id === "2026-05-05T00-00-00-000Z");
    assert.ok(cli, "a CLI session appears in the desktop picker");
    assert.equal(cli.title, undefined, "a CLI session has no title until the desktop writes one");
    assert.equal(cli.cwd, undefined, "a CLI session has no cwd until the desktop writes one");
    assert.equal(cli.messageCount, 2);
  });
});

describe("the message shape a session file may carry", () => {
  it("drops messages with a role the wire protocol does not have", async () => {
    // loadSession accepted any string as a role, so a hand-edited session with
    // role "coauthor" loaded silently and failed at the provider on every turn
    // of the resumed session. Unknown roles are dropped at load like any other
    // unparseable message.
    const id = "2026-06-06T00-00-00-000Z";
    writeFileSync(
      join(sessionsDir(), `${id}.json`),
      JSON.stringify({
        id,
        createdAt: "",
        updatedAt: "",
        model: "m",
        messages: [
          { role: "user", content: "kept" },
          { role: "coauthor", content: "dropped" },
          { role: "assistant", content: "kept too" },
        ],
      }),
      "utf8",
    );
    const loaded = loadSession(id);
    assert.ok(loaded);
    assert.deepEqual(
      loaded.messages.map((m) => m.role),
      ["user", "assistant"],
      "only wire roles survive the load",
    );
  });
});
