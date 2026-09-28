/**
 * Drive the real TUI without a human and without a provider.
 *
 * Renders `ui/App` against a simulated TTY and a mock model client, sends
 * scripted keystrokes, and prints the resulting screen with ANSI stripped.
 * This exists because the parts of a terminal app most likely to be wrong —
 * what a frame actually looks like, whether the transcript commits, whether an
 * ungated tool call still lands without something stealing the keyboard — are
 * invisible to unit tests and awkward to reproduce by hand.
 *
 * Ink redraws with cursor movement rather than repainting, so raw stdout
 * chunks are meaningless in isolation. `Screen` below is a deliberately tiny
 * terminal emulator: enough of VT100 to reconstruct what the user sees, and no
 * more. It is a viewing aid, not a general-purpose console.
 *
 * Run: npm run preview -w @actor0/cli
 */
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { App } from "../src/ui/App.js";
import { ModelTransportError, type ModelEvent, type ModelClient } from "@actor0/harness";
import { withModel } from "../src/config.js";

/**
 * Minimal VT100 screen: cursor movement, erase, newline, and scrolling. SGR is
 * discarded.
 *
 * The fixed-height viewport and the scrollback behind it are the whole point.
 * Ink never emits an explicit "scroll" — it writes output, then moves the
 * cursor back up the height of the frame it just drew and rewrites it. On a
 * real terminal that works because writing past the last line scrolls the
 * screen up. Modelled as an unbounded grid instead, the cursor-up moves landed
 * on rows that never existed and the transcript's history was not represented
 * at all, so this driver could render every frame without ever being able to
 * tell whether an earlier answer had been thrown away.
 */
class Screen {
  private lines: string[];
  /** Lines that have scrolled off the top, newest last. */
  private scrollback: string[] = [];
  private row = 0;
  private col = 0;

  constructor(private readonly rows: number) {
    this.lines = Array.from({ length: rows }, () => "");
  }

  write(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      if (chunk[i] === "\u001b") {
        // eslint-disable-next-line no-control-regex -- matching ANSI escapes is the entire job; the control character *is* the subject
        const match = chunk.slice(i).match(/^\u001b\[([0-9;?]*)([A-Za-z])/);
        if (!match) {
          i += 1;
          continue;
        }
        this.control(match[1], match[2]);
        i += match[0].length;
        continue;
      }
      const char = chunk[i];
      if (char === "\n") {
        this.row += 1;
        this.col = 0;
        // Writing past the last line is what scrolls the screen up, and it is
        // the only thing that does. This is how committed transcript output
        // becomes scrollback instead of being overwritten in place.
        if (this.row >= this.rows) {
          this.row = this.rows - 1;
          this.scrollUp();
        }
      } else if (char === "\r") {
        this.col = 0;
      } else if (char !== "\u0007") {
        const line = this.lines[this.row] ?? "";
        this.lines[this.row] = line.slice(0, this.col) + char + line.slice(this.col + 1);
        this.col += 1;
      }
      i += 1;
    }
  }

  private control(params: string, final: string): void {
    const n = Number.parseInt(params, 10) || 0;
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - Math.max(1, n));
        break;
      case "B":
        this.row = Math.min(this.rows - 1, this.row + Math.max(1, n));
        break;
      case "C":
        this.col += Math.max(1, n);
        break;
      case "D":
        this.col = Math.max(0, this.col - Math.max(1, n));
        break;
      case "G":
        this.col = Math.max(0, (Number.parseInt(params, 10) || 1) - 1);
        break;
      case "J":
        // 0J clears from the cursor down, 2J the whole screen, and 3J the
        // scrollback buffer. `clearTerminal` is all three, so handling only 2J
        // left the cursor stranded and the repaint landing on the wrong rows.
        if (n === 2) {
          this.lines = Array.from({ length: this.rows }, () => "");
        } else if (n === 3) {
          this.scrollback = [];
        } else {
          for (let i = this.row; i < this.lines.length; i += 1) this.lines[i] = "";
        }
        break;
      case "H":
        // Cursor position. Bare `H` is home; `H` with arguments is a row/column
        // move (ESC[row;colH), 1-based.
        if (params === "") {
          this.row = 0;
          this.col = 0;
        } else {
          const [row, col] = params.split(";");
          this.row = Math.min(this.rows - 1, Math.max(0, (Number.parseInt(row ?? "1", 10) || 1) - 1));
          this.col = Math.max(0, (Number.parseInt(col ?? "1", 10) || 1) - 1);
        }
        break;
      case "K":
        // Erase from the cursor to end of line.
        this.lines[this.row] = (this.lines[this.row] ?? "").slice(0, this.col);
        break;
      default:
        break;
    }
  }

  /** Push the top line into the scrollback and open a fresh one at the bottom. */
  private scrollUp(): void {
    const gone = this.lines.shift();
    if (gone !== undefined) this.scrollback.push(gone);
    this.lines.push("");
  }

  /** What the user can see right now: the viewport only. */
  render(): string {
    return this.lines.join("\n").replace(/\s+$/, "");
  }

  /**
   * Everything the terminal has ever shown, oldest first.
   *
   * This is what scrolling actually reads from, so it is the only honest way to
   * ask whether an earlier answer is still there.
   */
  renderAll(): string {
    return [...this.scrollback, ...this.lines].join("\n");
  }
}

function fakeStdin(): PassThrough {
  const stream = new PassThrough() as PassThrough;
  // Ink 6 treats stdin as a Node stream and calls ref/unref plus setRawMode.
  // A PassThrough has none of them, so supply no-ops.
  Object.assign(stream, {
    isTTY: true,
    setRawMode: () => stream,
    ref: () => stream,
    unref: () => stream,
    isRaw: false,
  });
  return stream;
}

/** The simulated terminal. Shared so Ink's idea of the size and `Screen`'s agree. */
const SCREEN_COLUMNS = 88;
const SCREEN_ROWS = 40;

function fakeStdout(): PassThrough {
  const stream = new PassThrough() as PassThrough;
  Object.assign(stream, {
    isTTY: true,
    columns: SCREEN_COLUMNS,
    rows: SCREEN_ROWS,
    getColorDepth: () => 24,
  });
  return stream;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The scripted model, as a plain function of the turn index.
 *
 * It used to be an HTTP server on a random port, reached through a base URL
 * the config carried. With one fixed endpoint there is no base URL to point at
 * a mock, so the script moved onto the harness's `ModelClient` port — the seam
 * that exists for exactly this — and the network left the preview entirely.
 */
function scriptedTurn(turn: number | "fail"): AsyncGenerator<ModelEvent> {
  const text = (delta: string): ModelEvent => ({ type: "token", delta });
  const tool = (id: string, name: string, args: Record<string, unknown>): ModelEvent => ({
    type: "tool_call",
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  const done: ModelEvent = { type: "done" };
  const usage: ModelEvent = { type: "usage", usage: { prompt_tokens: 128, completion_tokens: 214, total_tokens: 342 } };

  // One turn fails the way a platform-level error actually fails: an HTML page
  // with a 4xx, which is not retried, so the diagnosis reaches the transcript
  // instead of clearing itself on the next attempt.
  if (turn === "fail") throw new ModelTransportError(
    "HTTP 403 Forbidden from https://aestral-chat.vercel.app/api/chat (text/html): it answered with an " +
      "HTML page, which usually means a login wall, a bot check, or the wrong URL. Retrying will not help.",
    false,
  );

  switch (turn) {
    case 0:
      return (async function* () { yield tool("c1", "read", { path: "notes.md" }); })();
    case 1:
      return (async function* () {
        yield tool("c2", "write", {
          path: "summary.md",
          content: ["# Summary", "", "The CLI consumes the harness.", ""].join("\n"),
        });
      })();
    case 2:
      // Nothing here is gated, so a command is just another tool round: it
      // runs, it reports its exit code, and the keyboard is never taken away.
      // This one fails, on purpose: it is the frame that proves a failure
      // reaches the transcript rather than stopping silently behind a red glyph.
      return (async function* () { yield tool("c3", "bash", { command: "wc -l missing.md" }); })();
    default:
      return (async function* () {
        // A deliberately tall answer: the transcript has to drop its head rather
        // than push the composer off the bottom of the terminal, and the driver
        // is the only place that failure is visible.
        const long = Array.from(
          { length: 9 },
          (_, i) => `Paragraph ${i + 1}: the harness owns execution and the CLI owns the surface.`,
        ).join("\n\n");
        for (const line of long.split(/(?<=\.)\s/)) yield text(`${line} `);
        yield usage;
        yield done;
      })();
  }
}

let turn = 0;

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "actor0-preview-"));
  writeFileSync(join(workspace, "notes.md"), "# Notes\n\nThe CLI consumes the harness.\n");

  const stdin = fakeStdin();
  const stdout = fakeStdout();
  // The viewport is the terminal's own height, so scrolling behaves the way the
  // user will experience it rather than the way an unbounded grid would.
  const screen = new Screen(SCREEN_ROWS);
  stdout.on("data", (chunk: Buffer) => screen.write(chunk.toString("utf8")));

  const config = withModel({ model: "demo-model", models: ["demo-model"] }, "demo-model");

  // The endpoint is fixed, so the mock rides in on the harness's ModelClient
  // port rather than on a base URL the user could have set.
  const transport: ModelClient = {
    async *stream(messages) {
      // Which turn fails is keyed off the text the driver typed, not off a
      // counter. A counter means the failure lands on whatever turn happens to
      // be Nth, which silently depends on how many local slash commands the
      // driver sent — so adding a `/model` frame can move the 403 onto an
      // unrelated question and the check still passes.
      const last = [...messages].reverse().find((m) => m.role === "user");
      const input = typeof last?.content === "string" ? last.content : "";
      yield* scriptedTurn(input.includes("this one fails") ? "fail" : turn++);
    },
  };

  const app = render(createElement(App, { cwd: workspace, config, transport }), {
    stdin: stdin as never,
    stdout: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  // Ink catches a render error, prints it, and keeps the process alive at exit
  // code 0. So a preview whose whole UI is a stack trace used to look like a
  // passing run — which is exactly how a broken JSX transform survived. Every
  // frame is now checked, and the run fails loudly.
  const broken: string[] = [];
  const show = (label: string) => {
    const body = screen.render();
    if (body.includes("ERROR") || body.includes("React is not defined")) {
      broken.push(label);
    }
    const bar = "─".repeat(Math.max(0, 72 - label.length));
    process.stdout.write(`\n┌─ ${label} ${bar}\n${body}\n└${"─".repeat(73)}\n`);
  };

  await wait(300);
  show("1 · empty transcript, composer idle");

  stdin.write("what is in notes.md?");
  await wait(150);
  show("2 · typed input");

  stdin.write("\r");
  await wait(250);
  show("3 · a read runs, and nothing asks");

  await wait(700);
  show("4 · the read result arrives on its own");

  stdin.write("write a summary of it");
  await wait(120);
  stdin.write("\r");
  await wait(900);
  show("5 · a write lands with no confirmation");

  stdin.write("how many lines is it?");
  await wait(120);
  stdin.write("\r");
  await wait(900);
  show("6 · a failed shell command shows why, not just that it failed");

  stdin.write("/help");
  await wait(100);
  stdin.write("\r");
  await wait(250);
  show("7 · /help");

  stdin.write("/model");
  await wait(120);
  stdin.write("\r");
  await wait(250);
  show("8 · /model picker");

  stdin.write("\u001b");
  await wait(200);
  show("9 · picker dismissed with Esc");

  stdin.write("/clear");
  await wait(120);
  stdin.write("\r");
  await wait(250);
  show("10 · /clear starts a new conversation");

  // Overflow: several tall answers. The transcript no longer sheds its head to
  // stay on screen — it goes to the terminal's scrollback — but the composer
  // still has to survive a full-height live region, so this frame is where a
  // broken input line shows up.
  for (const question of [
    "explain the harness in detail",
    "explain the filter in detail",
    "explain the reducer in detail",
  ]) {
    stdin.write(question);
    await wait(80);
    stdin.write("\r");
    await wait(700);
  }
  show("11 · a transcript taller than the terminal");

  stdin.write("this one fails");
  await wait(80);
  stdin.write("\r");
  await wait(1_200);
  show("12 · the endpoint answers 403 with an HTML page");

  // The regression this guards. The transcript used to be a bounded window that
  // was redrawn on every frame, so it overwrote the terminal's scrollback and
  // earlier answers were genuinely unreachable — reading one back meant the
  // app's own PageUp handler, which is exactly the thing that made scrolling
  // feel broken. Native scrolling reads from the output stream instead, so the
  // simplest questions from the start of this run must still be in it.
  const history = screen.renderAll();
  for (const marker of ["what is in notes.md?", "write a summary of it"]) {
    if (!history.includes(marker)) {
      process.stderr.write(
        `\npreview failed: the transcript dropped earlier output — ${JSON.stringify(marker)} is no longer on screen or in scrollback\n`,
      );
      app.unmount();
      process.exit(1);
    }
  }

  if (broken.length > 0) {
    process.stderr.write(
      `\npreview failed: the app rendered an error at ${broken.length} frame(s) — ${broken.join(", ")}\n`,
    );
    app.unmount();
    process.exit(1);
  }

  app.unmount();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
});
