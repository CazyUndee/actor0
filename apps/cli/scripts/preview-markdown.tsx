// @options: {"timeout_ms": 30000}
// Offline preview: a markdown-rich answer, to eyeball the styled rendering. (dummy transport, pre-seeded
// transcript) to eyeball the styled markdown. Prints the committed frame.
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import type { ModelClient } from "@actor0/harness";
import { App } from "../src/ui/App.js";
import { addProvider, withModel } from "../src/config.js";
import type { Screen } from "../src/ui/term.js";

const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

// A dummy transport that answers with markdown, so the committed entry renders.
const markdownAnswer = [
  "## Here's how to build it",
  "",
  "Run the **build** first, then check the table below:",
  "",
  "```bash",
  "npm install && npm run build --workspace @actor0/cli",
  "```",
  "",
  "| Tool | Purpose |",
  "| --- | --- |",
  "| read | open a file |",
  "| bash | run a command |",
  "",
  "- step one with `inline code`",
  "- step two",
  "",
  "> a quoted aside",
  "",
  "See [the docs](https://example.com) for more.",
].join("\n");

const dummy: ModelClient = {
  async *stream() {
    for (const w of markdownAnswer.split(" ")) {
      yield { type: "token", delta: `${w} ` } as never;
      await tick(1);
    }
    yield { type: "done", text: markdownAnswer, complete: true } as never;
  },
};

class Capture {
  size = { rows: 44, cols: 90 };
  last: string[] = [];
  render(g: string[]): void { this.last = g; }
  caret(): void {}
  hideCaret(): void {}
  setSize(): void {}
  dispose(): void {}
}

function cfg() {
  return addProvider(withModel({ model: "m", models: ["m"] }, "m"), { name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k", model: "m" });
}

async function main(): Promise<void> {
  const screen = new Capture();
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, columns: 90, rows: 44, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const sink = new PassThrough();
  sink.resume();
  const inst = render(
    createElement(App, { cwd: process.cwd(), config: cfg(), version: "0.1.1", screen: screen as unknown as Screen, stdin: stdin as unknown as NodeJS.ReadStream, onExit: () => {}, transport: dummy }),
    { stdin: sink as never, stdout: sink as never, exitOnCtrlC: false, patchConsole: false },
  );
  stdin.write("show me the markdown");
  await tick(100);
  stdin.write("\r");
  for (let i = 0; i < 40; i += 1) {
    await tick(300);
    const j = screen.last.join("\n");
    if (i > 3 && j.split("\n").slice(-4)[0]?.includes("❯")) break;
  }
  await tick(300);
  console.log("=== committed markdown frame ===");
  console.log(screen.last.join("\n"));
  inst.unmount();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
