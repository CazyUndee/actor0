import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatProjectContext,
  loadProjectContext,
  MAX_CONTEXT_FILE_CHARS,
  MAX_TOTAL_CONTEXT_CHARS,
} from "./context.js";

/**
 * Project context is the cheapest performance lever there is: when an
 * AGENTS.md exists, every session starts already knowing the conventions.
 * The tests pin the two behaviours that make it trustworthy — the nearest
 * file wins, and ancestors compose behind it — and the bounds that keep it
 * from becoming the reason a request does not fit.
 *
 * The loader walks to the filesystem root, so a machine with an AGENTS.md in
 * its home directory returns a file this suite never wrote. Every assertion
 * about counts and order is therefore made through `under`, which keeps only
 * the scratch directory's files.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), "actor0-context-"));

/** The loaded files that came from `root`, ignoring anything further up. */
const under = (root: string, loaded: { path: string; content: string }[]): { path: string; content: string }[] =>
  loaded.filter((file) => file.path.startsWith(root));

/** `count` lines of filler, about fifteen characters each. */
const lines = (count: number, tag: string): string =>
  Array.from({ length: count }, (_, i) => `${tag} rule ${i}`).join("\n");

test("no context file, no context", () => {
  assert.deepEqual(loadProjectContext(scratch()), []);
  assert.equal(formatProjectContext([]), "");
});

test("AGENTS.md in the working directory is found", () => {
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "# Rules\nUse pnpm.\n");
  const files = under(dir, loadProjectContext(dir));
  assert.equal(files.length, 1);
  assert.equal(files[0].path, join(dir, "AGENTS.md"));
  assert.match(files[0].content, /Use pnpm/);
});

test("CLAUDE.md is the fallback when there is no AGENTS.md", () => {
  const dir = scratch();
  writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
  const files = under(dir, loadProjectContext(dir));
  assert.equal(files.length, 1);
  assert.match(files[0].path, /CLAUDE\.md$/);
});

test("AGENTS.md beats CLAUDE.md in the same directory", () => {
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "agents rules");
  writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
  const files = under(dir, loadProjectContext(dir));
  assert.equal(files.length, 1);
  assert.match(files[0].path, /AGENTS\.md$/);
});

test("an AGENTS.md with nothing in it does not shadow a real one", () => {
  // Nearest wins, and "nearest" is decided by which name comes first in the
  // directory. An empty AGENTS.md that hid the CLAUDE.md beside it would
  // leave the session with no project memory at all, which is the one
  // outcome this loader exists to prevent.
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "   \n\t\n");
  writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
  const files = under(dir, loadProjectContext(dir));
  assert.equal(files.length, 1);
  assert.match(files[0].path, /CLAUDE\.md$/);
  assert.equal(files[0].content, "claude rules");
});

test("ancestors compose, nearest first", () => {
  const outer = scratch();
  const inner = join(outer, "packages", "app");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(outer, "AGENTS.md"), "root rules");
  writeFileSync(join(inner, "AGENTS.md"), "app rules");

  const files = under(outer, loadProjectContext(inner));
  assert.equal(files.length, 2);
  assert.match(files[0].content, /app rules/, "the nearest file comes first");
  assert.match(files[1].content, /root rules/);
});

test("an empty or whitespace context file is skipped", () => {
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "   \n\t\n");
  assert.deepEqual(under(dir, loadProjectContext(dir)), []);
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

test("a BOM and CRLF are normalised away", () => {
  // The model is told to follow this text. It will never emit a BOM or a
  // carriage return when quoting it, and neither character belongs in a rule.
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "\uFEFF# Rules\r\nuse pnpm\r\n", "utf8");
  const files = under(dir, loadProjectContext(dir));
  assert.equal(files.length, 1);
  assert.equal(files[0].content, "# Rules\nuse pnpm");
});

test("a huge context file is cut on a line boundary and says so", () => {
  // Project context is re-sent with every request, so an unbounded AGENTS.md
  // is re-sent forever and the request stops fitting before the conversation
  // has said anything. Half a rule is not half the information, it is a
  // different and wrong instruction, and the prompt tells the model these are
  // rules to follow.
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), lines(20_000, "long"), "utf8");
  const [file] = under(dir, loadProjectContext(dir));

  assert.ok(file, "the file must still be loaded");
  assert.ok(
    file.content.length <= MAX_CONTEXT_FILE_CHARS,
    `kept ${file.content.length} characters against a ${MAX_CONTEXT_FILE_CHARS} budget`,
  );
  assert.match(file.content, /^long rule 0/, "the first rule must survive");
  assert.match(file.content, /\[truncated: the first [\d,]+ of [\d,]+ characters of AGENTS\.md are shown/);
  assert.ok(!/long rule 19999/.test(file.content), "the tail was not dropped silently");

  const kept = file.content.split("\n\n[truncated:")[0];
  assert.match(kept, /long rule \d+$/, `the kept text ends mid-rule: ...${kept.slice(-30)}`);
});

test("all the context files together stay inside one budget, nearest first", () => {
  const root = scratch();
  // The nearest file is small enough to be sent whole, the two above it are
  // not: that is the case the ceiling exists for.
  writeFileSync(join(root, "AGENTS.md"), lines(6_000, "root"), "utf8");
  mkdirSync(join(root, "two"), { recursive: true });
  writeFileSync(join(root, "two", "AGENTS.md"), lines(6_000, "two"), "utf8");
  mkdirSync(join(root, "two", "three"), { recursive: true });
  writeFileSync(join(root, "two", "three", "AGENTS.md"), lines(10, "three"), "utf8");

  const loaded = under(root, loadProjectContext(join(root, "two", "three")));
  const total = loaded.reduce((sum, file) => sum + file.content.length, 0);
  assert.ok(total <= MAX_TOTAL_CONTEXT_CHARS, `sent ${total} characters against ${MAX_TOTAL_CONTEXT_CHARS}`);

  // The nearest file is the one the model cannot infer, so it is the one that
  // survives whole; everything after it is cut to the room that is left.
  assert.match(loaded[0].content, /^three rule 0/);
  assert.ok(!/truncated|not sent/.test(loaded[0].content), "a file inside the budget is sent whole");
  for (const file of loaded.slice(1)) {
    assert.ok(
      /\[truncated:/.test(file.content) || /\[not sent:/.test(file.content),
      `a file that did not fit must say so: ...${file.content.slice(-60)}`,
    );
  }
});

test("a small repository is sent exactly what it wrote", () => {
  // The bounds must not appear in the prompt of an ordinary project: that is
  // the case every other test here assumes.
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), "use pnpm\nrun the tests", "utf8");
  const [file] = under(dir, loadProjectContext(dir));
  assert.equal(file.content, "use pnpm\nrun the tests");
  assert.ok(!/truncated|not sent/.test(file.content));
});

test("a path is escaped into its attribute", () => {
  // A double quote and an angle bracket are legal in a filename on every
  // platform this runs on, and either one unescaped ends the attribute early
  // and hands the model a half-parsed path.
  const slash = String.fromCharCode(92);
  const quote = String.fromCharCode(34);
  const out = formatProjectContext([{ path: `C:${slash}we"ird${slash}<dir>${slash}AGENTS.md`, content: "rules" }]);
  assert.ok(
    out.includes(`path="C:${slash}we&quot;ird${slash}&lt;dir&gt;${slash}AGENTS.md"`),
    `the path was not escaped: ${out}`,
  );
  assert.ok(!out.includes(`${quote}rules${quote}`), "the attribute closed early");
});

test("the content of a rules file reaches the model as written", () => {
  // Reformatting somebody's rules file to suit a delimiter would be a worse
  // failure than an unbalanced one.
  const tick = String.fromCharCode(96);
  const content = `1. use ${tick}pnpm${tick}\n2. see the [docs](./docs) for <details>`;
  const out = formatProjectContext([{ path: "/repo/AGENTS.md", content }]);
  assert.ok(out.includes(content), `the text was altered: ${out}`);
});
