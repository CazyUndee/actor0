import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import type { ModelClient } from "@actor0/harness";
import { ScreenModel } from "./screen-model.js";
import { App } from "./App.js";
import { addProvider, withModel } from "../config.js";

test("feed tracks rows and finds the last one with content", () => {
  const screen = new ScreenModel(10, 40);
  screen.feed("one\n");
  screen.feed("two\n");
  screen.feed("three\n");
  screen.feed("\n");
  screen.feed("four\n");
  assert.equal(screen.lines()[0], "one");
  assert.equal(screen.lastContentRow(), 4, "the trailing blank row is not content");
});

test("feed buffers an escape sequence split across chunks", () => {
  const screen = new ScreenModel(5, 20);
  // A CSI split so that '\x1b[2' arrives first — it must not be written as text.
  screen.feed("abc\x1b[2");
  screen.feed("K"); // completes ESC[2K, which erases the whole line
  screen.feed("DEF"); // the cursor sat at col 3, so DEF lands after three blanks
  assert.equal(screen.lines()[0], "   DEF", "the split CSI was one sequence, not text plus junk");
  assert.ok(!screen.lines()[0].includes("\x1b"), "no raw ESC leaked into the grid");
});

test("erase-in-line (2K) clears the row so stale content cannot linger", () => {
  const screen = new ScreenModel(5, 30);
  screen.feed("STALE ROW\n");
  screen.feed("\x1b[A\r\x1b[2K"); // move up, home, erase line
  assert.equal(screen.lines()[0], "");
  screen.feed("FRESH\n");
  assert.equal(screen.lines()[0], "FRESH");
});

/**
 * The load-bearing one. `SEND_ROWS_ABOVE_FOOTER` is a magic number the mouse
 * hit-test depends on, and it is measured here against the real UI rather than
 * asserted: render the actual App, feed Ink's real output through the model, and
 * check the send button sits exactly four rows above the last row of the frame.
 * If the composer or status bar changes height, this fails and the constant must
 * move with it — which is the whole point.
 */
test("the send button is exactly four rows above the frame's last row, measured on the real UI", async () => {
  const prev = process.env.ACTOR0_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "actor0-screen-test-"));
  process.env.ACTOR0_CONFIG_DIR = dir;
  try {
    const config = addProvider(withModel({ model: "m", models: ["m"] }, "m"), {
      name: "claude",
      baseUrl: "https://api.anthropic.com",
      transport: "anthropic",
      auth: "oauth",
      model: "claude-opus-4-6",
      oauth: { accessToken: "t", plan: "max" },
    });
    const transport = { async *stream() {} } as unknown as ModelClient;

    const screen = new ScreenModel(24, 80);
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => screen.feed(c.toString("utf8")));
    Object.assign(stdout, { columns: 80, rows: 24 });
    // A stand-in TTY: Ink throws without isTTY, and the composer only renders
    // when it is not in onboarding (a provider is configured above).
    const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & EventEmitter;
    Object.assign(stdin, { isTTY: true, setRawMode() { return stdin; }, setEncoding() { return stdin; }, ref() { return stdin; }, unref() { return stdin; }, read() { return null; }, pause() { return stdin; }, resume() { return stdin; } });

    const instance = render(createElement(App, { cwd: process.cwd(), config, transport }), {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((res) => setTimeout(res, 400));
    instance.unmount();

    const sendRow = screen.lines().findIndex((line) => line.includes("enter to send"));
    const last = screen.lastContentRow();
    assert.ok(sendRow >= 0, "the composer's send row rendered");
    assert.ok(last >= 0, "the frame had content");
    assert.equal(last - sendRow, 4, "send button is four rows above the frame's last row (the footer)");
    // The composer is clamped to the bottom: the frame's last row is the
    // terminal's second-to-last row (the frame is one row short of the screen,
    // so ink never emits the trailing newline that would scroll it), so the
    // status bar sits on row `rows-2` and the scroll window fills everything
    // above it. This is the pin the wheel scroll relies on — a composer that
    // drifted with the transcript could not be hit by a fixed offset.
    assert.equal(last, 22, "the footer is at rows-2 — the composer is bottom-pinned, the frame one row short of the screen");
  } finally {
    if (prev === undefined) delete process.env.ACTOR0_CONFIG_DIR;
    else process.env.ACTOR0_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
