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
import { addProvider, setActiveProvider, withModel, type CliConfig } from "../config.js";
import { saveSession, newSessionId } from "../session.js";
import { detectEnvironment } from "../environment.js";
import type { Screen } from "./term.js";

const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Poll the last frame until `pred` holds — a fixed tick is a load flake: on a
 * busy CI box a 150 ms wait elapses before React has re-rendered, and the
 * test asserts on the frame before the input landed.
 */
const until = async (screen: { last: string[] }, pred: (joined: string) => boolean, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(screen.last.join("\n"))) return;
    await tick(50);
  }
  throw new Error(`timed out waiting for frame; last: ${JSON.stringify(screen.last.join("\n").slice(-400))}`);
};

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
  // The picker offers the *active provider's* own model list (the flat
  // `config.models` is only the fallback when no provider is active), so the
  // long list has to live on the provider entry or the picker sees one model.
  return addProvider(withModel({ model: active, models }, active), {
    name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k", model: active, models,
  });
}

async function mount(opts: { transport?: ModelClient; onExit?: () => void; cfg?: CliConfig; openSessionPicker?: boolean } = {}): Promise<{ screen: FakeScreen; stdin: PassThrough; unmount: () => void; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "actor0-tui-"));
  const prev = process.env.ACTOR0_CONFIG_DIR;
  const prevData = process.env.ACTOR0_DATA_DIR;
  process.env.ACTOR0_CONFIG_DIR = dir;
  // Sessions live in the *data* dir, not the config dir — isolating only the
  // config dir let a test's turns save into the user's real sessions, which
  // then resumed into a real conversation (the model saw "one two three four
  // five six" from the wheel-scroll test). Point the data dir at the temp too.
  process.env.ACTOR0_DATA_DIR = join(dir, "data");
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
      ...(opts.openSessionPicker ? { openSessionPicker: true } : {}),
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
      if (prevData === undefined) delete process.env.ACTOR0_DATA_DIR;
      else process.env.ACTOR0_DATA_DIR = prevData;
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
  // Warm the shell probe up front (and await it), so no turn has to spawn it —
  // otherwise the first turn's spawn is a timing dependency that flakes under
  // parallel load. This is the load flake AGENTS.md warns about.
  await detectEnvironment(process.cwd());
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

test("typing in the slash menu filters it through its search bar, in place", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    stdin.write("/");
    await until(screen, (j) => j.includes("search"), 4000);
    let joined = screen.last.join("\n");
    assert.ok(joined.includes("❯ /"), "the composer holds just the /");
    assert.ok(joined.includes("⌕") && joined.includes("search"), "the menu opened with its search bar");
    assert.ok(joined.includes("/provider"), "the first command is listed");
    assert.ok(joined.includes("more") || joined.includes("↓"), "a long command list windows like every other menu");
    // Typing lands in the menu's search input, not the composer: the fixed
    // "⌕  search" label stays put and the results filter underneath it.
    stdin.write("qu");
    await until(screen, (j) => j.includes("/quit"), 4000);
    joined = screen.last.join("\n");
    assert.ok(joined.includes("❯ /"), "the composer still holds just the /");
    assert.ok(joined.includes("qu"), "the query shows in the search input");
    assert.ok(joined.includes("/quit"), "the matching command is listed");
    assert.ok(!joined.includes("/clear"), "non-matching commands are filtered out");
    assert.equal(joined.match(/search/g)!.length, 1, "the search label is the one fixed one");
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
    assert.ok(!menu.includes("↵ Select") && !menu.includes("→ Manage"), "the bottom shortcut/help footer is removed");
    assert.ok(menu.includes("●"), "the active provider carries a status dot");
    assert.ok(menu.includes("⌕  "), "the panel has a magnifier search bar");
    assert.ok(menu.includes("❯"), "the composer stays visible under the menu");
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
    assert.ok(open.includes("search"), "the picker opened with its search bar");
    // 42 models cannot all fit: the window shows a subset and a 'more' marker.
    assert.ok(open.includes("more"), "the list is windowed, with a '↓ N more' marker");
    assert.ok(!open.includes("model-42-preview"), "the last model is off-screen until scrolled");
    // Typing filters the list to the one match.
    stdin.write("claude");
    await tick(120);
    const filtered = screen.last.join("\n");
    assert.ok(filtered.includes("claude-opus"), "the search narrowed the list");
    assert.ok(!filtered.includes("model-01-preview"), "non-matching models are filtered out");
    // Enter on the single match selects it (no turn runs).
    stdin.write("\r");
    await tick(150);
    assert.ok(!screen.last.join("\n").includes("search"), "the picker closed on selection");
  } finally {
    unmount();
  }
});

test("enter on a provider expands inline actions; escape collapses; only one at a time", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const cfg = addProvider(
    addProvider(config(), {
      name: "alpha", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k", model: "alpha-model",
    }),
    {
      name: "beta", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k", model: "beta-model",
    },
  );
  const { screen, stdin, unmount } = await mount({ transport: dummy, cfg });
  try {
    // Expanded actions make the provider block three rows; a 24-row terminal
    // would window it and hide the add entry, so give the panel room.
    screen.setSize(32, 80);
    stdin.write("/provider");
    await tick(60);
    stdin.write("\r");
    await until(screen, (j) => j.includes("Providers"));
    stdin.write("\r"); // expand the highlighted provider
    await until(screen, (j) => j.includes("Use provider"));
    let menu = screen.last.join("\n");
    assert.ok(menu.includes("Use provider") && menu.includes("Edit provider"), "enter expands the inline actions");
    assert.ok(menu.includes("Add provider"), "the menu stays open — no immediate switch");
    stdin.write("\x1b"); // escape collapses first
    await until(screen, (j) => !j.includes("Use provider"));
    menu = screen.last.join("\n");
    assert.ok(!menu.includes("Use provider"), "escape collapsed the actions without closing the menu");
    assert.ok(menu.includes("Add provider"), "the menu is still open after the collapse");
    stdin.write("\x1b[B"); // down to the second provider
    await tick(60);
    stdin.write("\r"); // expand it
    await until(screen, (j) => (j.match(/Use provider/g)?.length ?? 0) === 1);
    menu = screen.last.join("\n");
    assert.equal(menu.match(/Use provider/g)?.length ?? 0, 1, "only one provider is expanded at a time");
  } finally {
    unmount();
  }
});

test("the model picker is global across providers and selects provider and model atomically", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  let cfg = addProvider(
    addProvider(withModel({ model: "alpha-model", models: ["alpha-model"] }, "alpha-model"), {
      name: "alpha", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k", model: "alpha-model",
    }),
    {
      name: "beta", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k", model: "beta-model",
    },
  );
  cfg = setActiveProvider(cfg, "alpha"); // addProvider activates its argument; the test starts on alpha
  const { screen, stdin, unmount } = await mount({ transport: dummy, cfg });
  try {
    stdin.write("/model");
    await tick(60);
    stdin.write("\r");
    await tick(150);
    const open = screen.last.join("\n");
    assert.ok(open.includes("alpha-model") && open.includes("beta-model"), "models from every provider are offered, not just the active one");
    assert.ok(open.includes("✓"), "the selected model carries a checkmark");
    stdin.write("\x1b[B"); // down to beta-model
    await tick(80);
    stdin.write("\r");
    await tick(150);
    const after = screen.last.join("\n");
    assert.ok(!after.includes("models…"), "the picker closed on selection");
    assert.ok(after.includes("beta-model"), "the header now shows the other provider's model");
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
    // The manage screen lists details and four actions; a 24-row terminal is
    // too short for that, so give it room before opening the panel.
    screen.setSize(32, 80);
    stdin.write("/provider");
    await tick(60);
    stdin.write("\r");
    await tick(120);
    // Typing filters the provider list, like every other menu.
    stdin.write("claude");
    await tick(100);
    const providerScreen = screen.last.join("\n");
    assert.ok(providerScreen.includes("claude") && !providerScreen.includes("Search providers…"), "the provider panel filters as you type");
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

test("the usage menu carries the same search bar as every other menu", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    stdin.write("/usage");
    await tick(60);
    stdin.write("\r");
    await tick(150);
    const menu = screen.last.join("\n");
    assert.ok(menu.includes("usage"), "the usage panel is open");
    assert.ok(menu.includes("all time"), "the all-time total is listed");
    assert.ok(menu.includes("⌕") && menu.includes("search"), "the same search bar appears on every menu");
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

test("Ctrl+C arms the exit hint instead of quitting immediately", async () => {
  let exited = false;
  const { screen, stdin, unmount } = await mount({ onExit: () => { exited = true; } });
  try {
    stdin.write("\x03");
    await until(screen, (j) => j.includes("press ctrl c again to exit actor0"));
    assert.equal(exited, false, "the first Ctrl+C did not exit");
    assert.ok(screen.last.join("\n").includes("press ctrl c again to exit actor0"), "the hint is torn into the composer");
  } finally {
    unmount();
  }
});

test("Ctrl+C twice within 2s exits", async () => {
  let exited = false;
  const { stdin, unmount } = await mount({ onExit: () => { exited = true; } });
  try {
    stdin.write("\x03");
    await tick(100);
    stdin.write("\x03");
    await tick(100);
    assert.equal(exited, true, "the second Ctrl+C called onExit");
  } finally {
    unmount();
  }
});

test("/session with nothing saved says so rather than opening an empty picker", async () => {
  const { screen, stdin, unmount } = await mount();
  try {
    stdin.write("/session");
    await tick(60);
    stdin.write("\r");
    await until(screen, (j) => j.includes("no saved sessions"));
    assert.ok(screen.last.join("\n").includes("no saved sessions"), "no sessions -> a clear message, not an empty box");
  } finally {
    unmount();
  }
});

test("/session lists saved sessions and enter switches to one, wiping the context", async () => {
  const dummy: ModelClient = {
    async *stream() { yield { type: "done", text: "", complete: true } as never; },
  };
  const { screen, stdin, unmount } = await mount({ transport: dummy });
  try {
    // Seed a saved session into the isolated data dir mount() pointed the app at.
    const id = newSessionId();
    saveSession({
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: "example-model",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    });
    stdin.write("/session");
    await tick(60);
    stdin.write("\r");
    await until(screen, (j) => j.includes("sessions"), 5000);
    // The picker is open and lists the seeded session by id.
    assert.ok(screen.last.join("\n").includes(id), "the saved session is listed");
    assert.ok(screen.last.join("\n").includes("2 messages"), "its size is shown");
    // Enter switches to it: the transcript clears and the context indicator is wiped.
    stdin.write("\r");
    await until(screen, (j) => j.includes("switched to session"), 5000);
    assert.ok(screen.last.join("\n").includes("switched to session"), "a notice confirms the switch");
  } finally {
    unmount();
  }
});

test("--resume boots straight into the session picker", async () => {
  const { screen, unmount } = await mount({ openSessionPicker: true });
  try {
    // No sessions in the isolated data dir yet, so the picker opens on its
    // empty state rather than on a chat screen.
    await until(screen, (j) => j.includes("sessions"), 5000);
    assert.ok(screen.last.join("\n").includes("no saved sessions"), "the picker is open, in its empty state");
  } finally {
    unmount();
  }
});
