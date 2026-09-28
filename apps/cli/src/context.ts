import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Project context files, loaded the way pi loads them.
 *
 * A harness that ships no project memory makes the model re-derive the same
 * conventions every session — where tests live, which package manager, what
 * not to touch. `AGENTS.md` (and its de-facto aliases) is that memory, and it
 * is already sitting in most repos this CLI will be pointed at. Loading it is
 * the cheapest performance win available: it costs nothing when absent, and
 * when present it replaces a session of the model guessing and re-reading.
 */

const CONTEXT_FILENAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export type ContextFile = {
  /** Absolute path, so the prompt can show the model where each rule came from. */
  path: string;
  content: string;
};

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
      const content = readFileSync(filePath, "utf8");
      if (content.trim()) return { path: filePath, content: content.trim() };
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
 */
export function loadProjectContext(cwd: string): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  let current = resolve(cwd);
  while (true) {
    const file = loadFromDir(current);
    if (file && !seen.has(file.path)) {
      files.push(file);
      seen.add(file.path);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files;
}

/**
 * The `<project_context>` block appended to the system prompt.
 *
 * Empty input returns "" so the prompt stays byte-identical to the prompt
 * tests already assert on when there is nothing to load.
 */
export function formatProjectContext(files: ContextFile[]): string {
  if (files.length === 0) return "";
  const blocks = files
    .map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`)
    .join("\n\n");
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${blocks}\n</project_context>`;
}
