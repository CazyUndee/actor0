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
    assert.deepEqual(bullets[0]!.type === "list" && bullets[0]!.items.map((item) => item.text), ["one", "two"]);
    const ordered = parseMarkdown("1. one\n2. two");
    assert.equal(ordered[0]!.type === "list" && ordered[0]!.ordered, true);
  });

  it("joins an indented continuation line to its list item", () => {
    const blocks = parseMarkdown("- first line\n  continues here\n- second");
    assert.deepEqual(blocks[0]!.type === "list" && blocks[0]!.items.map((item) => item.text), [
      "first line continues here",
      "second",
    ]);
  });

  it("nests a deeper marker under the item above it instead of merging it", () => {
    const blocks = parseMarkdown("- surfaces\n  - the bar\n  - the composer\n- other");
    const list = blocks[0]!;
    assert.equal(list.type, "list");
    if (list.type !== "list") return;
    // The child is a list of its own, not two more sentences on "surfaces".
    assert.deepEqual(list.items.map((item) => item.text), ["surfaces", "other"]);
    assert.deepEqual(list.items[0]!.children?.items.map((item) => item.text), ["the bar", "the composer"]);
    assert.equal(list.items[0]!.children?.ordered, false);
    assert.equal(list.items[1]!.children, undefined);
  });

  it("treats a tab as one level and numbers a child list of its own", () => {
    const blocks = parseMarkdown("1. install\n\t1. download\n\t2. run\n2. configure");
    const list = blocks[0]!;
    if (list.type !== "list") throw new Error("expected a list");
    assert.equal(list.ordered, true);
    assert.deepEqual(list.items.map((item) => item.text), ["install", "configure"]);
    assert.equal(list.items[0]!.children?.ordered, true);
    assert.deepEqual(list.items[0]!.children?.items.map((item) => item.text), ["download", "run"]);
  });

  it("keeps a blank line inside a list as spacing, and a level-2 child under a level-1 item", () => {
    const blocks = parseMarkdown("- one\n\n- two\n  - two a\n    - two a i");
    const list = blocks[0]!;
    if (list.type !== "list") throw new Error("expected a list");
    assert.deepEqual(list.items.map((item) => item.text), ["one", "two"]);
    const twoA = list.items[1]!.children?.items[0];
    assert.equal(twoA?.text, "two a");
    assert.equal(twoA?.children?.items[0]?.text, "two a i");
  });

  it("starts a new list when the marker changes at the same depth", () => {
    const blocks = parseMarkdown("- bullet\n1. first\n2. second");
    assert.deepEqual(blocks.map((block) => block.type), ["list", "list"]);
    assert.equal(blocks[1]!.type === "list" && blocks[1]!.ordered, true);
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
