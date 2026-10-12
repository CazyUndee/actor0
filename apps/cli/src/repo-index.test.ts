import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRepoTree,
  getRepoIndex,
  invalidateRepoIndex,
  queryRepoIndex,
  type RepoIndex,
} from "./repo-index.js";

/**
 * The repo index and its shallow tree. `getRepoIndex` shells out to
 * `rg --files`, so these build a real temp tree and assert against what
 * ripgrep actually reports — .gitignore respected, node_modules skipped.
 */

const withDir = <T>(body: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-repo-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    invalidateRepoIndex(dir);
  }
};

const emptyIndex = (files: string[]): RepoIndex => ({
  cwd: "/x",
  files,
  tree: { name: ".", isDir: true, children: new Map() },
});

test("getRepoIndex lists files, respecting .gitignore and skipping node_modules", () => {
  withDir((dir) => {
    // rg respects .gitignore only inside a git repo, so give it a .git.
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "kept.ts"), "x");
    writeFileSync(join(dir, "ignored.txt"), "x");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
    const index = getRepoIndex(dir);
    assert.ok(index.files.includes("kept.ts"), "a normal file is listed");
    assert.ok(!index.files.includes("ignored.txt"), ".gitignore is respected");
    assert.ok(!index.files.some((f) => f.startsWith("node_modules/")), "node_modules is skipped");
  });
});

test("formatRepoTree renders a shallow tree, directories with a trailing slash", () => {
  withDir((dir) => {
    mkdirSync(join(dir, "apps", "cli"), { recursive: true });
    writeFileSync(join(dir, "apps", "cli", "a.ts"), "x");
    writeFileSync(join(dir, "README.md"), "x");
    const tree = formatRepoTree(getRepoIndex(dir));
    assert.match(tree, /apps\//, "a directory carries a trailing slash");
    assert.match(tree, /README\.md/, "a top-level file is listed");
    assert.match(tree, /a\.ts/, "a nested file appears within the depth cap");
  });
});

test("formatRepoTree caps depth and says so rather than reading as complete", () => {
  withDir((dir) => {
    mkdirSync(join(dir, "a", "b", "c", "d"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c", "d", "deep.ts"), "x");
    const tree = formatRepoTree(getRepoIndex(dir), { maxDepth: 2 });
    // Two levels of entries render; the third is cut, and the cut is marked with …
    assert.ok(!tree.includes("deep.ts"), "a file past the depth cap is not rendered");
    assert.match(tree, /…/, "the depth cut is marked");
  });
});

test("getRepoIndex caches, and invalidateRepoIndex forces a rebuild", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "a.ts"), "x");
    assert.ok(getRepoIndex(dir).files.includes("a.ts"));
    writeFileSync(join(dir, "b.ts"), "x");
    assert.ok(!getRepoIndex(dir).files.includes("b.ts"), "the cache is used, not rebuilt");
    invalidateRepoIndex(dir);
    assert.ok(getRepoIndex(dir).files.includes("b.ts"), "invalidate forces a rebuild");
  });
});

test("queryRepoIndex finds files by substring, capped and sorted", () => {
  const index = emptyIndex(["b.ts", "a.ts", "src/c.ts"]);
  assert.deepEqual(queryRepoIndex(index, ".ts"), ["a.ts", "b.ts", "src/c.ts"]);
  assert.deepEqual(queryRepoIndex(index, "src"), ["src/c.ts"]);
  assert.deepEqual(queryRepoIndex(index, ""), [], "an empty query matches nothing");
  assert.deepEqual(queryRepoIndex(index, "zzz"), []);
});
