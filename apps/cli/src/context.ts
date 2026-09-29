import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Project context files, loaded the way pi loads them.
 *
 * A harness that ships no project memory makes the model re-derive the same
 * conventions every session — where tests live, which package manager, what
 * not to touch. `AGENTS.md` (and its de-facto aliases) is that memory, and it
 * is already sitting in most repos this CLI will be pointed at. Loading it is
 * the cheapest performance win available: it costs nothing when absent, and
 * when present it replaces a session of the model guessing and re-reading.
 *
 * The catch is that none of it is bounded by anything, and it is re-sent with
 * every request. A repository whose `AGENTS.md` is a dump of its own docs
 * put tens of thousands of characters in front of the model on the first
 * turn, on every turn, and the request stopped fitting before the
 * conversation had said anything at all. There is no sensible way to load
 * "all of it", so the loader takes what fits and says on the face of the
 * prompt what it left out.
 */

const CONTEXT_FILENAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export type ContextFile = {
  /** Absolute path, so the prompt can show the model where each rule came from. */
  path: string;
  content: string;
};

/**
 * Characters kept from one context file.
 *
 * 16k is around 4k tokens: an order of magnitude more than a real
 * `AGENTS.md` uses, and small enough that two of them still leave room for
 * the conversation they are attached to. Claude Code's own guidance for a
 * memory file is 40k characters, which is the right number for a file that is
 * loaded once and summarised; this one is charged again on every single
 * request, so it gets a quarter of that.
 */
export const MAX_CONTEXT_FILE_CHARS = 16_000;

/**
 * Characters kept from all of them, nearest first.
 *
 * One file is usually the whole of it. A monorepo root and its packages each
 * carrying rules is the case that needs the ceiling, and there the nearest
 * file is the one the model is least likely to guess for itself, so it is the
 * one that keeps its budget.
 */
export const MAX_TOTAL_CONTEXT_CHARS = 32_000;

/**
 * What the longest note below can come to. Reserved before the cut rather
 * than measured after it, because measuring after means the note changes the
 * cut that produced the number in the note.
 */
const NOTE_RESERVE = 200;

/**
 * A file whose text a model cannot quote back: a UTF-8 BOM it will never
 * reproduce, and CRLF it will read as literal characters. `tools.ts` strips
 * both for the same reason, and the same reason applies here — the model is
 * following the text, not reproducing the bytes.
 */
function normalize(raw: string): string {
  const withoutBom = raw.startsWith("﻿") ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n/g, "\n").trim();
}

/**
 * The first context file in `dir`, or null. Nearest names win: `AGENTS.md` is
 * the standard, `CLAUDE.md` is the de-facto clone marker, and one file per
 * directory keeps ancestor composition predictable.
 */
function loadFromDir(dir: string): ContextFile | null {
  for (const filename of CONTEXT_FILENAMES) {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) continue;
    try {
      if (!statSync(filePath).isFile()) continue;
      const content = normalize(readFileSync(filePath, "utf8"));
      if (content) return { path: filePath, content };
    } catch {
      // An unreadable context file is not a failed session. Skip it.
    }
  }
  return null;
}

/**
 * Context files from `cwd` up to (and including) the filesystem root, nearest
 * first. A repo checkout inherits its monorepo root's rules plus its own;
 * stopping at a filesystem or repo boundary would silently drop one of them.
 *
 * Each file is cut to what is left of the budget, and the cut is stated in
 * the text rather than left for the model to discover: a model told to follow
 * rules it has been given the first half of will follow them as if they were
 * all of them, which is worse than being told the rest was not sent.
 */
export function loadProjectContext(cwd: string): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  let used = 0;
  let current = resolve(cwd);
  while (true) {
    const file = loadFromDir(current);
    if (file && !seen.has(file.path)) {
      seen.add(file.path);
      const room = MAX_TOTAL_CONTEXT_CHARS - used;
      const kept = room > 0 ? fit(file, room) : null;
      if (kept) {
        files.push(kept);
        used += kept.content.length;
      } else {
        files.push({ path: file.path, content: `[not sent: ${basename(file.path)} does not fit the project-context budget]` });
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files;
}

/**
 * The file, cut to `room` characters, or null when there is not enough room to
 * say honestly what was left out.
 *
 * The cut lands on a line boundary. Half a rule is not half the information,
 * it is a different and wrong instruction, and the prompt above this block
 * tells the model these are rules to follow.
 */
function fit(file: ContextFile, room: number): ContextFile | null {
  const limit = Math.min(MAX_CONTEXT_FILE_CHARS, room);
  if (file.content.length <= limit) return file;
  const head = file.content.slice(0, Math.max(0, limit - NOTE_RESERVE));
  const breakAt = head.lastIndexOf("\n");
  const kept = (breakAt > 0 ? head.slice(0, breakAt) : head).trimEnd();
  const marker =
    `\n\n[truncated: the first ${kept.length.toLocaleString("en-US")} of ` +
    `${file.content.length.toLocaleString("en-US")} characters of ${basename(file.path)} are shown; ` +
    "the rest was not sent]";
  if (kept.length + marker.length > limit) return null;
  return { path: file.path, content: kept + marker };
}

/**
 * The `<project_context>` block appended to the system prompt.
 *
 * Empty input returns "" so the prompt stays byte-identical to the prompt
 * tests already assert on when there is nothing to load.
 *
 * The path goes in an attribute, so it is escaped: `"` and `<` are legal in
 * a filename on every platform this runs on, and one of them unescaped would
 * end the attribute early and hand the model a half-parsed path. The content
 * is passed through untouched — it is the user's own file, they wrote rules
 * in it, and reformatting a rules file to suit a delimiter is not this
 * function's call to make.
 */
export function formatProjectContext(files: ContextFile[]): string {
  if (files.length === 0) return "";
  const blocks = files
    .map((file) => `<project_instructions path="${attribute(file.path)}">\n${file.content}\n</project_instructions>`)
    .join("\n\n");
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${blocks}\n</project_context>`;
}

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
