import type { ChatMessage } from "@actor0/harness";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactHistory, compactHistoryPerMessage, repairHistory } from "./history.js";
import { sessionsDir } from "./paths.js";

/**
 * Conversation persistence.
 *
 * A session is exactly the harness's own `ChatMessage[]` plus enough metadata
 * to show a resume banner. Nothing else is stored — in particular no API key,
 * which lives only in config or the environment.
 *
 * History is compacted on save. A long tool-using session grows without bound,
 * and the saved payload is what a resume replays — so stale tool results have
 * their contents cleared while every message stays exactly where it was. See
 * `history.ts` for why that is better than dropping messages.
 */

export type StoredSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messages: ChatMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && typeof value.role === "string" && typeof value.content === "string";
}

export function newSessionId(now = new Date()): string {
  // Sortable, filesystem-safe, and readable: 2026-09-27T12-34-56-789Z
  return now.toISOString().replace(/[:.]/g, "-");
}

export function sessionFile(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

/**
 * Reject an id that is not a plain session name.
 *
 * Ids come from `newSessionId` normally, but `--session` is typed by a human,
 * and `join` will happily resolve `../../whatever` into a path outside the
 * sessions directory. Nothing here writes through that path — a load is a
 * read — but a flag that silently reads somewhere else is the kind of thing
 * that becomes a write the next time someone extends this.
 */
function assertSessionId(id: string): void {
  if (!id || id === "." || id === ".." || /[\\/]/.test(id) || id.includes("..")) {
    throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  }
}

export function saveSession(session: StoredSession): void {
  assertSessionId(session.id);
  mkdirSync(sessionsDir(), { recursive: true });
  // The per-message pass runs first: it bounds a single turn's tool-result
  // burst whatever the age of the results, and the global pass then clears
  // remaining stale results oldest-first. Both are clear-only — see history.ts.
  const messages = compactHistoryPerMessage(session.messages);
  const payload: StoredSession = { ...session, messages: compactHistory(messages) };
  const target = sessionFile(session.id);

  // Write to a sibling, then rename. Rename is atomic on Windows and POSIX, so
  // a reader sees the old file or the new one and never a half of each.
  //
  // This matters more than it looks: the direct write truncated a 100-message
  // session in place, and `loadSession` treats unparseable JSON as "no such
  // session" — so a disk that filled up mid-write, or a kill -9, destroyed the
  // whole conversation and reported nothing at all. The saved work is the one
  // thing a user cannot reconstruct.
  const staging = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(staging, target);
  } catch (error) {
    // Never leave a staging file behind for `listSessions` to trip over.
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
  // Repair before returning. A file written by an older build, a hand-edit, or
  // a truncation can hold a tool result whose call is gone, or a call whose
  // results never landed — and the provider rejects that shape outright, so a
  // resume that skips this fails on every request until the session dies.
  // Cheap (one walk), invisible on a clean history, and it makes load and
  // save symmetric: both ends of the file's life run the validity pass.
  const messages = repairHistory(parsed.messages.filter(isChatMessage));
  return {
    id: parsed.id,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    model: typeof parsed.model === "string" ? parsed.model : "",
    messages,
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
  const sessions = files
    .filter((file) => file.endsWith(".json"))
    .map((file) => loadSession(file.slice(0, -".json".length)))
    .filter((session): session is StoredSession => session !== undefined);
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The most recently updated session, if any. */
export function latestSession(): StoredSession | undefined {
  return listSessions()[0];
}
