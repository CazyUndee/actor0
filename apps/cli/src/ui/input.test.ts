import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInput } from "./input.js";

test("a lone ESC is the Escape key, not held for a next key", () => {
  const { events, rest } = parseInput("\x1b");
  assert.deepEqual(events, [{ type: "key", key: "escape" }]);
  assert.equal(rest, "");
});

test("an incomplete CSI is held until it completes", () => {
  const held = parseInput("\x1b[");
  assert.deepEqual(held.events, []);
  assert.equal(held.rest, "\x1b[", "the partial sequence is buffered");
  const done = parseInput("\x1b[A");
  assert.deepEqual(done.events, [{ type: "key", key: "up" }]);
  assert.equal(done.rest, "");
});

test("ESC followed by a printable char is Escape then the char", () => {
  const { events } = parseInput("\x1bx");
  assert.deepEqual(events, [{ type: "key", key: "escape" }, { type: "text", text: "x" }]);
});

test("a mouse wheel event parses", () => {
  const { events } = parseInput("\x1b[<64;10;5M");
  assert.deepEqual(events, [{ type: "mouse", x: 10, y: 5, button: "wheel-up", release: false }]);
});
