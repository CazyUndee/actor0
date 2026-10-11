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
import { addProvider, withModel, type CliConfig } from "../config.js";
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

/** A config with a long model list, so the picker's window and search show. */
function manyModels(): CliConfig {
  const models = Array.from({ length: 42 }, (_, i) => `example-provider/model-${String(i + 1).padStart(2, "0")}-preview`);
  models[3] = "example-provider/claude-opus-4-6";
  const active = models[3]!;
  return addProvider(withModel({ model: active, models }, active), {
    name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k", model: active,
  });
}

async function mount(opts: { transport?: ModelClient; onExit?: () => void; cfg?: CliConfig } = {}): Promise<{ screen: FakeScreen; stdin: PassThrough; unmount: () => void; dir: string }> {
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
      config: opts.cfg ?? config(),
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

test("typing updates the composer", async () => {
  const { screen, stdin, unmount } = await mount();
  try {
    stdin.write("hello");
    await tick(250);
    // The draft shows in the composer, in order — the reordering-under-batch bug
    // is what this guards. (The block cursor itself is pinned in render.test.ts,
    // where the background fill survives; tests run with colour off.)
    assert.ok(screen.last.join("\n").includes("❯ hello"), "the draft shows in the composer, in order");
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
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    // Run several turns to build a transcript taller than the viewport. Wait
    // for each to settle by polling the composer back to idle, not a fixed
    // delay: the first turn spawns the environment probe, so under parallel
    // load a fixed wait lets the next submit be refused as busy and the
    // transcript never grows tall enough to scroll (a load flake).
    for (const word of ["one", "two", "three", "four", "five", "six"]) {
      stdin.write(word);
      await tick(60);
      stdin.write("\r");
      // The composer's own glyph is "·" while a turn runs and "❯" when idle.
      for (let i = 0; i < 40; i += 1) {
        await tick(200);
        const composer = screen.last.join("\n").split("\n").slice(-4).join("\n");
        if (composer.includes("❯")) break;
      }
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

test("the draft keeps its order under fast batched input", async () => {
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
    // The batched keystrokes must not reorder — the stale-closure-caret bug that
    // turned "great" into "rgeat". The block cursor is drawn in the grid now,
    // so we assert the composed text rather than a terminal caret position.
    assert.ok(screen.last.join("\n").includes("❯ abc"), "the draft reads abc, in order");
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

test("the provider menu is a panel with human-readable labels and an add entry", async () => {
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
    assert.ok(menu.includes("Providers"), "the menu is a titled panel");
    assert.ok(menu.includes("Anthropic API - Direct"), "the provider shows its human-readable label");
    assert.ok(menu.includes("Add provider"), "the panel offers an explicit add-provider entry");
    assert.ok(menu.includes("→ Manage"), "the panel advertises Right-arrow to manage");
    assert.ok(menu.includes("●"), "the focused row's bullet is filled");
    assert.ok(!menu.includes("❯"), "no caret pushes the rows in");
  } finally {
    unmount();
  }
});

test("the model picker windows a long list and filters it as you type", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy, cfg: manyModels() });
  try {
    stdin.write("/model");
    await tick(60);
    stdin.write("\r");
    await tick(150);
    const open = screen.last.join("\n");
    assert.ok(open.includes("choose a model"), "the picker opened");
    // 42 models cannot all fit: the window shows a subset and a 'more' marker.
    assert.ok(open.includes("more"), "the list is windowed, with a '↓ N more' marker");
    assert.ok(!open.includes("model-42-preview"), "the last model is off-screen until scrolled");
    // Typing filters the list to the one match.
    stdin.write("claude");
    await tick(120);
    const filtered = screen.last.join("\n");
    assert.ok(filtered.includes("1 match") || filtered.includes("claude-opus"), "the search narrowed the list");
    assert.ok(!filtered.includes("model-01-preview"), "non-matching models are filtered out");
    // Enter on the single match selects it (no turn runs).
    stdin.write("\r");
    await tick(150);
    assert.ok(!screen.last.join("\n").includes("choose a model"), "the picker closed on selection");
  } finally {
    unmount();
  }
});

test("the provider panel's add entry opens the add flow on enter", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    stdin.write("/provider");
    await tick(60);
    stdin.write("\r");
    await tick(120);
    stdin.write("\x1b[B"); // down onto 'Add provider'
    await tick(80);
    stdin.write("\r");
    await tick(120);
    assert.ok(screen.last.join("\n").includes("add a provider"), "enter on the add entry opened the add-provider flow");
  } finally {
    unmount();
  }
});

test("right arrow opens the manage screen for the highlighted provider", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy, cfg: manyModels() });
  try {
    stdin.write("/provider");
    await tick(60);
    stdin.write("\r");
    await tick(120);
    // Typing filters the provider list, like every other menu.
    stdin.write("claude");
    await tick(100);
    assert.ok(screen.last.join("\n").includes("search claude"), "the provider panel filters as you type");
    stdin.write("\x7f"); // backspace clears the filter
    await tick(60);
    stdin.write("\x1b[C"); // right arrow → manage the highlighted provider
    await tick(100);
    const manage = screen.last.join("\n");
    assert.ok(manage.includes("Manage provider"), "right arrow opens the manage screen");
    assert.ok(manage.includes("Change model") && manage.includes("Test connection") && manage.includes("Remove provider"), "the manage screen lists its actions");
    assert.ok(manage.includes("Endpoint"), "the manage screen shows the provider's details");
  } finally {
    unmount();
  }
});

test("the manage screen's edit action re-discovers the provider's models", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy, cfg: manyModels() });
  try {
    stdin.write("/provider");
    await tick(60);
    stdin.write("\r");
    await tick(120);
    stdin.write("\x1b[C"); // manage
    await tick(100);
    stdin.write("\x1b[B"); // down to 'Edit provider'
    await tick(60);
    stdin.write("\r");
    await tick(80);
    // It leaves the manage screen and enters the model-listing flow, whether or
    // not the network fetch then succeeds.
    const frame = screen.last.join("\n");
    assert.ok(frame.includes("listing") || !frame.includes("Manage provider"), "edit provider enters the flow");
  } finally {
    unmount();
  }
});

test("a long prompt wraps into the composer, in order", async () => {
  const { screen, stdin, unmount } = await mount();
  try {
    const long = "explain in great detail how a hash map works internally including collisions and resizing behavior";
    for (const ch of long) {
      stdin.write(ch);
      await tick(2);
    }
    await tick(200);
    // The composer grows to hold the wrapped prompt (its top border, content
    // rows and bottom border all present), the text is in order, and the tail
    // is visible — the block cursor is pinned in render.test.ts.
    const j = screen.last.join("\n");
    assert.ok(j.includes("hash map works"), "the wrapped prompt is fully visible");
    assert.ok(j.includes("resizing behavior"), "the tail of the prompt is on screen");
    assert.ok(j.includes("❯ explain in great detail"), "the prompt reads in order");
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
