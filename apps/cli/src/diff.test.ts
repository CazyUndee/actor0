import assert from "node:assert/strict";
import { test } from "node:test";
import { editDiffLines, formatEditDiff, parseDiffBlock } from "./diff.js";

/**
 * The edit diff. An exact-string edit is its own diff — the matched text is
 * removed, the replacement added, at a known line — so this checks the line
 * math and the round-trip through the fenced block the tool returns.
 */

const FILE = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");

test("a replacement is a remove of the old and an add of the new, in place", () => {
  const lines = editDiffLines(FILE, "three", "THREE");
  const kinds = lines.map((line) => line.kind);
  // "three" is line 2, so only two context lines exist before it and three after.
  assert.deepEqual(kinds, ["context", "context", "remove", "add", "context", "context", "context"]);
  assert.equal(lines.find((l) => l.kind === "remove")!.text, "three");
  assert.equal(lines.find((l) => l.kind === "add")!.text, "THREE");
  assert.equal(lines.filter((l) => l.kind === "context" && l.text === "one").length, 1);
});

test("a deletion removes lines and adds none", () => {
  const lines = editDiffLines(FILE, "four\nfive", "");
  assert.deepEqual(lines.filter((l) => l.kind === "remove").map((l) => l.text), ["four", "five"]);
  assert.equal(lines.filter((l) => l.kind === "add").length, 0);
});

test("context is capped near the edges of the file", () => {
  // Changing the first line cannot show three lines before it.
  const lines = editDiffLines(FILE, "one", "ONE");
  assert.equal(lines[0]!.kind, "remove");
  assert.equal(lines[0]!.text, "one");
});

test("a multi-line replacement keeps every added and removed line", () => {
  const lines = editDiffLines(FILE, "three\nfour", "3\n4\n5");
  assert.deepEqual(lines.filter((l) => l.kind === "remove").map((l) => l.text), ["three", "four"]);
  assert.deepEqual(lines.filter((l) => l.kind === "add").map((l) => l.text), ["3", "4", "5"]);
});

test("an absent match is an empty diff, not a wrong one", () => {
  assert.deepEqual(editDiffLines(FILE, "nope", "x"), []);
  assert.equal(formatEditDiff(FILE, "nope", "x"), "");
});

test("the fenced block round-trips through parseDiffBlock", () => {
  const fenced = formatEditDiff(FILE, "three", "THREE");
  assert.match(fenced, /^```diff\n/, "fenced for the model to read");
  const parsed = parseDiffBlock(fenced);
  const direct = editDiffLines(FILE, "three", "THREE");
  assert.deepEqual(parsed, direct, "what the renderer parses is what the tool produced");
});

test("parseDiffBlock is empty when there is no diff fence", () => {
  assert.deepEqual(parseDiffBlock("Edited file.ts (1 occurrence replaced)."), []);
});

test("content that itself starts with + or - survives inside the fence", () => {
  // A code line beginning with `-` must be read by its gutter sign, not mistaken
  // for a removal just because the text starts with a dash.
  const lines = parseDiffBlock("```diff\n+-not a removal\n+also fine\n```");
  assert.deepEqual(lines.map((l) => l.kind), ["add", "add"]);
  assert.equal(lines[0]!.text, "-not a removal");
});
