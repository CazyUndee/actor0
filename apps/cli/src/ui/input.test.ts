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

test("terminal focus-in and focus-out reports parse as focus events", () => {
  assert.deepEqual(parseInput("\x1b[I").events, [{ type: "focus", focused: true }]);
  assert.deepEqual(parseInput("\x1b[O").events, [{ type: "focus", focused: false }]);
});

test("a mouse wheel event parses", () => {
  const { events } = parseInput("\x1b[<64;10;5M");
  assert.deepEqual(events, [{ type: "mouse", x: 10, y: 5, button: "wheel-up", release: false, drag: false }]);
});

test("a press, a drag and a release are three different events", () => {
  // The motion bit is what separates a drag from a second press. Without it
  // every cell of a drag restarted the selection, so a drag selected nothing.
  const press = parseInput("\x1b[<0;3;4M").events;
  const drag = parseInput("\x1b[<32;6;4M").events;
  const release = parseInput("\x1b[<0;6;4m").events;
  assert.deepEqual(press, [{ type: "mouse", x: 3, y: 4, button: "left", release: false, drag: false }]);
  assert.deepEqual(drag, [{ type: "mouse", x: 6, y: 4, button: "left", release: false, drag: true }]);
  assert.deepEqual(release, [{ type: "mouse", x: 6, y: 4, button: "left", release: true, drag: false }]);
});
