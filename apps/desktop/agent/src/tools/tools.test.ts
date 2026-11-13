import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { nodeBridge } from "../native/bridge.js";
import { createToolHost } from "./host.js";
import type { ToolContext } from "./context.js";
import { within } from "./within.js";
import { runRead } from "./read.js";
import { runWrite } from "./write.js";
import { runEdit } from "./edit.js";

/**
 * The tool layer, driven against a real temporary directory through the
 * `node:fs` bridge.
 *
 * The assertions are deliberately about the contracts a *model* depends on —
 * a literal `$$`, a preserved CRLF, a continuation offset — because those are
 * the ones that fail silently: the tool returns successfully and the file on
 * disk is not what was asked for.
 */

let dir: string;
let ctx: ToolContext;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-desktop-tools-"));
  ctx = { cwd: dir, signal: new AbortController().signal, bridge: nodeBridge() };
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the read tool", () => {
  it("returns numbered lines and a continuation offset when it cuts the file", async () => {
    const lines = Array.from({ length: 2_500 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(dir, "big.txt"), lines, "utf8");
    const out = await runRead({ path: "big.txt" }, ctx);
    assert.match(out, /^\s+1\tline 1/m);
    assert.match(out, /offset=2001/);
  });

  it("refuses a binary file with a message that names the offset", async () => {
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x0a]));
    await assert.rejects(() => runRead({ path: "bin.dat" }, ctx), /is not text: a NUL byte at offset 3/);
  });

  it("lists a directory instead of failing when the path is one", async () => {
    writeFileSync(join(dir, "listing-note.txt"), "x");
    const out = await runRead({ path: "." }, ctx);
    assert.match(out, /is a directory, not a file/);
    assert.match(out, /listing-note\.txt/);
  });
});

describe("the write tool", () => {
  it("accepts an empty content string, because that is how a file is emptied", async () => {
    await runWrite({ path: "empty.txt", content: "something" }, ctx);
    const out = await runWrite({ path: "empty.txt", content: "" }, ctx);
    assert.match(out, /wrote 0 bytes/);
    // An empty file reads as a fact, not as a numbered blank line: a model
    // handed "1\t" learns nothing, and one told "empty" learns the file is.
    const read = await runRead({ path: "empty.txt" }, ctx);
    assert.match(read, /empty\.txt is empty/);
  });

  it("refuses to write outside the working directory", async () => {
    await assert.rejects(() => runWrite({ path: "../escape.txt", content: "no" }, ctx), /outside the working directory/);
  });
});

describe("the edit tool", () => {
  it("writes a replacement literally — `$$` stays `$$`", async () => {
    // `String.prototype.replace` reads `$$` in a plain-string replacement as
    // its own syntax and collapses it to `$`; split/join does not.
    const path = "literal.sh";
    await runWrite({ path, content: 'echo "pid is $$"\n' }, ctx);
    await runEdit({ path, old_string: 'echo "pid is $$"', new_string: "echo \"pid is $$ and $& stays too\"" }, ctx);
    const file = await ctx.bridge.readFile(join(dir, path));
    assert.equal(file, 'echo "pid is $$ and $& stays too"\n');
  });

  it("preserves CRLF line endings instead of rewriting every line", async () => {
    const path = "crlf.txt";
    writeFileSync(join(dir, path), "one\r\ntwo\r\nthree\r\n", "utf8");
    await runEdit({ path, old_string: "two", new_string: "TWO" }, ctx);
    const file = await ctx.bridge.readFile(join(dir, path));
    assert.equal(file, "one\r\nTWO\r\nthree\r\n");
  });

  it("preserves a byte-order mark", async () => {
    const path = "bom.txt";
    writeFileSync(join(dir, path), "\uFEFFhello world\n", "utf8");
    await runEdit({ path, old_string: "world", new_string: "there" }, ctx);
    const file = await ctx.bridge.readFile(join(dir, path));
    assert.equal(file, "\uFEFFhello there\n");
  });

  it("refuses an ambiguous match and says how many there were", async () => {
    const path = "dup.txt";
    await runWrite({ path, content: "x\nx\n" }, ctx);
    await assert.rejects(() => runEdit({ path, old_string: "x", new_string: "y" }, ctx), /appears 2 times/);
    await runEdit({ path, old_string: "x", new_string: "y", replace_all: true }, ctx);
    assert.equal(await ctx.bridge.readFile(join(dir, path)), "y\ny\n");
  });

  it("says the anchor was not found rather than writing nothing", async () => {
    const path = "nope.txt";
    await runWrite({ path, content: "alpha\n" }, ctx);
    await assert.rejects(() => runEdit({ path, old_string: "beta", new_string: "gamma" }, ctx), /was not found/);
    assert.equal(await ctx.bridge.readFile(join(dir, path)), "alpha\n");
  });
});

describe("the tool host", () => {
  it("advertises every tool it implements, and refuses an unknown one by name", async () => {
    const host = createToolHost({ cwd: dir, bridge: ctx.bridge });
    const names = host.definitions().map((definition) => definition.function.name);
    for (const expected of ["read", "write", "edit", "glob", "rg", "shell", "task", "skill", "web_search"]) {
      assert.ok(names.includes(expected), `expected the host to offer ${expected}`);
    }
    await assert.rejects(
      () => host.execute({ id: "1", type: "function", function: { name: "nope", arguments: "{}" } }, ctx.signal),
      /unknown tool "nope"\. Available: read, write, edit, glob, rg, shell, task, skill, web_search/,
    );
  });

  it("rejects arguments that are not a JSON object", async () => {
    const host = createToolHost({ cwd: dir, bridge: ctx.bridge });
    await assert.rejects(
      () => host.execute({ id: "1", type: "function", function: { name: "read", arguments: "[1,2]" } }, ctx.signal),
      /arguments must be a JSON object/,
    );
  });
});

describe("containment", () => {
  it("allows a read outside the working directory but refuses a write", async () => {
    const outside = mkdtempSync(join(tmpdir(), "actor0-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "readable", "utf8");
      const read = await within(dir, join(outside, "secret.txt"), false);
      assert.ok(read.endsWith("secret.txt"));
      await assert.rejects(() => within(dir, join(outside, "secret.txt"), true), /outside the working directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
