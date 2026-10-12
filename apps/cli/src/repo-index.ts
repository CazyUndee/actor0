import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/**
 * A repo index and a shallow file tree.
 *
 * Built from `rg --files`, so it inherits ripgrep's `.gitignore` handling and
 * its skip of `node_modules` — the file list is exactly what a search would
 * see, which is the set the model should reason over. The *tree* (a few levels
 * deep) is what goes into the prompt; the full index is not dumped into
 * context, only queried through the action layer (`read --local --index`).
 *
 * Cached on `globalThis` and keyed by cwd, because the CLI is split into
 * several single-file bundles that each get their own module instance — a
 * module-level cache would not be shared between the bundle that reads the
 * tree (the turn machinery) and the one that invalidates it (a write tool).
 * Invalidated after a write or edit so the next turn sees the change.
 */

/** One node of the file tree. `children` is empty for a file. */
export type TreeNode = {
  name: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
};

export type RepoIndex = {
  cwd: string;
  /** Every file, POSIX and cwd-relative, as `rg --files` reports them. */
  files: string[];
  /** The root of the tree; its `children` are the top level. */
  tree: TreeNode;
};

const CACHE_KEY = "__actor0_repo_index__";
type Cache = Map<string, RepoIndex>;

const cache = (): Cache => {
  const store = globalThis as unknown as Record<string, Cache | undefined>;
  store[CACHE_KEY] ??= new Map();
  return store[CACHE_KEY]!;
};

/** Directories a shallow tree never descends into, on top of .gitignore. */
const SKIP_GLOBS = ["!**/node_modules/**"];

/** The files `rg --files` reports for `cwd`, POSIX and cwd-relative. */
function listFiles(cwd: string): string[] {
  const run = spawnSync(
    "rg",
    ["--files", "--path-separator", "/", ...SKIP_GLOBS.flatMap((g) => ["--glob", g])],
    { cwd, encoding: "utf8", windowsHide: true },
  );
  // A missing rg, or any spawn failure, is an empty index — no tree — not a
  // thrown error that would fail the turn. rg is a search accelerator here.
  if (run.error || typeof run.stdout !== "string") return [];
  return run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Build the tree from a flat, POSIX file list. */
function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: ".", isDir: true, children: new Map() };
  for (const file of files) {
    const parts = file.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, isDir: i < parts.length - 1, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
  }
  return root;
}

/** The index for `cwd`, built once and cached until invalidated. */
export function getRepoIndex(cwd: string): RepoIndex {
  const hit = cache().get(cwd);
  if (hit) return hit;
  const files = listFiles(cwd);
  const built: RepoIndex = { cwd, files, tree: buildTree(files) };
  cache().set(cwd, built);
  return built;
}

/** Drop the cached index for `cwd` so the next read rebuilds it. */
export function invalidateRepoIndex(cwd: string): void {
  cache().delete(cwd);
}

/** Directories first, then case-insensitive by name — how a person reads a tree. */
function byName(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const folded = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return folded !== 0 ? folded : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export type TreeOptions = {
  /** How many levels of entries to render. Default 3. */
  maxDepth?: number;
  /** Entries per directory before "... N more". Default 24. */
  maxEntries?: number;
};

/**
 * Render the shallow tree for the prompt.
 *
 * Deliberately shallow and capped: the point is to give the model the shape of
 * the repo, not its contents. A directory past the depth or entry cap says so,
 * so a capped tree never reads as the whole tree — the same rule `glob` and
 * `grep` follow.
 */
export function formatRepoTree(index: RepoIndex, options: TreeOptions = {}): string {
  const maxDepth = options.maxDepth ?? 3;
  const maxEntries = options.maxEntries ?? 24;
  const lines: string[] = [];
  const walk = (node: TreeNode, depth: number, indent: string): void => {
    if (depth > maxDepth) return;
    const kids = [...node.children.values()].sort(byName);
    const shown = kids.slice(0, maxEntries);
    const atDepthCap = depth === maxDepth;
    for (const kid of shown) {
      // At the depth cap a directory is shown but not opened; mark it so the
      // tree does not read as though that directory were empty.
      const truncated = kid.isDir && atDepthCap && kid.children.size > 0;
      lines.push(`${indent}${kid.name}${kid.isDir ? "/" : ""}${truncated ? " …" : ""}`);
      if (kid.isDir && !atDepthCap) walk(kid, depth + 1, `${indent}  `);
    }
    const more = kids.length - shown.length;
    if (more > 0) lines.push(`${indent}  … ${more} more`);
  };
  walk(index.tree, 1, "");
  return lines.join("\n");
}

/**
 * Files whose path contains `query`, case-insensitively — the queryable half
 * of the index, for `read --local --index`. A substring match on the whole
 * path, capped, sorted; the model narrows from here with `glob`/`rg`.
 */
export function queryRepoIndex(index: RepoIndex, query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return index.files
    .filter((file) => file.toLowerCase().includes(q))
    .sort()
    .slice(0, limit);
}

/** The top-level name of the repo, for a caption. */
export function repoName(cwd: string): string {
  return basename(cwd) || "repo";
}
