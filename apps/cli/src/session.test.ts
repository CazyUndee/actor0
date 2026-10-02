import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "@actor0/harness";
import { listSessions, loadSession, newSessionId, saveSession, sessionFile } from "./session.js";

/**
 * Session persistence had no tests at all, which is how a transcript the API
 * refuses to answer could be written and reloaded without anything noticing.
 * What a saved history *contains* is ; this file is about
 * the files.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), "actor0-session-"));
process.env.ACTOR0_DATA_DIR = scratch();

/** A conversation of `rounds` identical user/assistant/tool cycles. */
function conversation(rounds: number, callsPerRound = 1): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let round = 0; round < rounds; round += 1) {
    messages.push({ role: "user", content: `question ${round}` });
    const calls = Array.from({ length: callsPerRound }, (_, i) => ({
      id: `c${round}-${i}`,
      type: "function" as const,
      function: { name: "read", arguments: "{}" },
    }));
    messages.push({ role: "assistant", content: "", tool_calls: calls });
    for (const call of calls) {
      messages.push({ role: "tool", content: `result ${call.id}`, tool_call_id: call.id, name: "read" });
    }
  }
  return messages;
}

// --- round trip -------------------------------------------------------------

test("a session survives a save and load unchanged", () => {
  const messages = conversation(5);
  saveSession({
    id: "round-trip",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    model: "test/model",
    messages,
  });
  const loaded = loadSession("round-trip");
  assert.ok(loaded);
  assert.equal(loaded.model, "test/model");
  assert.deepEqual(loaded.messages, messages);
  assert.equal(loaded.createdAt, "2026-01-01T00:00:00.000Z");
});

test("the saved file is complete JSON the moment saveSession returns", () => {
  // Not "eventually". A direct write truncates in place, and a session that
  // parses as nothing is indistinguishable from one that was never saved.
  saveSession({
    id: "completeness",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    model: "m",
    messages: conversation(80),
  });
  const raw = readFileSync(sessionFile("completeness"), "utf8");
  const parsed = JSON.parse(raw) as { messages: ChatMessage[] };
  assert.ok(parsed.messages.length > 0);
  assert.ok(raw.endsWith("\n"), "the file is a finished document, not a fragment");
});

test("a half-written session left by an older build is not resurrected as truth", () => {
  // loadSession cannot recover a truncated file, and that is the point: it must
  // not hand back a conversation that has lost its tail.
  writeFileSync(sessionFile("truncated"), '{"id":"truncated","messages":[', "utf8");
  assert.equal(loadSession("truncated"), undefined);
});

test("a save leaves no staging file behind", () => {
  const before = readdirSync(join(process.env.ACTOR0_DATA_DIR!, "sessions")).filter((f) => f.includes(".tmp"));
  saveSession({
    id: "no-temp",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    model: "m",
    messages: conversation(2),
  });
  const after = readdirSync(join(process.env.ACTOR0_DATA_DIR!, "sessions")).filter((f) => f.includes(".tmp"));
  assert.deepEqual(after, before, "a temp file that outlives its rename becomes litter");
});

test("an id that climbs out of the sessions directory is refused", () => {
  // `--session` is typed by a human, and `join` resolves `../` happily.
  assert.equal(loadSession("../../etc/passwd"), undefined);
  assert.throws(
    () =>
      saveSession({
        id: "../escape",
        createdAt: "x",
        updatedAt: "x",
        model: "m",
        messages: [],
      }),
    /invalid session id/,
  );
  assert.throws(
    () =>
      saveSession({
        id: "sub/dir",
        createdAt: "x",
        updatedAt: "x",
        model: "m",
        messages: [],
      }),
    /invalid session id/,
  );
});

test("an unreadable session is skipped rather than poisoning the list", () => {
  mkdirSync(join(process.env.ACTOR0_DATA_DIR!, "sessions"), { recursive: true });
  writeFileSync(sessionFile("broken"), "not json at all", "utf8");
  writeFileSync(sessionFile("wrong-shape"), '{"id":"x","messages":"nope"}', "utf8");
  saveSession({
    id: "good",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    model: "m",
    messages: conversation(1),
  });
  const ids = listSessions().map((s) => s.id);
  assert.ok(ids.includes("good"));
  assert.ok(!ids.includes("broken"), "an unparseable file must not appear as a session");
  assert.ok(!ids.includes("wrong-shape"));
});

test("sessions are listed most recently updated first", () => {
  for (const [id, updatedAt] of [
    ["old", "2026-01-01T00:00:00.000Z"],
    ["newest", "2026-03-01T00:00:00.000Z"],
    ["middle", "2026-02-01T00:00:00.000Z"],
  ] as const) {
    saveSession({ id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt, model: "m", messages: [] });
  }
  const order = listSessions().map((s) => s.id);
  assert.ok(order.indexOf("newest") < order.indexOf("middle"));
  assert.ok(order.indexOf("middle") < order.indexOf("old"));
});

test("session ids sort chronologically and are filesystem-safe", () => {
  const earlier = newSessionId(new Date("2026-01-01T00:00:00.000Z"));
  const later = newSessionId(new Date("2026-06-01T00:00:00.000Z"));
  assert.ok(earlier < later, "lexical order is chronological order");
  assert.doesNotMatch(earlier, /[:.]/, "a colon or a dot is a path problem on some systems");
  assert.doesNotMatch(earlier, /[\\/]/);
});

test("loadSession repairs a broken history instead of resuming it broken", () => {
  // A file written by an older build, a hand-edit, or a truncation can hold a
  // tool result whose call is gone — or a call whose results never landed.
  // The provider rejects that shape outright, so a resume that skips repair
  // fails on every request until the session dies. saveSession repairs; this
  // is the other end of the file's life, and it had the same hole.
  process.env.ACTOR0_DATA_DIR = scratch();

  // Orphan result: the call was dropped, the result survived.
  saveSession({
    id: "orphan",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    model: "m",
    messages: [
      { role: "user", content: "earlier" },
      { role: "tool", tool_call_id: "ghost", content: "result of a dropped call" },
    ],
  });
  const orphan = loadSession("orphan");
  assert.ok(orphan);
  assert.deepEqual(
    orphan.messages.map((m) => m.role),
    ["user"],
    "an orphaned tool result must not survive a load",
  );

  // Dangling call: killed between the call and its results.
  saveSession({
    id: "dangling",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    model: "m",
    messages: [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: "{}" } }] },
    ],
  });
  const dangling = loadSession("dangling");
  assert.ok(dangling);
  assert.deepEqual(
    dangling.messages.map((m) => m.role),
    ["user"],
    "a call with no result must not survive a load",
  );

  // A clean history loads byte-identical — repair is invisible on valid input.
  const clean = conversation(2);
  saveSession({
    id: "clean",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    model: "m",
    messages: clean,
  });
  assert.deepEqual(loadSession("clean")?.messages, clean);
});

test("a save keeps the results the model is still reasoning about", () => {
  // This is where the promise in `DEFAULT_TOKEN_BUDGET` is kept or broken. A
  // save is not a failure path: nothing is broken, the file is simply larger
  // than the budget wants, and compaction's answer is to clear payloads. It
  // used to reach all the way to the newest result once the stale ones ran
  // out, and the next turn then opened by re-reading a file it had just read
  // — with a save that looked completely clean, because a cleared payload is
  // a successful save by every measure the code makes.
  process.env.ACTOR0_DATA_DIR = scratch();

  // Four rounds of a 40,000-char read: over the 16k-token budget, with the
  // last two rounds being the ones a turn is actually reasoning about.
  const messages: ChatMessage[] = [];
  for (let round = 0; round < 4; round += 1) {
    messages.push({ role: "user", content: `question ${round}` });
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `c${round}`, type: "function", function: { name: "read", arguments: "{}" } }],
    });
    messages.push({ role: "tool", tool_call_id: `c${round}`, name: "read", content: "x".repeat(40_000) });
  }

  saveSession({
    id: "working-set",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    model: "m",
    messages,
  });
  const loaded = loadSession("working-set");
  const results = loaded!.messages.filter((m) => m.role === "tool");

  assert.equal(results.length, 4, "a save may not drop a result, only clear it");
  for (const recent of results.slice(-2)) {
    assert.ok(
      !recent.content.startsWith("[result cleared"),
      `the model lost ${recent.tool_call_id}, which it was mid-answer on`,
    );
  }
  assert.ok(results[0]!.content.startsWith("[result cleared"), "the oldest payload should still have gone");
});
