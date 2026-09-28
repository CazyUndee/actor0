import type { ChatMessage } from "@actor0/harness";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "./paths.js";

/**
 * Conversation persistence.
 *
 * A session is exactly the harness's own `ChatMessage[]` plus enough metadata
 * to show a resume banner. Nothing else is stored — in particular no API key,
 * which lives only in config or the environment.
 *
 * History is capped on save. A long tool-using session grows without bound and
 * a resumed conversation that starts with 400 stale messages is both slow and
 * confusing; the model only needs the recent window to stay coherent.
 */

export type StoredSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messages: ChatMessage[];
};

/** Keep the tail, always preserving the leading system message if present. */
export function trimHistory(messages: ChatMessage[], max = 100): ChatMessage[] {
  if (messages.length <= max) return messages;
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = messages.slice(messages.length - (max - system.length));
  return [...system, ...rest];
}

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

export function saveSession(session: StoredSession): void {
  mkdirSync(sessionsDir(), { recursive: true });
  const payload: StoredSession = { ...session, messages: trimHistory(session.messages) };
  writeFileSync(sessionFile(session.id), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** Load one session, or undefined if it is missing or unreadable. */
export function loadSession(id: string): StoredSession | undefined {
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
  const messages = parsed.messages.filter(isChatMessage);
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
