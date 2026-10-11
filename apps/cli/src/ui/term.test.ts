import assert from "node:assert/strict";
import { test } from "node:test";
import { Screen } from "./term.js";

/** A stream that records everything written, with a fixed size. */
function recorder(rows = 4, cols = 10): { chunks: string[]; stream: NodeJS.WriteStream } {
  const chunks: string[] = [];
  const stream = {
    columns: cols,
    rows,
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { chunks, stream };
}

test("render positions each row explicitly and never joins lines with CR/LF", () => {
  const { chunks, stream } = recorder();
  const screen = new Screen(stream);
  screen.render(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"]);
  const out = chunks.join("");
  // The bug this guards: lines are exactly `cols` wide, so writing the last
  // column leaves the terminal in pending-wrap; a CR/LF after it realises the
  // wrap, skips a row, and the frame scrolls — duplicating the bottom. Every
  // row must instead be placed with an explicit CUP, which discards the wrap.
  assert.ok(!out.includes("\r\n"), "no CR/LF between rows");
  assert.ok(!out.includes("\n"), "no bare LF between rows");
  for (let r = 1; r <= 4; r += 1) assert.ok(out.includes(`\x1b[${r};1H`), `row ${r} is positioned with a CUP`);
});

test("render erases each row before writing it", () => {
  const { chunks, stream } = recorder();
  const screen = new Screen(stream);
  screen.render(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"]);
  const out = chunks.join("");
  // eslint-disable-next-line no-control-regex -- matching the erase-line escape
  assert.equal((out.match(/\x1b\[2K/g) ?? []).length, 4, "each row is erased (2K)");
});

test("caret is clamped to the screen and shows the cursor", () => {
  const { chunks, stream } = recorder();
  const screen = new Screen(stream);
  screen.caret(99, 99);
  assert.ok(chunks.join("").includes("\x1b[4;10H"), "the caret is clamped to the last cell");
  assert.ok(chunks.join("").includes("\x1b[?25h"), "the caret is made visible");
});
