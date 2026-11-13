import type { ChatMessage } from "@actor0/harness";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactHistory, KEEP_RECENT, repairHistory } from "./history.js";
import { sessionsDir } from "./paths.js";

/**
 * Conversation persistence, in the CLI's own `StoredSession` format.
 *
 * A session is the harness's `ChatMessage[]` plus enough metadata to show a
 * resume banner — nothing else, and in particular no credential, which lives
 * only in the config file or the environment. Because the format matches the
 * CLI's, a conversation started in one host is resumable in the other; that
 * interoperation is the whole reason this file exists rather than reusing some
 * host-private store.
 *
 * History is compacted on save (payloads cleared, messages untouched) and
 * repaired on load, so the two ends of a file's life are symmetric and a file
 * that predates a schema change still opens.
 */

export const SESSION_VERSION = 1;

export type StoredSession = {
  version?: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messages: ChatMessage[];
};

/** A session as the picker shows it, without the transcript. */
export type SessionSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && typeof value.role === "string" && typeof value.content === "string";
}

export function newSessionId(now = new Date()): string {
  // Sortable, filesystem-safe, readable: 2026-09-27T12-34-56-789Z
  return now.toISOString().replace(/[:.]/g, "-");
}

export function sessionFile(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

/**
 * Reject an id that is not a plain session name.
 *
 * Ids come from `newSessionId` normally, but `/session <id>` is typed by a
 * human, and `join` will happily resolve `../../whatever` into a path outside
 * the sessions directory. Nothing here writes through that path — a load is a
 * read — but a flag that silently reads elsewhere is the kind of thing that
 * becomes a write the next time someone extends this.
 */
function assertSessionId(id: string): void {
  if (!id || id === "." || id === ".." || /[\\/]/.test(id) || id.includes("..")) {
    throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  }
}

export function saveSession(session: StoredSession): void {
  assertSessionId(session.id);
  mkdirSync(sessionsDir(), { recursive: true });
  const payload: StoredSession = {
    ...session,
    version: SESSION_VERSION,
    messages: compactHistory(session.messages, { keepRecent: KEEP_RECENT }),
  };
  const target = sessionFile(session.id);

  // Write to a sibling, then rename: rename is atomic on Windows and POSIX, so
  // a reader sees the old file or the new one and never half of each. A direct
  // write that filled the disk mid-way once destroyed a whole conversation and
  // reported nothing, because an unparseable file reads as "no such session".
  const staging = `${target}.${process.pid}.tmp`;
  try {
    const handle = openSync(staging, "w");
    try {
      writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(staging, target);
  } catch (error) {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* the write already failed; the temp file is the lesser problem */
    }
    throw error;
  }
}

/** Load one session, or undefined if it is missing or unreadable. */
export function loadSession(id: string): StoredSession | undefined {
  try {
    assertSessionId(id);
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(sessionFile(id), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string" || !Array.isArray(parsed.messages)) return undefined;
  return {
    version: typeof parsed.version === "number" ? parsed.version : 0,
    id: parsed.id,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    model: typeof parsed.model === "string" ? parsed.model : "",
    messages: repairHistory(parsed.messages.filter(isChatMessage)),
  };
}

/** Every stored session, most recently updated first. */
export function listSessions(): StoredSession[] {
  let files: string[];
  try {
    files = readdirSync(sessionsDir());
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => loadSession(file.slice(0, -".json".length)))
    .filter((session): session is StoredSession => session !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Just the metadata, for the picker — the transcripts are not read for this. */
export function listSessionSummaries(): SessionSummary[] {
  return listSessions().map((session) => ({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model,
    messageCount: session.messages.length,
  }));
}

/** A short, human label for a session id. */
export function sessionLabel(id: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
  if (!match) return id;
  const [, y, mo, d, h, mi] = match;
  return `${y}-${mo}-${d} ${h}:${mi}`;
}
