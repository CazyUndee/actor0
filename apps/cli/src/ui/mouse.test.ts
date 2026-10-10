import assert from "node:assert/strict";
import { test } from "node:test";
import { filterMouseChunk, SEND_ROWS_ABOVE_FOOTER, SEND_X_MARGIN } from "./mouse.js";

const ESC = "\x1b";

test("a left-button release inside the buffer becomes a click and is stripped from the keystrokes", () => {
  const { inkText, clicks, hold } = filterMouseChunk(`${ESC}[<0;12;40m`);
  assert.deepEqual(clicks, [{ x: 12, y: 40 }], "release at (12,40) is one click");
  assert.equal(inkText, "", "the mouse report is not forwarded to Ink");
  assert.equal(hold, "");
});

test("a press (M) is not a click — only a completed release submits", () => {
  const { clicks } = filterMouseChunk(`${ESC}[<0;12;40M`);
  assert.deepEqual(clicks, [], "press must not submit by itself");
});

test("middle and right button releases are not clicks", () => {
  assert.deepEqual(filterMouseChunk(`${ESC}[<1;12;40m`).clicks, [], "middle button");
  assert.deepEqual(filterMouseChunk(`${ESC}[<2;12;40m`).clicks, [], "right button");
});

test("the wheel and drag reports are ignored as clicks", () => {
  assert.deepEqual(filterMouseChunk(`${ESC}[<64;12;40m`).clicks, [], "wheel up");
  assert.deepEqual(filterMouseChunk(`${ESC}[<32;12;40M`).clicks, [], "drag motion");
});

test("the wheel reports a scroll delta and is stripped from the keystrokes", () => {
  const up = filterMouseChunk(`${ESC}[<64;1;1M`);
  assert.equal(up.scroll, 1, "wheel up is +1 notch");
  assert.equal(up.inkText, "", "wheel bytes are not typed into the composer");
  const down = filterMouseChunk(`${ESC}[<65;1;1M`);
  assert.equal(down.scroll, -1, "wheel down is -1 notch");
  // Several wheel turns in one chunk accumulate.
  assert.equal(filterMouseChunk(`${ESC}[<64;1;1M${ESC}[<64;1;1M${ESC}[<65;1;1M`).scroll, 1);
});

test("keystrokes around a click survive; only the mouse bytes are removed", () => {
  const { inkText, clicks } = filterMouseChunk(`hello${ESC}[<0;70;40m!`);
  assert.equal(inkText, "hello!", "the typed text is exactly what Ink should receive");
  assert.deepEqual(clicks, [{ x: 70, y: 40 }]);
});

test("arrow keys are forwarded whole and never mistaken for a click", () => {
  // 'ESC [ A' must reach Ink intact; the partial-CSI guard must not eat its 'A'.
  const { inkText, clicks, hold } = filterMouseChunk(`${ESC}[A`);
  assert.equal(inkText, `${ESC}[A`);
  assert.deepEqual(clicks, []);
  assert.equal(hold, "");
});

test("a lone ESC (the Escape key) is forwarded immediately, never held", () => {
  const { inkText, hold } = filterMouseChunk(ESC);
  assert.equal(inkText, ESC, "a bare ESC has no '[', so the partial guard does not apply");
  assert.equal(hold, "");
});

test("a mouse report split across chunks is held until it completes", () => {
  const first = filterMouseChunk(`${ESC}[<0;12;`);
  assert.equal(first.inkText, "", "an incomplete report forwards nothing");
  assert.equal(first.hold, `${ESC}[<0;12;`, "the partial tail is held for the next chunk");
  assert.deepEqual(first.clicks, []);
  const second = filterMouseChunk(`${first.hold}40m`);
  assert.deepEqual(second.clicks, [{ x: 12, y: 40 }], "reassembled, it is a click");
  assert.equal(second.inkText, "");
});

test("the layout constants the hit-test relies on are the measured ones", () => {
  // screen-model.test.ts measures these against the real UI; this pins them so
  // a stray edit to either number fails here rather than at a click.
  assert.equal(SEND_ROWS_ABOVE_FOOTER, 4);
  assert.equal(SEND_X_MARGIN, 12);
});
