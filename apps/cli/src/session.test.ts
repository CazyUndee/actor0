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
