import assert from "node:assert/strict";
import { test } from "node:test";
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
 * A real readable stream, because Ink reads stdin through the paused
 * 'readable' + `read()` protocol and the mouse filter wraps `read()` — a plain
 * EventEmitter never emits 'readable' and would leave Ink with no input, which
 * is not what a TTY does. The TTY-only members Ink checks are added on top.
 */
function makeStdin(): NodeJS.ReadStream {
  const s = new PassThrough();
  Object.assign(s, { isTTY: true, columns: 80, rows: 24, setRawMode() { return s; }, ref() { return s; }, unref() { return s; } });
  return s as unknown as NodeJS.ReadStream;
}

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
  // the filter only strips mouse bytes off a TTY stdin.
  const realStdin = makeStdin();
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

    // Type "hi" through the stream — the same path the mouse filter must not
    // disturb. If the filter mangled keystrokes, the draft would be empty and
    // the click below would submit nothing, failing the assertion.
    realStdin.write("hi");
    await tick(80);

    const screen = mouseLink.screen;
    assert.ok(screen, "the stdout wrapper installed a screen model");
    const sendRow = screen!.lastContentRow() - SEND_ROWS_ABOVE_FOOTER;
    const sendY = sendRow + 1; // mouse reports are 1-based
    const sendX = mouseLink.columns - 3;

    // A click far from the button must do nothing.
    realStdin.write(`${ESC}[<0;2;2m`);
    await tick(80);
    assert.equal(turnStarted, false, "a click away from the send button does not submit");

    // A click squarely on the send button submits.
    realStdin.write(`${ESC}[<0;${sendX};${sendY}m`);
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

/**
 * The composer is clamped to the bottom and the wheel scrolls only the
 * transcript above it. Builds a real transcript through the send button, then
 * scrolls up hard and checks two invariants that are the whole feature: the
 * composer's rows do not move, and the transcript window's contents do.
 */
test("wheel scroll moves the transcript window but never the pinned composer", async () => {
  const prev = process.env.ACTOR0_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "actor0-scroll-"));
  process.env.ACTOR0_CONFIG_DIR = dir;

  const realStdin = makeStdin();
  const realStdout = new PassThrough();
  Object.assign(realStdout, { isTTY: true, columns: 80, rows: 24 });
  const mouse = installMouse(
    realStdin as unknown as NodeJS.ReadStream,
    realStdout as unknown as NodeJS.WriteStream,
  );

  let answer = "";
  const transport: ModelClient = {
    async *stream() {
      for (const ch of answer) yield { type: "token", delta: ch } as never;
      yield { type: "done", text: answer, complete: true } as never;
    },
  };
  const config = addProvider(withModel({ model: "m", models: ["m"] }, "m"), {
    name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "oauth",
    model: "claude-opus-4-6", oauth: { accessToken: "t", plan: "max" },
  });
  const instance = render(createElement(App, { cwd: process.cwd(), config, transport }), {
    stdin: mouse.stdin, stdout: mouse.stdout, exitOnCtrlC: false, patchConsole: false,
  });

  const screen = mouseLink.screen!;
  const sendClick = async (): Promise<void> => {
    const y = screen.lastContentRow() - SEND_ROWS_ABOVE_FOOTER + 1;
    const x = mouseLink.columns - 3;
    realStdin.write(`${ESC}[<0;${x};${y}m`);
  };

  try {
    await tick(400);
    // Build a transcript taller than the 24-row terminal, via the send button.
    for (let n = 1; n <= 6; n++) {
      answer = `answer ${n}: ${"word ".repeat(40)}`;
      realStdin.write(`q${n}`);
      await tick(40);
      await sendClick();
      await tick(140);
    }

    const sendRowBefore = screen.lines().findIndex((l) => l.includes("enter to send"));
    const footerBefore = screen.lastContentRow();
    const topBefore = screen.lines().filter((l) => l.trim()).slice(0, 2).join("\n");

    for (let i = 0; i < 25; i++) { realStdin.write(`${ESC}[<64;1;1M`); await tick(4); }
    await tick(150);

    const sendRowAfter = screen.lines().findIndex((l) => l.includes("enter to send"));
    const footerAfter = screen.lastContentRow();
    const topAfter = screen.lines().filter((l) => l.trim()).slice(0, 2).join("\n");

    assert.ok(sendRowBefore >= 0, "the composer rendered");
    assert.equal(sendRowAfter, sendRowBefore, "the composer's send row did not move under scroll");
    assert.equal(footerAfter, footerBefore, "the footer stayed on the terminal's last row");
    assert.notEqual(topAfter, topBefore, "the transcript window scrolled to show earlier content");
  } finally {
    instance.unmount();
    mouse.dispose();
    if (prev === undefined) delete process.env.ACTOR0_CONFIG_DIR;
    else process.env.ACTOR0_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Quitting goes through the same native stdin the mouse filter now leaves in
 * place. This is the regression that mattered: an earlier versions of the mouse
 * layer replaced stdin with a look-alike to strip mouse bytes, and that broke
 * raw mode and every keyboard path — typing and quitting both. Ctrl+C/Ctrl+D
 * must still exit. Ctrl+C first cancels a running turn and exits only when
 * there is nothing to cancel, so this quits from idle with Ctrl+D.
 */
test("Ctrl+D quits through the mouse-wrapped streams", async () => {
  const prev = process.env.ACTOR0_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "actor0-quit-"));
  process.env.ACTOR0_CONFIG_DIR = dir;

  const realStdin = makeStdin();
  const realStdout = new PassThrough();
  Object.assign(realStdout, { isTTY: true, columns: 80, rows: 24 });
  const mouse = installMouse(
    realStdin as unknown as NodeJS.ReadStream,
    realStdout as unknown as NodeJS.WriteStream,
  );
  const transport: ModelClient = { async *stream() {} };
  const config = addProvider(withModel({ model: "m", models: ["m"] }, "m"), {
    name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "oauth",
    model: "claude-opus-4-6", oauth: { accessToken: "t", plan: "max" },
  });
  const instance = render(createElement(App, { cwd: process.cwd(), config, transport }), {
    stdin: mouse.stdin, stdout: mouse.stdout, exitOnCtrlC: false, patchConsole: false,
  });

  try {
    await tick(350);
    realStdin.write("\x04"); // Ctrl+D
    const outcome = await Promise.race([
      instance.waitUntilExit().then(() => "exited" as const),
      tick(1000).then(() => "stuck" as const),
    ]);
    assert.equal(outcome, "exited", "Ctrl+D exits the app — quitting is not broken");
  } finally {
    instance.unmount();
    mouse.dispose();
    if (prev === undefined) delete process.env.ACTOR0_CONFIG_DIR;
    else process.env.ACTOR0_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
