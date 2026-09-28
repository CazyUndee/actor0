import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProjectContext, loadProjectContext } from "./context.js";

/**
 * Project context is the cheapest performance lever there is: when an
 * AGENTS.md exists, every session starts already knowing the conventions.
 * The tests pin the two behaviours that make it trustworthy — the nearest
 * file wins, and ancestors compose behind it.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), "actor0-context-"));

test("no context file, no context", () => {
  assert.deepEqual(loadProjectContext(scratch()), []);
  assert.equal(formatProjectContext([]), "");
});

test("AGENTS.md in the working directory is found", () => {
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "# Rules\nUse pnpm.\n");
  const files = loadProjectContext(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, join(dir, "AGENTS.md"));
  assert.match(files[0].content, /Use pnpm/);
});

test("CLAUDE.md is the fallback when there is no AGENTS.md", () => {
  const dir = scratch();
  writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
  const files = loadProjectContext(dir);
  assert.equal(files.length, 1);
  assert.match(files[0].path, /CLAUDE\.md$/);
});

test("AGENTS.md beats CLAUDE.md in the same directory", () => {
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "agents rules");
  writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
  const files = loadProjectContext(dir);
  assert.equal(files.length, 1);
  assert.match(files[0].path, /AGENTS\.md$/);
});

test("ancestors compose, nearest first", () => {
  const outer = scratch();
  const inner = join(outer, "packages", "app");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(outer, "AGENTS.md"), "root rules");
  writeFileSync(join(inner, "AGENTS.md"), "app rules");

  const files = loadProjectContext(inner);
  assert.equal(files.length, 2);
  assert.match(files[0].content, /app rules/, "the nearest file comes first");
  assert.match(files[1].content, /root rules/);
});

test("an empty or whitespace context file is skipped", () => {
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "   \n\t\n");
  assert.deepEqual(loadProjectContext(dir), []);
});

test("a directory named AGENTS.md is not read as a file", () => {
  const dir = scratch();
  mkdirSync(join(dir, "AGENTS.md"));
  try {
    assert.deepEqual(loadProjectContext(dir), []);
  } finally {
    rmSync(join(dir, "AGENTS.md"), { recursive: true });
  }
});

test("formatProjectContext wraps files in a project_context block", () => {
  const out = formatProjectContext([
    { path: "/repo/AGENTS.md", content: "root rules" },
    { path: "/repo/app/AGENTS.md", content: "app rules" },
  ]);
  // The block is append-only: it starts with the two newlines it needs to sit
  // cleanly after the base prompt.
  assert.match(out, /^\n\n<project_context>/);
  assert.match(out, /<project_instructions path="\/repo\/AGENTS\.md">/);
  assert.match(out, /<\/project_context>$/);
  // Nearest first in the rendered block too.
  assert.ok(out.indexOf("root rules") < out.indexOf("app rules"));
});

test("the empty case renders as nothing, leaving the prompt byte-identical", () => {
  assert.equal(formatProjectContext([]), "");
});
