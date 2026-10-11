/**
 * Drive the real TUI without a human and without a provider, and print frames.
 *
 * The UI is our own renderer now, so a frame is just the grid the App hands the
 * Screen. This mounts the real App on a capturing screen, drives it with the
 * same raw input a terminal would send, and prints what each state looks like —
 * the way to see the running UI without a TTY.
 */
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import type { ModelClient } from "@actor0/harness";
import { App } from "../src/ui/App.js";
import { addProvider, withModel, type CliConfig } from "../src/config.js";
import type { Screen } from "../src/ui/term.js";
import { detectEnvironment } from "../src/environment.js";

const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

class Capture {
  size = { rows: 24, cols: 80 };
  grid: string[] = [];
  render(g: string[]): void {
    this.grid = g;
  }
  caret(): void {}
  hideCaret(): void {}
  setSize(): void {}
  dispose(): void {}
}

function config(): CliConfig {
  return addProvider(withModel({ model: "example-model", models: ["example-model", "other-model"] }, "example-model"), {
    name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "demo", model: "claude-opus-4-6",
  });
}

const transport: ModelClient = {
  async *stream() {
    const words = "Here is a short answer about the repository and what the CLI does.".split(" ");
    for (const w of words) {
      yield { type: "token", delta: `${w} ` } as never;
      await tick(30);
    }
    yield { type: "done", text: "", complete: true } as never;
  },
};

async function main(): Promise<void> {
  // Warm the shell probe so the first turn is not the thing that stalls.
  void detectEnvironment(process.cwd());

  const prev = process.env.ACTOR0_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "actor0-preview-"));
  process.env.ACTOR0_CONFIG_DIR = dir;

  const screen = new Capture();
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, columns: 80, rows: 24, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const sink = new PassThrough();
  sink.resume();
  let quit = false;
  const instance = render(
    createElement(App, {
      cwd: process.cwd(),
      config: config(),
      version: "0.1.1",
      screen: screen as unknown as Screen,
      stdin: stdin as unknown as NodeJS.ReadStream,
      onExit: () => { quit = true; },
      transport,
    }),
    { stdin: sink as never, stdout: sink as never, exitOnCtrlC: false, patchConsole: false },
  );

  const show = async (label: string): Promise<void> => {
    await tick(120);
    console.log(`\n===== ${label} =====`);
    console.log(screen.grid.join("\n"));
  };
  const type = async (text: string): Promise<void> => {
    for (const ch of text) {
      stdin.write(ch);
      await tick(10);
    }
  };

  await show("1 · empty composer, idle face");
  await type("what is in the README?");
  await show("2 · typed a draft, sendable face");
  await type("\r");
  await tick(200);
  await show("3 · a turn is streaming");
  await tick(1500);
  await show("4 · the answer committed");

  await type("/provider");
  await type("\r");
  await show("5 · the provider menu");
  stdin.write("\x1b"); // escape
  await tick(50);
  await type("/model");
  await type("\r");
  await show("6 · the model picker");
  stdin.write("\x1b");
  await tick(50);
  await type("/usage");
  await type("\r");
  await show("7 · the usage panel");

  instance.unmount();
  if (prev === undefined) delete process.env.ACTOR0_CONFIG_DIR;
  else process.env.ACTOR0_CONFIG_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
  process.exit(quit ? 1 : 0);
}

void main();
