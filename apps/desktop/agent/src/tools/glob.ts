import { relative } from "node:path";
import type { ToolDefinition } from "@actor0/harness";
import { optionalNumber, optionalText, withNotice } from "./shared.js";
import { within } from "./within.js";
import type { ToolContext } from "./context.js";

/**
 * The glob tool — find files by name.
 *
 * A listing is not the same kind of answer as a search, and the difference is
 * the whole design:
 *
 *  - `rg` skips `.git` and `node_modules` outright, and that is right, because
 *    the answer is a match list and a dependency tree in it is noise.
 *  - A *listing* that silently omits `node_modules/` tells the model the tree
 *    has no such thing, and the model will say so. So this tool lists the
 *    directory, does not descend into it, and names in a note the entries it
 *    left alone.
 *
 * The note is scoped to the answer: attached to every result, it made
 * `glob("README.md")` come back with a footnote about a directory nowhere in the
 * reply. An answer's shape must be a function of the question.
 */

const SKIP = new Set([".git", "node_modules"]);
const MAX_MATCHES = 500;

export const globDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "glob",
    description:
      "List files and directories by name. Without a pattern it lists the given directory (not descending into node_modules or .git). With a pattern it walks the tree and returns matching paths. Directories come back with a trailing slash. Prefer this to `ls`/`find` in the shell.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list, or the root to search from. Defaults to the working directory." },
        pattern: {
          type: "string",
          description:
            "Optional glob. A slashless pattern matches the file name anywhere in the tree (e.g. *.ts); a pattern with a slash or ** is matched against the relative path.",
        },
        limit: { type: "number", description: `Maximum entries to return. Defaults to ${MAX_MATCHES}.` },
      },
    },
  },
};

/** Compile a glob into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Does a relative path match? A slashless pattern also matches the file name. */
export function matchesPattern(relPath: string, regex: RegExp, slashless: boolean): boolean {
  if (regex.test(relPath)) return true;
  if (!slashless) return false;
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return regex.test(name);
}

/** A path relative to the working directory, with forward slashes. */
function toRelative(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}

/** Walk a directory tree, skipping dependency and VCS directories. */
async function walk(
  ctx: ToolContext,
  dir: string,
  regex: RegExp,
  slashless: boolean,
  limit: number,
  out: string[],
  skipped: Set<string>,
): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await ctx.bridge.readDirectory(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) return;
    const childAbs = `${dir.replace(/[\\/]$/, "")}/${entry.name}`;
    const rel = toRelative(ctx.cwd, childAbs);
    if (entry.isDirectory && SKIP.has(entry.name)) {
      skipped.add(rel);
      continue;
    }
    if (matchesPattern(rel, regex, slashless)) {
      out.push(entry.isDirectory ? `${rel}/` : rel);
    }
    if (entry.isDirectory) {
      await walk(ctx, childAbs, regex, slashless, limit, out, skipped);
    }
  }
}

export async function runGlob(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const askedPath = optionalText(args, "path")?.trim() || ".";
  const pattern = optionalText(args, "pattern")?.trim();
  const limit = Math.max(1, Math.floor(optionalNumber(args, "limit") ?? MAX_MATCHES));
  const target = await within(ctx.cwd, askedPath, false);

  if (!pattern) {
    const stats = await ctx.bridge.getStats(target).catch(() => null);
    if (!stats) throw new Error(`no such path: ${askedPath}`);
    if (!stats.isDirectory) return toRelative(ctx.cwd, target);
    const entries = (await ctx.bridge.readDirectory(target)).sort((a, b) => a.name.localeCompare(b.name));
    const lines: string[] = [];
    const skipped: string[] = [];
    for (const entry of entries) {
      if (SKIP.has(entry.name)) {
        skipped.push(entry.name);
        continue;
      }
      if (lines.length >= limit) break;
      lines.push(entry.isDirectory ? `${entry.name}/` : entry.name);
    }
    const body = lines.join("\n") || "(empty)";
    if (skipped.length === 0) return body;
    // The note names only the directories that were actually in this listing.
    return withNotice(body, `[not listed: ${skipped.map((name) => `${name}/`).join(", ")} — directories this tool does not descend into.]`);
  }

  const regex = globToRegExp(pattern);
  const slashless = !pattern.includes("/");
  const found: string[] = [];
  const skipped = new Set<string>();
  await walk(ctx, target, regex, slashless, limit, found, skipped);

  const notes: string[] = [];
  if (found.length >= limit) notes.push(`[stopped at ${limit} matches; narrow the pattern to see more.]`);
  notes.push(
    `[${found.length} match${found.length === 1 ? "" : "es"}${skipped.size > 0 ? `; skipped ${[...skipped].join(", ")}` : ""}.]`,
  );
  return withNotice(found.join("\n") || "(no matches)", notes.join("\n"));
}

export { SKIP as GLOB_SKIP_DIRECTORIES, toRelative };
