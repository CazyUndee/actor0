import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@actor0/harness";
import { globToRegExp, matchesPattern, toRelative } from "./glob.js";
import { MAX_OUTPUT_BYTES, optionalNumber, optionalText, requireString, withNotice } from "./shared.js";
import { within } from "./within.js";
import type { ToolContext } from "./context.js";

/**
 * The ripgrep tool.
 *
 * Search is ripgrep itself, not a reimplementation: it is faster than any
 * hand-rolled walk, respects `.gitignore` by default and skips binaries. The
 * one failure a model cannot diagnose is a search that quietly returns nothing
 * because `rg` is not installed — so this tool resolves a binary explicitly,
 * *ships one with the app* when it can, and only falls back to a JavaScript
 * walker when there is genuinely no binary at all, saying so in the result.
 *
 * The bundled copy is what makes the desktop app self-contained: a user who
 * installs the app gets search without also installing a Rust binary, which is
 * the difference between a working app and a support case.
 */

const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);
const MAX_SEARCH_FILES = 20_000;
const DEFAULT_HEAD_LIMIT = 250;
const RG_DEFAULT_TIMEOUT_MS = 30_000;
const RG_MAX_TIMEOUT_MS = 3_600_000;

type GrepMode = "files_with_matches" | "content" | "count";

function isGrepMode(value: string | undefined): value is GrepMode {
  return value === "files_with_matches" || value === "content" || value === "count";
}

/**
 * Where a bundled ripgrep lives, when the app shipped one.
 *
 * `NL_PATH` is the shell's own app directory; the resource copy puts the binary
 * beside the other resources. The two names cover Windows (`rg.exe`) and POSIX
 * (`rg`), and the check is `existsSync` because a path that does not exist is
 * simply the next candidate.
 */
export function bundledRgPath(): string | undefined {
  const nlPath = process.env.NL_PATH?.trim();
  const roots = [
    ...(nlPath ? [join(nlPath, "resources", "bin"), join(nlPath, "resources")] : []),
    join(process.cwd(), "resources", "bin"),
  ];
  for (const root of roots) {
    for (const name of ["rg.exe", "rg"]) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The ripgrep binary to run, or undefined when there is none.
 *
 * Order is specific-before-general: an explicit override, then the copy this app
 * shipped, then whatever is on `PATH`. Resolved once and remembered, because
 * probing means spawning a process.
 */
let cachedRg: string | null | undefined;

export function resolveRg(): string | undefined {
  if (cachedRg !== undefined) return cachedRg ?? undefined;
  const explicit = process.env.ACTOR0_RG_PATH?.trim();
  if (explicit) {
    cachedRg = explicit;
    return explicit;
  }
  const bundled = bundledRgPath();
  if (bundled) {
    cachedRg = bundled;
    return bundled;
  }
  try {
    const probe = spawnSync("rg", ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    cachedRg = probe.status === 0 ? "rg" : null;
  } catch {
    cachedRg = null;
  }
  return cachedRg ?? undefined;
}

/** Override the cached binary (tests, and a host that measured it elsewhere). */
export function setCachedRg(binary: string | undefined): void {
  cachedRg = binary ?? null;
}

export const rgDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "rg",
    description:
      "Search file contents with ripgrep and get back matching paths, matching lines with context, or match counts. Respects .gitignore and skips binaries. The search root may be any directory on the machine. The pattern is a Rust regular expression, not a glob. An include glob with no slash matches the file name, so *.ts reaches apps/cli/ui/parts.tsx. Prefer this to grepping in the shell.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for (ripgrep syntax)." },
        path: { type: "string", description: "File or directory to search. Defaults to the working directory." },
        include: { type: "string", description: "Glob to restrict which files are searched, e.g. *.ts." },
        output_mode: {
          type: "string",
          enum: ["files_with_matches", "content", "count"],
          description: "files_with_matches (default) lists paths; content shows the matching lines; count shows per-file totals.",
        },
        context: { type: "number", description: "Lines of context around each match, for output_mode: content." },
        limit: { type: "number", description: `Maximum results. Defaults to ${DEFAULT_HEAD_LIMIT}.` },
        timeout: { type: "number", description: "Seconds before the search is killed. 0 disables the cap (default 30)." },
      },
      required: ["pattern"],
    },
  },
};

export async function runRg(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = requireString(args, "pattern");
  const askedPath = optionalText(args, "path")?.trim() || ".";
  const include = optionalText(args, "include")?.trim();
  const mode: GrepMode = isGrepMode(optionalText(args, "output_mode")) ? (optionalText(args, "output_mode") as GrepMode) : "files_with_matches";
  const context = Math.max(0, Math.floor(optionalNumber(args, "context") ?? 0));
  const limit = Math.max(1, Math.floor(optionalNumber(args, "limit") ?? DEFAULT_HEAD_LIMIT));
  const timeoutSeconds = optionalNumber(args, "timeout");
  const timeoutMs = timeoutSeconds === undefined ? RG_DEFAULT_TIMEOUT_MS : Math.min(Math.max(0, timeoutSeconds) * 1_000, RG_MAX_TIMEOUT_MS);
  const target = await within(ctx.cwd, askedPath, false);

  const binary = resolveRg();
  if (binary) {
    return runRgBinary(binary, { pattern, target, ctx, include, mode, context, limit, timeoutMs });
  }
  return runFallbackSearch({ pattern, target, ctx, include, mode, context, limit });
}

function rgArgs(options: {
  pattern: string;
  include?: string;
  mode: GrepMode;
  context: number;
  limit: number;
}): string[] {
  const args = ["--no-heading", "--color", "never", "--max-columns", "500", "--max-columns-preview"];
  if (options.mode === "files_with_matches") args.push("--files-with-matches");
  else if (options.mode === "count") args.push("--count");
  else args.push("--line-number");
  if (options.mode === "content" && options.context > 0) args.push(`--context=${options.context}`);
  args.push("--max-count", String(options.limit));
  for (const dir of SKIP_DIRECTORIES) args.push("--glob", `!${dir}/**`);
  if (options.include) args.push("--glob", options.include);
  args.push("--", options.pattern, ".");
  return args;
}

async function runRgBinary(
  binary: string,
  options: {
    pattern: string;
    target: string;
    ctx: ToolContext;
    include?: string;
    mode: GrepMode;
    context: number;
    limit: number;
    timeoutMs: number;
  },
): Promise<string> {
  const result = spawnSync(binary, rgArgs(options), {
    cwd: options.target,
    encoding: "utf8",
    timeout: options.timeoutMs > 0 ? options.timeoutMs : undefined,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    // A missing binary was already ruled out; anything left is environmental.
    throw new Error(`rg could not run: ${result.error.message}`);
  }
  const stdout = (result.stdout ?? "").replace(/\r\n/g, "\n");
  const stderr = (result.stderr ?? "").replace(/\r\n/g, "\n").trim();
  const code = result.status ?? 0;

  if (code === 2 && !result.signal) {
    throw new Error(`rg failed: ${stderr || "unknown error"}`);
  }
  if (result.signal) {
    return withNotice(stdout.trimEnd(), `[search killed after ${Math.round(options.timeoutMs / 1000)}s; the result is incomplete.]`);
  }

  const lines = stdout.split("\n").filter((line) => line.length > 0 && !/^Binary file .* matches$/.test(line));
  const shown = lines.slice(0, options.limit);
  const body = shown.join("\n") || "(no matches)";
  const notes: string[] = [];
  if (lines.length > shown.length) notes.push(`[showing ${shown.length} of ${lines.length} results; raise \`limit\` or narrow the pattern.]`);
  else notes.push(`[${shown.length} result${shown.length === 1 ? "" : "s"}.]`);
  return notes.length ? withNotice(body, notes.join("\n")) : body;
}

/**
 * A JavaScript search, used only when no ripgrep binary exists at all.
 *
 * It walks the tree, skips dependency and VCS directories, honours the include
 * glob, and matches lines with the platform's own regular-expression engine.
 * It does not read `.gitignore` — ripgrep does, and this is the path taken when
 * ripgrep is not there — so the result says so rather than pretending to be the
 * real thing.
 */
async function runFallbackSearch(options: {
  pattern: string;
  target: string;
  ctx: ToolContext;
  include?: string;
  mode: GrepMode;
  context: number;
  limit: number;
}): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, "g");
  } catch (error) {
    throw new Error(`invalid regular expression: ${(error as Error).message}`);
  }
  const includeRegex = options.include ? globToRegExp(options.include) : undefined;
  const slashless = options.include ? !options.include.includes("/") : false;

  const results: string[] = [];
  const counts: { path: string; count: number }[] = [];
  let filesScanned = 0;

  const visit = async (dir: string): Promise<void> => {
    if (results.length >= options.limit || filesScanned >= MAX_SEARCH_FILES) return;
    let entries;
    try {
      entries = await options.ctx.bridge.readDirectory(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= options.limit || filesScanned >= MAX_SEARCH_FILES) return;
      const abs = `${dir.replace(/[\\/]$/, "")}/${entry.name}`;
      if (entry.isDirectory) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await visit(abs);
        continue;
      }
      const rel = toRelative(options.ctx.cwd, abs);
      if (includeRegex && !matchesPattern(rel, includeRegex, slashless)) continue;
      filesScanned += 1;
      let text: string;
      try {
        text = await options.ctx.bridge.readFile(abs, { pos: 0, size: 2_000_000 });
      } catch {
        continue;
      }
      if (text.includes("\0")) continue; // binary
      const lines = text.split("\n");
      let matched = 0;
      for (let i = 0; i < lines.length; i += 1) {
        regex.lastIndex = 0;
        if (!regex.test(lines[i]!)) continue;
        matched += 1;
        if (options.mode === "content") {
          results.push(`${rel}:${i + 1}:${lines[i]}`);
        }
      }
      if (options.mode === "files_with_matches" && matched > 0) results.push(rel);
      if (options.mode === "count" && matched > 0) counts.push({ path: rel, count: matched });
    }
  };

  await visit(options.target);

  const lines =
    options.mode === "count"
      ? counts.map((entry) => `${entry.path}:${entry.count}`)
      : results.slice(0, options.limit);
  const body = lines.join("\n") || "(no matches)";
  return withNotice(
    body,
    `[${lines.length} result${lines.length === 1 ? "" : "s"}. No ripgrep binary was found, so this is the built-in search: it does not read .gitignore.]`,
  );
}

/** Output cap shared with the shell tool, re-exported for the host's use. */
export const RG_OUTPUT_BYTES = MAX_OUTPUT_BYTES;
