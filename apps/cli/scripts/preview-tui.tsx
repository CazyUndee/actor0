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
  /**
   * Escape sequences that would have changed the text grid and were not
   * modelled here, with a count each. Reported at the end of the run, and a
   * non-empty one fails it.
   *
   * This is the driver’s honesty check. A sequence that moves the cursor or
   * erases cells makes the reconstructed frame a guess, and a frame that is
   * wrong in a way nobody can see is the one kind of wrong this whole thing
   * exists to catch — so a new one fails the run instead of quietly changing
   * what the driver can see. Sequences that only affect attributes are
   * deliberately not here: see `ignored`.
   */
  readonly unhandled = new Map<string, number>();

  /** Sequences that were recognised and deliberately have no effect on a text grid. */
  ignored = 0;

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
    // Sequences that only affect attributes, handled before the switch because
    // none of them moves a character and grouping them here says so once.
    // `m` is SGR — colour, bold, dim, underline, of which this screen draws
    // none, as the top of the file says. `h` and `l` are DECSET/DECRST: Ink
    // wraps every write in 2026 (synchronized output, so a frame lands in one
    // piece) and hides the cursor around its own writes.
    if (final === "m" || final === "h" || final === "l") {
      this.ignored += 1;
      return;
    }
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
        // 0J clears from the cursor down, 1J from the cursor up, 2J the whole
        // screen, and 3J the scrollback buffer. `clearTerminal` is all three,
        // so handling only 2J left the cursor stranded and the repaint landing
        // on the wrong rows. `1J` was treated as `0J`, which erased more than
        // the sequence asked for.
        if (n === 2) {
          this.lines = Array.from({ length: this.rows }, () => "");
        } else if (n === 3) {
          this.scrollback = [];
        } else if (n === 1) {
          for (let i = 0; i <= this.row; i += 1) this.lines[i] = "";
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
        // 0K erases from the cursor to the end of the line, 1K from the start
        // of the line to the cursor, and 2K the whole line. The parameter is
        // the whole meaning of this sequence.
        //
        // It used to be ignored, so `2K` — which is what log-update emits to
        // repaint, and does so for every row of every frame — was read as
        // `0K` and kept every character to the right of the cursor. On a
        // resize, where the frame gets shorter and the leftover rows are
        // erased at whatever column the cursor happened to be sitting at,
        // that manufactured precisely the stale text the driver appeared to
        // have found: a lens that invents a bug sends someone to fix the
        // app for it.
        {
          const line = this.lines[this.row] ?? "";
          if (n === 1) {
            this.lines[this.row] = line.slice(this.col) + " ".repeat(this.col);
          } else if (n === 2) {
            this.lines[this.row] = "";
          } else {
            this.lines[this.row] = line.slice(0, this.col);
          }
        }
        break;

      default:
        this.unhandled.set(
          `${final}${params ? `;${params}` : ""}`,
          (this.unhandled.get(`${final}${params ? `;${params}` : ""}`) ?? 0) + 1,
        );
        break;
    }
  }

  /** Push the top line into the scrollback and open a fresh one at the bottom. */
  private scrollUp(): void {
    const gone = this.lines.shift();
    if (gone !== undefined) this.scrollback.push(gone);
    this.lines.push("");
  }

  /**
   * Resize the viewport, the way a window drag does.
   *
   * Shrinking pushes whole lines off the top into scrollback rather than
   * dropping them: a grid that simply lost rows would be reclaiming them
   * from nowhere, and every narrow frame would then look like the driver
   * had eaten history. Growing opens blank rows at the bottom.
   */
  resize(rows: number): void {
    while (this.lines.length > rows) {
      const gone = this.lines.shift();
      if (gone !== undefined) this.scrollback.push(gone);
    }
    while (this.lines.length < rows) this.lines.push("");
    this.row = Math.max(0, Math.min(this.lines.length - 1, this.row));
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

/**
 * Change the simulated terminal's size, as a window drag does.
 *
 * Mutating `columns` on its own would have tested a terminal nobody has:
 * nothing would repaint, and `useTerminalSize` — which is the only thing
 * the banner, the transcript and `fitTail` read their width from — would
 * keep reporting the old one forever.
 */
function resizeTerminal(stdout: PassThrough, columns: number, rows: number, screen: Screen): void {
  Object.assign(stdout, { columns, rows });
  screen.resize(rows);
  stdout.emit("resize");
}

/** Narrow the terminal without changing its height. */
const narrowTerminal = (stdout: PassThrough, screen: Screen): void =>
  resizeTerminal(stdout, 44, SCREEN_ROWS, screen);

/** A terminal with fewer rows, at the width the run started at. */
const shortTerminal = (stdout: PassThrough, screen: Screen): void =>
  resizeTerminal(stdout, SCREEN_COLUMNS, 24, screen);

/**
 * Narrower than `narrowTerminal`, because 36 is the width at which a
 * three-column table can no longer be drawn as a grid at all.
 */
const gridlessTerminal = (stdout: PassThrough, screen: Screen): void =>
  resizeTerminal(stdout, 36, SCREEN_ROWS, screen);

/** Back to the size the whole run started at. */
const wideTerminal = (stdout: PassThrough, screen: Screen): void =>
  resizeTerminal(stdout, SCREEN_COLUMNS, SCREEN_ROWS, screen);

// Width and height are separate accidents and these frames move one at a
// time. Resizing both together put a 44-column, 30-row frame on screen, and
// a frame that short is tall enough for Ink to abandon its incremental path
// and repaint with `clearTerminal` — after which stale rows from the narrow
// layout appeared in the next wide frame, with no way to tell whether the
// width or the height had put them there. Each axis is now its own frame.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves when `predicate` holds, or after `timeoutMs`.
 *
 * The frames used to be captured on fixed timers, and a timer is a guess about
 * how long a turn takes on the machine running the preview. On a slow one the
 * “a read runs” frame was captured after the turn had finished, and the driver typed
 * the next question into a busy session — which is why the read it was about to
 * show never happened and the run only failed on the scrollback check at the end.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return;
    await wait(20);
  }
}

/**
 * Milliseconds between two events of one scripted answer.
 *
 * The frames below are captured on timers, and an unpaced mock finishes a
 * whole four-round turn in well under the first one — so “a read runs” and
 * “the read result arrives” were the same finished screen, twice, and the
 * driver had quietly stopped being able to see a turn in flight. That is the
 * one thing it exists for.
 */
const PACE_MS = 60;

/** A command that takes about a second, so a tool round is observable. */
const SLOW_COMMAND = process.platform === "win32" ? "ping -n 2 127.0.0.1 >nul" : "sleep 1";

/** A command no shell has, so the failure path is real and not a missing tool. */
const MISSING_COMMAND = "no-such-command-actor0-preview";

/**
 * A command long enough that cancelling it is a real interruption.
 *
 * The turn that issues it must never be waited out — the driver presses Esc
 * and moves on — so this only has to outlive the cancel, not the run.
 */
const LONG_COMMAND = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 25";

type Round = number;

/**
 * The scripted model, keyed off what the driver typed rather than a counter.
 *
 * It used to be an HTTP server on a random port, reached through a base URL
 * the config carried. With one fixed endpoint there is no base URL to point at
 * a mock, so the script moved onto the harness's `ModelClient` port — the seam
 * that exists for exactly this — and the network left the preview entirely.
 *
 * Keying on the question, not on a running total, is what makes each frame mean
 * what its label says: one prompt produces one tool round and one answer,
 * instead of one prompt producing all four turns and every frame after the
 * first showing the same finished screen. A counter has the same problem in a
 * worse form — adding a `/model` frame moves every later turn by one.
 */
function scriptedTurn(input: string, round: Round): AsyncGenerator<ModelEvent> {
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
  if (input.includes("this one fails")) throw new ModelTransportError(
    "HTTP 403 Forbidden from https://aestral-chat.vercel.app/api/chat (text/html): it answered with an " +
      "HTML page, which usually means a login wall, a bot check, or the wrong URL. Retrying will not help.",
    false,
  );

  const answer = (reply: string): ModelEvent[] => [text(reply), usage, done];

  if (input.includes("slow")) {
    // Round 0 is the frame the driver exists for: a tool call in flight, with
    // nothing taking the keyboard. Round 1 is its result, on its own.
    return round === 0
      ? (async function* () {
        await wait(PACE_MS);
        yield tool("c1", "shell", { command: SLOW_COMMAND });
      })()
      : (async function* () { yield* answer("That command took a second and nothing asked while it ran."); })();
  }

  if (input.includes("notes.md")) {
    return round === 0
      ? (async function* () { yield tool("c2", "read", { path: "notes.md" }); })()
      : (async function* () { yield* answer("It says: the CLI consumes the harness."); })();
  }

  if (input.includes("summary")) {
    return round === 0
      ? (async function* () {
        yield tool("c3", "write", {
          path: "summary.md",
          content: ["# Summary", "", "The CLI consumes the harness.", ""].join("\n"),
        });
      })()
      : (async function* () { yield* answer("Wrote summary.md."); })();
  }

  if (input.includes("cancel this")) {
    // Round 1 exists only so a frame that has NOT cancelled is loud: if the
    // abort ever stopped working, the model gets asked a second time and this
    // answer — which says so in words — lands in the transcript after the user
    // pressed Esc and walked away.
    return round === 0
      ? (async function* () { yield tool("c5", "shell", { command: LONG_COMMAND }); })()
      : (async function* () {
        yield* answer("This answer arrived, so nothing cancelled the turn.");
      })();
  }

  if (input.includes("how many lines")) {
    // A real shell, running a command no shell has. The previous script asked
    // for a tool named `bash`, which this CLI does not have, so the frame
    // labelled “a failed shell command shows why” was really testing unknown-tool
    // rejection — and would have stayed green if shell failures broke.
    return round === 0
      ? (async function* () { yield tool("c4", "shell", { command: MISSING_COMMAND }); })()
      : (async function* () { yield* answer("It could not run, and the row above says why."); })();
  }

  if (input.includes("the command")) {
    // An answer with a fenced code block in it, and a line in that block
    // longer than 78 columns. This is the shape the prompt promises renders
    // and did not: every line went through the word wrapper, so the command
    // arrived folded at an arbitrary column — neither runnable nor readable.
    const long = `npm run --workspace @actor0/cli build -- --mode production --sourcemap`;
    return (async function* () {
      for (const piece of ["Here is the command:\n\n```sh\n", long, "\n```\n\nThen run the tests.\n"]) {
        await wait(PACE_MS);
        yield text(piece);
      }
      yield usage;
      yield done;
    })();
  }

  if (input.includes("the table")) {
    // A data table, which the prompt permits — it only rules tables out for
    // layout. Folded by the word wrapper it lost its shape entirely: the
    // delimiter row showed as literal dashes and the values separated from
    // their own rows, so `20s` read as a row of its own.
    return (async function* () {
      for (const piece of [
        "Three ways to run it:\n\n",
        "| Command | What it does | Cost |\n",
        "| :--- | :---: | ---: |\n",
        "| npm test | every suite | 20s |\n",
        [
          "| npm run typecheck | types only, no tests | 8s |",
          "| npm run check:tui | drives the TUI driver | 4s |",
          "",
          "Pick `npm test` before pushing anything.",
        ].join("\n"),
      ]) {
        await wait(PACE_MS);
        yield text(piece);
      }
      yield usage;
      yield done;
    })();
  }

  if (input.includes("one paragraph")) {
    // One paragraph, with no newline in it anywhere.
    //
    // Every other answer in this script is blank-line separated, so every other
    // answer reaches the live region as many short lines — and a row budget
    // that counts lines handles that shape perfectly well. The bug this frame
    // was added for lived in the other one: a single unbroken stream arrives as
    // a *single* line, so a budget that counts lines counted it once however
    // many rows it filled. Long enough to overflow a 40-row terminal alone.
    const paragraph = Array.from(
      { length: 60 },
      (_, i) =>
        "The harness owns execution and the CLI owns the surface, which is sentence " + i + " of one unbroken paragraph.",
    ).join(" ");
    return (async function* () {
      for (const chunk of paragraph.match(/.{1,240}/g) ?? []) {
        await wait(PACE_MS);
        yield text(chunk);
      }
      yield usage;
      yield done;
    })();
  }

  // A deliberately tall answer: the transcript has to drop its head rather than
  // push the composer off the bottom of the terminal, and the driver is the
  // only place that failure is visible.
  const long = Array.from(
    { length: 9 },
    (_, i) => `Paragraph ${i + 1}: the harness owns execution and the CLI owns the surface.`,
  ).join("\n\n");
  return (async function* () {
    for (const line of long.split(/(?<=\.)\s/)) {
      await wait(PACE_MS);
      yield text(`${line} `);
    }
    yield usage;
    yield done;
  })();
}
const roundsAsked = new Map<string, number>();

/** How many model requests a question has produced. Two means the turn is over. */
const askedFor = (input: string, n: number): Promise<void> =>
  waitFor(() => (roundsAsked.get(input) ?? 0) >= n);

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
      // Which round of a question this is, counted per question. A counter
      // across the whole run means a failure lands on whatever turn happens to
      // be Nth, which silently depends on how many slash commands the driver
      // sent — so adding a `/model` frame can move the 403 onto an unrelated
      // question and the check still passes.
      const last = [...messages].reverse().find((m) => m.role === "user");
      const input = typeof last?.content === "string" ? last.content : "";
      const round = roundsAsked.get(input) ?? 0;
      roundsAsked.set(input, round + 1);
      for await (const event of scriptedTurn(input, round)) {
        await wait(PACE_MS);
        yield event;
      }
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
  const seen = new Map<string, string>();
  const repeated: string[] = [];

  /**
   * Wait until the rendered screen stops changing.
   *
   * A frame captured mid-repaint is a frame nobody will ever see. Ink repaints
   * in several writes — clear, then rewrite, and on a resize a full-screen
   * repaint — so a capture that lands between them shows half of the old
   * layout over half of the new one. That is how the 44-column frames came to
   * carry, on some runs and not others, two stale 88-column lines and a second
   * copy of the composer: the rows were real, and then they were not, which is
   * exactly the signature of a bad capture and not of a bad frame.
   */
  const settle = async (): Promise<void> => {
    let previous = screen.render();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await wait(20);
      const next = screen.render();
      if (next === previous) return;
      previous = next;
    }
  };

  /** Labels a capture started with, whether or not it got to finish. */
  const started: string[] = [];
  const finished: string[] = [];
  const show = async (label: string): Promise<void> => {
    // `show` became async when it learned to wait for the screen to settle,
    // and every call site had to grow an `await`. One that did not is silent:
    // the capture pauses in `settle()`, the driver keeps typing, and the frame
    // records the screen as it was after the *next* thing happened. Nothing
    // downstream catches that — lint has no type-aware rules on the scripts, and
    // the repeated-frame check cannot, because the content really did change.
    // So the count is the check: a frame that started and did not finish is one
    // nobody awaited, and the run says which.
    started.push(label);
    await settle();
    finished.push(label);
    const body = screen.render();
    const previous = seen.get(label);
    if (previous === body) repeated.push(label);
    seen.set(label, body);
    if (body.includes("ERROR") || body.includes("React is not defined")) {
      broken.push(label);
    }
    const bar = "─".repeat(Math.max(0, 72 - label.length));
    process.stdout.write(`\n┌─ ${label} ${bar}\n${body}\n└${"─".repeat(73)}\n`);
  };

  await wait(300);
  await show("1 · empty transcript, composer idle");

/** Every question the driver has submitted, in order. */
const submitted: string[] = [];

/**
 * Is a turn running, as the screen says so?
 *
 * Read from the footer, not from the composer placeholder. The placeholder says
 * “working — Esc to cancel” only while the draft is empty, so the moment a question was
 * typed — exactly the state this driver puts the app in — the word disappeared and the
 * driver concluded the turn was over, pressed Enter, and was refused. The
 * footer describes the key that is actually live and is always rendered, which
 * is the same reason the footer exists.
 */
const BUSY_FOOTER = "Esc cancels a running turn";
const running = (): boolean => screen.render().includes(BUSY_FOOTER);

/** Wait until the UI is telling the user it is idle. */
const settled = (): Promise<void> => waitFor(() => !running());

/** Type a question and send it, without waiting for the turn that follows. */
const begin = async (question: string): Promise<void> => {
  await settled();
  submitted.push(question);
  stdin.write(question);
  await wait(120);
  stdin.write("\r");
};

/** Type a question, submit it, and do not return until its turn has finished. */
const ask = async (question: string): Promise<void> => {
  // Wait for the screen, not for a count of model requests. A request count is
  // a proxy: the second request of a turn happens while the answer is still
  // streaming, and the driver typed the next question into that gap. The
  // composer now keeps what is typed during a turn and refuses the submit with
  // a warning, so the driver was left waiting fifteen seconds for a turn that
  // was never going to start.
  await settled();
  submitted.push(question);
  stdin.write(question);
  await wait(120);
  stdin.write("\r");
  // Waiting for the turn to stop being busy is not enough: the instant between
  // the Enter and the turn starting is also not busy, so the driver used to
  // return while the question was still sitting in the composer. Wait for the
  // question to reach the transcript — a committed line carries no caret, the
  // composer line does — and only then for the turn to finish.
  const committed = (): boolean =>
    screen.render().split("\n").some((line) => line.trim() === `❯ ${question}`);
  await waitFor(committed);
  await settled();
};

  submitted.push("run something slow");
  stdin.write("run something slow");
  await wait(150);
  await show("2 · typed input");

  stdin.write("\r");
  // Into a command that runs for a second: this is the frame the whole driver
  // exists for. A tool call is in flight and the keyboard belongs to the user —
  // no dialog, nothing to dismiss, no input taken away. The wait is for the
  // request to have been made, not for a duration: the command is slow enough
  // that any capture after it is still in flight, and asking for the request is
  // what makes that true on a slow machine too.
  await askedFor("run something slow", 1);
  await wait(150);
  await show("3 · a tool call is running, and nothing asks");

  // Type the next question while the command is still running, and try to send
  // it. The composer used to be inactive for the duration of a turn, so every
  // one of these keystrokes was dropped: a person who starts typing during a long
  // tool call watches their question disappear with nothing saying the input was
  // off. The text is kept and the send is refused out loud.
  // The question the user was going to ask next, typed while the command is
  // still running. The composer used to be inactive for the duration of a turn,
  // so every one of these keystrokes was dropped: a person who starts the next
  // question during a long tool call watches it disappear, with nothing on
  // screen saying the input was off. The text is kept and the send is refused.
  // Typed as the real next question rather than as filler, so what follows is
  // the flow a person would actually go through.
  const typed = "what is in notes.md?";
  stdin.write(typed);
  await wait(150);
  stdin.write("\r");
  await wait(250);
  await show("4 · typing during a turn is kept, and the send is refused");

  await askedFor("run something slow", 2);
  await wait(150);
  await show("5 · its result arrives on its own");

  // The turn is over. The text is still in the composer, untouched, and one more
  // Enter sends it — which is the whole point of keeping it.
  await settled();
  stdin.write("\r");
  const committed = (): boolean =>
    screen.render().split("\n").some((line) => line.trim() === `❯ ${typed}`);
  await waitFor(committed);
  await settled();
  submitted.push(typed);
  await show("6 · the read that was typed early goes through unchanged");

  await ask("write a summary of it");
  await show("7 · a write lands with no confirmation");

  await ask("how many lines is it?");
  await show("8 · a failed shell command shows why, not just that it failed");

  stdin.write("/help");
  await wait(100);
  stdin.write("\r");
  await wait(250);
  await show("9 · /help");

  stdin.write("/model");
  await wait(120);
  stdin.write("\r");
  await wait(250);
  await show("10 · /model picker");

  stdin.write("\u001b");
  await wait(200);
  await show("11 · picker dismissed with Esc");

  stdin.write("/clear");
  await wait(120);
  stdin.write("\r");
  await wait(250);
  await show("12 · /clear starts a new conversation");

  // Overflow: several tall answers. The transcript no longer sheds its head to
  // stay on screen — it goes to the terminal's scrollback — but the composer
  // still has to survive a full-height live region, so this frame is where a
  // broken input line shows up.
  for (const question of [
    "explain the harness in detail",
    "explain the filter in detail",
    "explain the reducer in detail",
  ]) {
    await ask(question);
  }
  await show("13 · a transcript taller than the terminal");

  submitted.push("this one fails");
  stdin.write("this one fails");
  await wait(80);
  stdin.write("\r");
  // The failure is thrown before any frame, so there is no second request to
  // wait for; the error notice is the last thing the turn writes.
  await wait(600);
  await show("14 · the endpoint answers 403 with an HTML page");

  // A narrow terminal. Every column here is load-bearing: the opening card
  // sizes itself to the width, the transcript wraps to it, `fitTail` trims
  // the live region against it, and the composer sits under all of it. A
  // layout that overflows is invisible at 88 columns and obvious at 44.
  narrowTerminal(stdout, screen);
  await wait(250);
  await show("15 · a 44-column terminal");
  wideTerminal(stdout, screen);
  await wait(200);

  // A short terminal. Height takes a different path through Ink than width
  // does, so it gets its own frame instead of sharing one.
  shortTerminal(stdout, screen);
  await wait(250);
  await show("16 · a 24-row terminal, transcript still reachable");
  wideTerminal(stdout, screen);
  await wait(200);

  // The same narrow width *during* a streaming answer. This is the case the
  // idle frame cannot reach: `fitTail` re-trims on every token against a
  // column count that just changed under it, so the trimming is the thing
  // being exercised, not the static layout.
  await wait(150);
  await begin("explain the reducer in detail, and take your time");
  await askedFor("explain the reducer in detail, and take your time", 1);
  await wait(240);
  narrowTerminal(stdout, screen);
  await wait(240);
  await show("17 · resized to 44 columns mid-answer");
  wideTerminal(stdout, screen);
  await settled();
  await show("18 · back to full width, answer intact");

  // The shape the row budget used to get wrong, on the screen. A frame taller
  // than the terminal gets repainted with `clearTerminal` and takes the
  // scrollback with it, which is what the assertion under this one checks.
  await ask("explain it as one paragraph please");
  await show("19 · one unbroken paragraph, composer still on screen");

  // Markdown the prompt promises renders. The block is committed by now, so
  // this frame shows the committed rendering rather than a half-streamed one.
  await ask("show me the command");
  await show("20 · a fenced code block is not word-wrapped");

  await ask("show me the table");
  await show("21 · a table is laid out as a grid");

  // The same question in a terminal too narrow to hold the grid. The resize has
  // to come *before* the answer, not after it: the transcript is static once
  // written, so narrowing afterwards re-renders the live region and leaves the
  // committed answer exactly as it was. That frame looked right and tested
  // nothing — it showed the grid under a caption promising key/value.
  gridlessTerminal(stdout, screen);
  await wait(250);
  await ask("show me the table again");
  // Nothing may be cut off the right here. A value that has migrated out of its
  // own column is read as belonging to the row below it.
  await show("22 · too narrow for a grid, so it reads as key/value");
  wideTerminal(stdout, screen);
  await wait(200);

  // The first question of the run has to still be in the terminal’s scrollback.
  if (!screen.renderAll().includes("what is in notes.md?")) {
    process.stderr.write(
      "\npreview failed: a single-paragraph answer took the scrollback with it — the first question is gone\n",
    );
    app.unmount();
    process.exit(1);
  }

  // Esc, which the footer has been promising for the whole run. A quarter of
  // a minute of real process is running when it is pressed.
  await begin("cancel this");
  await askedFor("cancel this", 1);
  await wait(250);
  await show("23 · a long tool call is running");
  stdin.write("\u001b");
  await settled();
  await wait(300);
  await show("24 · Esc cancels the turn, and says so");

  // The promise on the footer is that Esc stops the turn. Two things have
  // to hold: the user is told, and the turn does not carry on afterwards.
  // The second is the one that matters — a spinner that stops while a
  // minute-long command keeps running is a lie about the machine.
  // The promise on the footer is that Esc stops the turn, and what it
  // leaves behind. A cancel that quietly forgets the command it killed
  // produces a transcript claiming the turn did nothing, while the
  // session the next turn resumes from says a command ran — so the row
  // is checked by its own sentence, which nothing else on screen can
  // produce.
  const after = screen.renderAll();
  if (!after.includes("cancelled")) {
    process.stderr.write("\npreview failed: Esc stopped the turn without saying so\n");
    app.unmount();
    process.exit(1);
  }
  if (!after.includes("interrupted around this call")) {
    process.stderr.write(
      "\npreview failed: Esc killed the tool call and left no row for it — the transcript claims nothing ran\n",
    );
    app.unmount();
    process.exit(1);
  }
  if ((roundsAsked.get("cancel this") ?? 0) !== 1) {
    process.stderr.write(
      "\npreview failed: the turn kept going after Esc — the model was asked again\n",
    );
    app.unmount();
    process.exit(1);
  }

  // The regression this guards. The transcript used to be a bounded window that
  // was redrawn on every frame, so it overwrote the terminal's scrollback and
  // earlier answers were genuinely unreachable — reading one back meant the
  // app's own PageUp handler, which is exactly the thing that made scrolling
  // feel broken. Native scrolling reads from the output stream instead, so the
  // simplest questions from the start of this run must still be in it.
  // Every question the driver typed has to reach the model as itself. A
  // transcript where one user entry holds two questions concatenated is a
  // composer that did not clear when it was submitted, and the second question
  // is silently lost — which is what a frame check cannot see, because the frame
  // looks perfectly reasonable.
  const mangled = [...roundsAsked.keys()].filter((asked) => !submitted.includes(asked));
  if (mangled.length > 0) {
    process.stderr.write(
      `\npreview failed: the model received a question the driver never typed as typed: ${JSON.stringify(mangled)}\n`,
    );
    app.unmount();
    process.exit(1);
  }

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

  if (screen.unhandled.size > 0) {
    process.stderr.write(
      "\npreview failed: the terminal emulator did not understand " +
        `${screen.unhandled.size} escape sequence(s) that move the cursor or erase cells, ` +
        `so at least one frame above is a guess (and ${screen.ignored} attribute-only ones were ignored): ` +
        JSON.stringify(Object.fromEntries(screen.unhandled)) +
        "\n",
    );
    app.unmount();
    process.exit(1);
  }

  if (finished.length !== started.length) {
    process.stderr.write(
      "\npreview failed: show() was called without awaiting it, so these frames were " +
        "still waiting for the screen to settle when the run ended: " +
        started.slice(finished.length).join(", ") +
        "\n",
    );
    app.unmount();
    process.exit(1);
  }
  if (repeated.length > 0) {
    process.stderr.write(
      `\npreview failed: ${repeated.length} frame(s) were identical to the frame before them \u2014 ` +
        `the script finished before the camera did, so those frames check nothing: ${repeated.join(", ")}\n`,
    );
    app.unmount();
    process.exit(1);
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
