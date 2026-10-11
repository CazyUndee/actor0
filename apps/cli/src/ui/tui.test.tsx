import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import type { ModelClient } from "@actor0/harness";
import { App } from "./App.js";
import { addProvider, withModel } from "../config.js";
import type { Screen } from "./term.js";

const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** A Screen that records the grids it is asked to draw. */
class FakeScreen {
  size = { rows: 24, cols: 80 };
  grids: string[][] = [];
  carets: { row: number; col: number }[] = [];
  render(grid: string[]): void {
    this.grids.push(grid);
  }
  caret(row: number, col: number): void {
    this.carets.push({ row, col });
  }
  hideCaret(): void {}
  setSize(rows: number, cols: number): void {
    this.size = { rows, cols };
  }
  dispose(): void {}
  get last(): string[] {
    return this.grids.at(-1) ?? [];
  }
}

function fakeStdin(): PassThrough {
  const s = new PassThrough();
  Object.assign(s, { isTTY: true, columns: 80, rows: 24, setRawMode() { return s; }, ref() { return s; }, unref() { return s; } });
  return s;
}

function config(): ReturnType<typeof addProvider> {
  // api-key, not oauth: an oauth provider makes the first turn try a network
  // token refresh, which would hang the test.
  return addProvider(withModel({ model: "example-model", models: ["example-model"] }, "example-model"), {
    name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k",
    model: "claude-opus-4-6",
  });
}

async function mount(opts: { transport?: ModelClient; onExit?: () => void } = {}): Promise<{ screen: FakeScreen; stdin: PassThrough; unmount: () => void; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "actor0-tui-"));
  const prev = process.env.ACTOR0_CONFIG_DIR;
  process.env.ACTOR0_CONFIG_DIR = dir;
  const screen = new FakeScreen();
  const stdin = fakeStdin();
  const sink = new PassThrough();
  sink.resume();
  const instance = render(
    createElement(App, {
      cwd: process.cwd(),
      config: config(),
      version: "9.9.9",
      screen: screen as unknown as Screen,
      stdin: stdin as unknown as NodeJS.ReadStream,
      onExit: opts.onExit ?? (() => {}),
      ...(opts.transport ? { transport: opts.transport } : {}),
    }),
    { stdin: sink as never, stdout: sink as never, exitOnCtrlC: false, patchConsole: false },
  );
  await tick(120);
  return {
    screen,
    stdin,
    unmount: () => {
      instance.unmount();
      if (prev === undefined) delete process.env.ACTOR0_CONFIG_DIR;
      else process.env.ACTOR0_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
    dir,
  };
}

test("the frame draws: titled top border, header, composer, disclaimer, bottom border", async () => {
  const { screen, unmount } = await mount();
  try {
    const grid = screen.last;
    assert.ok(grid[0]!.startsWith("╭") && grid[0]!.includes("actor0") && grid[0]!.includes("v9.9.9"), `top border: ${grid[0]}`);
    assert.ok(grid.at(-1)!.startsWith("╰"), "bottom border");
    assert.equal(grid.length, 24, "the frame fills the terminal exactly (alt screen, no scroll)");
    const joined = grid.join("\n");
    assert.ok(joined.includes("claude-opus-4-6"), "header shows the active model");
    assert.ok(joined.includes("Tell me to do anything") || joined.includes("❯"), "the composer prompt is present");
    assert.ok(joined.includes("Actor0 is an experimental agent"), "the disclaimer is present");
    for (const line of grid) {
      // eslint-disable-next-line no-control-regex -- strip ANSI to measure visible width
      const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(visible.length <= 80, `line wider than the terminal: ${visible.length}`);
    }
    // The right wall must survive: the frame's right border is the last
    // visible column, and a byte-length slice (the bug this guards) cuts it
    // off when colour is on. Take the line carrying the top border.
    const composerRow = grid.find((l) => l.includes("experimental agent"))!;
    // eslint-disable-next-line no-control-regex
    assert.ok(composerRow.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().endsWith("│"), "the right border is present");
  } finally {
    unmount();
  }
});

test("typing updates the composer and the caret tracks it", async () => {
  const { screen, stdin, unmount } = await mount();
  try {
    stdin.write("hello");
    await tick(250);
    assert.ok(screen.last.join("\n").includes("hello"), "the draft shows in the composer");
    const caret = screen.carets.at(-1);
    assert.ok(caret, "the caret is placed in the composer");
    assert.ok(caret!.col > 3 && caret!.col <= 12, `caret near the end of 'hello' (col ${caret!.col})`);
    // The caret must be on the input row, not the composer's top border — the
    // off-by-one that put it there made it look pinned to the box edge.
    const inputRow = screen.last.findIndex((l) => l.includes("❯"));
    assert.equal(caret!.row, inputRow + 1, `caret on the input row (row ${caret!.row}, input at ${inputRow + 1})`);
    // The caret sits *on* the character it precedes: the visible row at the
    // caret's column is the last typed char, and the col right after it is
    // where the next char will land — not one behind and not on the border.
    // eslint-disable-next-line no-control-regex
    const row = screen.last[caret!.row - 1]!.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(row[caret!.col - 2], "o", `the char before the caret is 'o' (saw '${row[caret!.col - 2]}')`);
  } finally {
    unmount();
  }
});

test("Enter submits: a turn runs with the typed text", async () => {
  let asked = "";
  const transport: ModelClient = {
    async *stream(messages) {
      const last = [...messages].reverse().find((m) => m.role === "user");
      asked = typeof last?.content === "string" ? last.content : "";
      yield { type: "token", delta: "ok" } as never;
      yield { type: "done", text: "ok", complete: true } as never;
    },
  };
  const { stdin, unmount } = await mount({ transport });
  try {
    stdin.write("ping");
    await tick(50);
    stdin.write("\r");
    await tick(9000); // the first turn spawns a shell for the environment probe
    assert.equal(asked, "ping", "the typed text reached the model");
  } finally {
    unmount();
  }
});

test("the wheel scrolls the transcript but leaves the composer's prompt in place", async () => {
  const transport: ModelClient = {
    async *stream() {
      yield { type: "token", delta: "ok" } as never;
      yield { type: "done", text: "ok", complete: true } as never;
    },
  };
  const { screen, stdin, unmount } = await mount({ transport });
  try {
    // Build a transcript taller than the viewport, then start a new draft and scroll.
    stdin.write("one");
    await tick(9000); // the first turn spawns a shell for the environment probe
    for (const word of ["two", "three", "four", "five", "six"]) {
      stdin.write(word);
      await tick(60);
      stdin.write("\r");
      await tick(400);
    }
    stdin.write("draft text");
    await tick(250);
    const beforeScroll = screen.last.join("\n");
    assert.ok(beforeScroll.includes("draft text"), "the draft is in the composer");
    for (let i = 0; i < 10; i += 1) stdin.write("\x1b[<64;1;1M"); // wheel up
    await tick(150);
    const afterScroll = screen.last.join("\n");
    assert.ok(afterScroll.includes("draft text"), "the composer's prompt survives scrolling");
    assert.notEqual(afterScroll, beforeScroll, "the transcript window scrolled");
  } finally {
    unmount();
  }
});

test("typing a slash command edits the draft and opens the menu in place", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    stdin.write("/h");
    await tick(250);
    const joined = screen.last.join("\n");
    assert.ok(joined.includes("/h"), "the typed slash text is in the composer");
    assert.ok(joined.includes("help") && joined.includes("show commands"), "the slash menu opened and lists the help command");
  } finally {
    unmount();
  }
});

test("the caret row is stable while typing on one line", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    stdin.write("a");
    await tick(40);
    stdin.write("b");
    await tick(40);
    stdin.write("c");
    await tick(150);
    const rows = screen.carets.map((c) => c.row);
    assert.ok(rows.length >= 3, "a caret event fired for each character");
    assert.equal(new Set(rows).size, 1, `the caret row did not jump: ${JSON.stringify(rows)}`);
  } finally {
    unmount();
  }
});

test("up-arrow edits the text instead of recalling history", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    stdin.write("my draft");
    await tick(150);
    stdin.write("\x1b[A"); // up arrow
    await tick(150);
    assert.ok(screen.last.join("\n").includes("my draft"), "the draft is unchanged by an up-arrow with no prior input");
  } finally {
    unmount();
  }
});

test("the provider menu lists human-readable providers and opens the add flow on 'a'", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    stdin.write("/provider");
    await tick(60);
    stdin.write("\r");
    await tick(150);
    const menu = screen.last.join("\n");
    assert.ok(menu.includes("Anthropic API - Direct"), "the provider menu shows the human-readable provider label");
    stdin.write("a");
    await tick(150);
    const add = screen.last.join("\n");
    assert.ok(add.includes("add a provider"), "pressing 'a' opens the add-provider flow");
    assert.ok(add.includes("Claude (Anthropic)") && add.includes("ChatGPT (OpenAI)"), "the add flow lists human-readable provider kinds");
  } finally {
    unmount();
  }
});

test("Ctrl+D quits", async () => {
  let exited = false;
  const { stdin, unmount } = await mount({ onExit: () => { exited = true; } });
  try {
    stdin.write("\x04");
    await tick(80);
    assert.equal(exited, true, "Ctrl+D called onExit");
  } finally {
    unmount();
  }
});
