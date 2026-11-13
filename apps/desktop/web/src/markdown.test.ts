import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inlineText, parseInline, parseMarkdown } from "./markdown";

/**
 * The markdown parser.
 *
 * The prompt tells the model that "fenced code blocks with a language tag,
 * inline code, lists, tables and headings" render, so each of those is a
 * promise this file has to keep. Two of the cases below are the ones that
 * failed silently in the CLI and are the reason the parser is a separate pure
 * module at all: an unterminated fence (the normal streaming state) and a table
 * (which loses data the moment it is re-wrapped).
 */

describe("fenced code", () => {
  it("keeps a closed fence as code, with its language tag", () => {
    const blocks = parseMarkdown("before\n\n```ts\nconst x = 1;\n```\n\nafter");
    assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "code", "paragraph"]);
    const code = blocks[1];
    assert.equal(code.type === "code" && code.lang, "ts");
    assert.equal(code.type === "code" && code.text, "const x = 1;");
    assert.equal(code.type === "code" && code.closed, true);
  });

  it("treats an unterminated fence as code, not prose — that is the streaming case", () => {
    const blocks = parseMarkdown("here you go:\n\n```bash\nnpm run build");
    assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "code"]);
    const code = blocks[1];
    // The whole point: the content that is *about* to become code is already
    // code, so it is never re-wrapped while it streams.
    assert.equal(code.type === "code" && code.text, "npm run build");
    assert.equal(code.type === "code" && code.closed, false);
    assert.equal(code.type === "code" && code.lang, "bash");
  });

  it("does not end a fence on a different marker length", () => {
    const blocks = parseMarkdown("````\n```\ninner\n```\n````");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.type === "code" && blocks[0]!.text, "```\ninner\n```");
  });

  it("supports the tilde fence too", () => {
    const blocks = parseMarkdown("~~~\nplain\n~~~");
    assert.equal(blocks[0]!.type === "code" && blocks[0]!.text, "plain");
  });
});

describe("tables", () => {
  it("parses a table into a header and rows, and never re-wraps it", () => {
    const source = "| tool | time |\n| --- | ---: |\n| build | 20s |\n| test | 1.2s |";
    const blocks = parseMarkdown(source);
    assert.equal(blocks.length, 1);
    const table = blocks[0]!;
    assert.equal(table.type, "table");
    assert.deepEqual(table.type === "table" && table.header, ["tool", "time"]);
    assert.deepEqual(table.type === "table" && table.rows, [
      ["build", "20s"],
      ["test", "1.2s"],
    ]);
  });

  it("keeps a row's value attached to its own row — the data-loss case", () => {
    const blocks = parseMarkdown("| a | b |\n| - | - |\n| one | two |");
    const table = blocks[0]!;
    // In the CLI, wrapping this as prose printed `two` on a row of its own and
    // left the reader to guess which column it belonged to.
    assert.deepEqual(table.type === "table" && table.rows[0], ["one", "two"]);
  });

  it("handles a table without leading or trailing pipes", () => {
    const blocks = parseMarkdown("a | b\n--- | ---\n1 | 2");
    assert.equal(blocks[0]!.type, "table");
    assert.deepEqual(blocks[0]!.type === "table" && blocks[0]!.header, ["a", "b"]);
  });

  it("does not mistake prose containing a pipe for a table", () => {
    const blocks = parseMarkdown("use a | b to pipe\n\nand that is all");
    assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "paragraph"]);
  });
});

describe("other blocks", () => {
  it("parses headings at every level", () => {
    const blocks = parseMarkdown("# one\n## two\n###### six");
    assert.deepEqual(blocks.map((block) => (block.type === "heading" ? block.level : -1)), [1, 2, 6]);
  });

  it("parses bullet and ordered lists", () => {
    const bullets = parseMarkdown("- one\n- two");
    assert.equal(bullets[0]!.type === "list" && bullets[0]!.ordered, false);
    assert.deepEqual(bullets[0]!.type === "list" && bullets[0]!.items, ["one", "two"]);
    const ordered = parseMarkdown("1. one\n2. two");
    assert.equal(ordered[0]!.type === "list" && ordered[0]!.ordered, true);
  });

  it("joins an indented continuation line to its list item", () => {
    const blocks = parseMarkdown("- first line\n  continues here\n- second");
    assert.deepEqual(blocks[0]!.type === "list" && blocks[0]!.items, ["first line continues here", "second"]);
  });

  it("parses a blockquote spanning several lines", () => {
    const blocks = parseMarkdown("> one\n> two");
    assert.equal(blocks[0]!.type === "quote" && blocks[0]!.text, "one\ntwo");
  });

  it("parses a horizontal rule", () => {
    assert.equal(parseMarkdown("---")[0]!.type, "rule");
  });
});

describe("inline runs", () => {
  it("parses code before emphasis, so a marker inside code stays literal", () => {
    const runs = parseInline("use `**not bold**` here");
    assert.deepEqual(runs, [
      { type: "text", text: "use " },
      { type: "code", text: "**not bold**" },
      { type: "text", text: " here" },
    ]);
  });

  it("parses bold, italic and links", () => {
    assert.deepEqual(parseInline("**b**"), [{ type: "strong", text: "b" }]);
    assert.deepEqual(parseInline("*i*"), [{ type: "em", text: "i" }]);
    assert.deepEqual(parseInline("[x](https://y)"), [{ type: "link", text: "x", href: "https://y" }]);
  });

  it("leaves an unclosed marker as the characters the model actually wrote", () => {
    // A streamed half-written `**bold` must not render as an empty strong run.
    assert.equal(inlineText(parseInline("**bold")), "**bold");
    assert.equal(inlineText(parseInline("`code")), "`code");
  });
});
