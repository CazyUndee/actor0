import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "./markdown.js";
import type { Seg } from "./render.js";

/** Join rendered rows to plain visible text (no escapes), for assertions. */
function text(rows: Seg[][]): string {
  return rows.map((r) => r.map((s) => s.text).join("")).join("\n");
}
/** True if any segment in the rows carries a style. */
function styled(rows: Seg[][], pick: (s: Seg) => boolean): boolean {
  return rows.some((r) => r.some(pick));
}

const COLS = 80;

test("inline bold, italic, code and links are styled, not left as literal markers", () => {
  const rows = renderMarkdown("This is **bold**, *italic*, `code` and a [link](http://x).", COLS);
  assert.ok(styled(rows, (s) => s.bold === true), "bold is painted");
  assert.ok(styled(rows, (s) => s.dim === true), "italic is de-emphasised");
  assert.ok(styled(rows, (s) => s.bg !== undefined), "inline code has a background");
  assert.ok(styled(rows, (s) => s.color !== undefined && s.text === "link"), "the link label is coloured");
  const out = text(rows);
  assert.ok(!out.includes("**") && !out.includes("`") && !out.includes("]("), "no literal markdown markers survive");
});

test("a fenced code block keeps its lines and is never word-wrapped", () => {
  const code = "```bash\nnpm install && npm run build --workspace @actor0/cli\n```";
  const rows = renderMarkdown(code, COLS);
  const out = text(rows);
  assert.ok(out.includes("npm install && npm run build --workspace @actor0/cli"), "the command is one unwrapped row");
  assert.ok(out.includes("```bash"), "the opening fence is shown");
});

test("an unterminated fence is code to the end (the streaming case)", () => {
  const rows = renderMarkdown("text\n```js\nconst x = 1;", COLS);
  const out = text(rows);
  assert.ok(out.includes("const x = 1;"), "the partial code body is shown, not wrapped as prose");
});

test("a table renders as an aligned grid with a styled header", () => {
  const md = "| Tool | Purpose |\n| --- | --- |\n| read | open a file |\n| bash | run a command |";
  const rows = renderMarkdown(md, COLS);
  const out = text(rows);
  assert.ok(out.includes("| read"), "cells keep their column bars");
  assert.ok(styled(rows, (s) => s.bold === true), "the header row is bold");
  assert.ok(!out.split("\n")[0]!.includes("---"), "the delimiter row is not the first line");
});

test("headings, lists, quotes and rules are styled", () => {
  const md = "# Title\n\n- one\n- two\n\n> quoted\n\n---";
  const rows = renderMarkdown(md, COLS);
  assert.ok(styled(rows, (s) => s.bold === true && s.text.includes("Title")), "the heading is bold");
  assert.ok(styled(rows, (s) => s.text.includes("•")), "list items get a bullet");
  assert.ok(styled(rows, (s) => s.text.startsWith("│ ")), "a quote gets a bar");
  assert.ok(styled(rows, (s) => s.text.startsWith("───")), "a rule is drawn");
});

test("long prose wraps to the width and drops no words", () => {
  const md = "word ".repeat(60).trim();
  const rows = renderMarkdown(md, COLS);
  assert.ok(rows.length > 1, "the paragraph wrapped onto several rows");
  for (const r of rows) assert.ok(r.reduce((n, s) => n + s.text.length, 0) <= COLS - 4, "no row exceeds the width");
  // Join and collapse whitespace: the wrap keeps a trailing space at each break,
  // which is fine on screen — what matters is no word is dropped.
  assert.equal(text(rows).replace(/\s+/g, " ").trim(), md.replace(/\s+/g, " ").trim(), "no words are lost across the wrap");
});
