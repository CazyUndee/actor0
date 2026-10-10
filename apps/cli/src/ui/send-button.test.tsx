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
import { installMouse, mouseLink, SEND_ROWS_ABOVE_FOOTER } from "./mouse.js";
import { App } from "./App.js";
import { addProvider, withModel } from "../config.js";

const ESC = "\x1b";
const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * The whole pipeline, end to end: real streams wrapped by installMouse, the
 * App rendered on them, a draft typed through the stdin proxy, then a left-click
 * delivered as an SGR release. It proves four things at once — that keystrokes
 * survive the mouse filter, that the screen model tracks a real frame, that a
 * click on the button reaches `submit`, and that a click elsewhere does not.
 *
 * Submission is observed by whether the turn's transport is invoked, not by
 * watching the screen repaint, so there is no frame-settling race.
 */
test("a click on the send button submits; a click elsewhere and keyboard input through the proxy both behave", async () => {
  const prev = process.env.ACTOR0_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "actor0-sendbtn-"));
  process.env.ACTOR0_CONFIG_DIR = dir;

  // Real stream stand-ins. isTTY true is mandatory: Ink throws without it, and
  // installMouse only strips mouse bytes off a TTY stdin.
  const realStdin = new EventEmitter();
  Object.assign(realStdin, {
    isTTY: true, setRawMode() { return realStdin; }, setEncoding() { return realStdin; },
    ref() { return realStdin; }, unref() { return realStdin; }, read() { return null; },
    pause() { return realStdin; }, resume() { return realStdin; },
  });
  const realStdout = new PassThrough();
  Object.assign(realStdout, { isTTY: true, columns: 80, rows: 24 });

  const mouse = installMouse(
    realStdin as unknown as NodeJS.ReadStream,
    realStdout as unknown as NodeJS.WriteStream,
  );

  let turnStarted = false;
  const transport: ModelClient = {
    // eslint-disable-next-line require-yield -- the test only needs the turn to start and stay busy; it asserts on transport invocation, not output
    async *stream() {
      turnStarted = true;
      await tick(5000); // stay "busy" for the rest of the test
    },
  };

  const config = addProvider(withModel({ model: "m", models: ["m"] }, "m"), {
    name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "oauth",
    model: "claude-opus-4-6", oauth: { accessToken: "t", plan: "max" },
  });

  const instance = render(createElement(App, { cwd: process.cwd(), config, transport }), {
    stdin: mouse.stdin, stdout: mouse.stdout, exitOnCtrlC: false, patchConsole: false,
  });

  try {
    await tick(400); // let the frame render so the screen model has the send row

    // Type "hi" through the stdin proxy — the same path the mouse filter must
    // not disturb. If the filter mangled keystrokes, the draft would be empty
    // and the click below would submit nothing, failing the assertion.
    realStdin.emit("data", "hi");
    await tick(80);

    const screen = mouseLink.screen;
    assert.ok(screen, "the stdout wrapper installed a screen model");
    const sendRow = screen!.lastContentRow() - SEND_ROWS_ABOVE_FOOTER;
    const sendY = sendRow + 1; // mouse reports are 1-based
    const sendX = mouseLink.columns - 3;

    // A click far from the button must do nothing.
    realStdin.emit("data", `${ESC}[<0;2;2m`);
    await tick(80);
    assert.equal(turnStarted, false, "a click away from the send button does not submit");

    // A click squarely on the send button submits.
    realStdin.emit("data", `${ESC}[<0;${sendX};${sendY}m`);
    await tick(120);
    assert.equal(turnStarted, true, "clicking the send button runs the turn");
  } finally {
    instance.unmount();
    mouse.dispose();
    if (prev === undefined) delete process.env.ACTOR0_CONFIG_DIR;
    else process.env.ACTOR0_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
