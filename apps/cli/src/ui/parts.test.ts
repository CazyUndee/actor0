import assert from "node:assert/strict";
import test from "node:test";
import {
  bannerActivity,
  bannerLines,
  fitTail,
  proseWidth,
  renderTable,
  segments,
  shortenPath,
  toolDetail,
  toolRowFailed,
  wrapText,
  type Segment,
} from "./parts.js";

/**
 * The footer's layout arithmetic and the live region's height budget, without
 * a terminal.
 *
 * This used to cover the transcript's height budget as well — `fitEntries`,
 * `windowEntries`, `estimateEntryRows` — all of which existed to keep a bounded
 * window of the conversation on screen. The transcript now lives in the
 * terminal's scrollback, so there is no window to size and nothing to fit.
 *
 * What replaced them is `fitTail`, which bounds only the in-flight answer. That
 * one still matters: an unbounded frame is what puts Ink into the clear-and-
 * repaint mode that wipes the scrollback, so the budget is not cosmetic.
 */

const tool = (over: Partial<{ name: string; status: "ok" | "error"; output: string }> = {}) =>
  ({ kind: "tool", name: "shell", target: "ls", status: "ok", output: "", ...over }) as const;

test("a shell command that exited non-zero is a failed row, not a successful one", () => {
  const row = tool({ output: "no such file\n\nCommand exited with code 1" });
  assert.equal(toolRowFailed(row), true);
  assert.equal(toolRowFailed(tool({ output: "fine\n" })), false);
  assert.equal(toolRowFailed(tool({ output: "Command exited with code 0" })), false);
});

test("a tool that threw is a failed row whatever it printed", () => {
  assert.equal(toolRowFailed(tool({ status: "error", output: "ENOENT" })), true);
  assert.equal(toolRowFailed(tool({ status: "error", output: "" })), true, "an error with no text is still an error");
});

test("only a shell row reads its exit code out of the text", () => {
  // A `read` that happens to contain the words is a read, and must not be
  // relabelled on the strength of a sentence in a file.
  assert.equal(
    toolRowFailed(tool({ name: "read", output: "Command exited with code 1" })),
    false,
  );
});

test("a path that fits is left alone", () => {
  assert.equal(shortenPath("C:\\work\\app", 20), "C:\\work\\app");
  assert.equal(shortenPath("~/code/thing", 40), "~/code/thing");
});

test("shortening keeps the end of the path, not the start", () => {
  const full = "C:\\Users\\someone\\AppData\\Local\\Temp\\actor0-preview-abc123\\summary.md";
  const short = shortenPath(full, 30);
  assert.ok(short.length <= 30, `got ${short.length} chars: ${short}`);
  assert.ok(short.startsWith("…"), "the truncation marker leads");
  assert.ok(short.endsWith("summary.md"), `lost the filename: ${short}`);
});

test("shortening a path with no separators truncates from the left", () => {
  const short = shortenPath("a".repeat(80), 20);
  assert.ok(short.length <= 20);
  assert.ok(short.startsWith("…"));
});

test("shortening degrades gracefully at one character of budget", () => {
  const short = shortenPath("C:\\a\\b\\c\\d\\e", 4);
  assert.ok(short.length <= 4, `got ${short.length}: ${short}`);
});

test("the marker is paid for out of the budget, not added on top", () => {
  for (const max of [2, 3, 4, 5, 8, 12, 20]) {
    // The backslashes are doubled deliberately. Written as `"C:\a\b\c\d\e"`
    // this reads like a Windows path, but only `\b` is a real string escape —
    // it is a backspace — and `\a`, `\c`, `\d` and `\e` are not escapes at all,
    // so they collapse to the bare letters `a`, `c`, `d`, `e`. What reached
    // `shortenPath` was one unbroken segment with no separator anywhere in it,
    // which sent it down the single-segment early return and left the
    // multi-segment budget this test is named for completely unexercised.
    const short = shortenPath("C:\\a\\b\\c\\d\\e", max);
    assert.ok(short.length <= max, `max ${max} produced ${short.length} chars: ${short}`);
  }
});

test("a single-segment path never exceeds the budget either", () => {
  for (const max of [1, 2, 3, 5]) {
    const short = shortenPath("abcdefghij", max);
    assert.ok(short.length <= max, `max ${max} produced ${short.length}: ${short}`);
  }
});

test("text that fits is untouched", () => {
  assert.equal(fitTail("one\ntwo\nthree", 10, 80), "one\ntwo\nthree");
  assert.equal(fitTail("", 10, 80), "");
});

test("the tail is kept and the head dropped", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const kept = fitTail(lines.join("\n"), 5, 80);
  assert.deepEqual(kept.split("\n"), ["line 45", "line 46", "line 47", "line 48", "line 49"]);
});

test("the budget is in rows, so wide lines cannot slip past it", () => {
  // Four 201-character lines occupy three terminal rows each at 78 columns.
  // Counting them as four lines would pass all twelve rows through a seven-row
  // budget. Counting before wrapping got the opposite thing wrong: it kept
  // whole lines and so kept more rows than the budget said.
  const wide = `${0}${"x".repeat(200)}`;
  const source = Array.from({ length: 4 }, (_, i) => `${i}${"x".repeat(200)}`).join("\n");
  assert.equal(wide.length, 201);
  const kept = fitTail(source, 7, 80);
  assert.equal(kept.split("\n").length, 7, "exactly the budget, no more");
  for (const line of kept.split("\n")) assert.ok(line.length <= 78, `line of ${line.length} columns`);
});

test("an unbroken paragraph is trimmed to the budget, not kept whole", () => {
  // The one case the old rule broke on. A model that answers in a single
  // paragraph streams it as one line, so "always keep the newest line" kept
  // all six rows of it through a three-row budget — and a frame that tall is
  // what makes Ink wipe the scrollback to repaint. The newest *row* is what
  // has to survive; the rest of the paragraph is what gets dropped.
  const kept = fitTail("x".repeat(400), 3, 80);
  assert.equal(kept.split("\n").length, 3, "a 400-character paragraph is six rows, not one");
  for (const line of kept.split("\n")) assert.ok(line.length <= 78, `line of ${line.length} columns`);
  // 400 characters at 78 columns is six rows — five of 78 and one of 10 —
  // and the three kept are the last of them: 78 + 78 + 10, the tail of what
  // was said rather than the head.
  assert.equal(kept.split("\n").join(""), "x".repeat(166), "the tail of the paragraph, not the head");
});

test("a zero or negative budget yields nothing rather than throwing", () => {
  assert.equal(fitTail("anything", 0, 80), "");
  assert.equal(fitTail("anything", -5, 80), "");
});

test("a budget of one row still shows the newest line", () => {
  const kept = fitTail("old\nnewest", 1, 80);
  assert.equal(kept, "newest");
  const wrapped = fitTail("head " + "y".repeat(400) + " tail", 1, 80);
  assert.ok(wrapped.length <= 78 && wrapped.endsWith("tail"), `one row must end at the newest text, got ${JSON.stringify(wrapped.slice(-12))}`);
});
test("a fenced code block is a segment, and the fences survive it", () => {
  const parts = segments("before\n```ts\nconst x = 1;\n```\nafter");
  assert.deepEqual(parts, [
    { kind: "text", text: "before" },
    { kind: "code", open: "```ts", body: ["const x = 1;"], close: "```" },
    { kind: "text", text: "after" },
  ]);
});

test("an unterminated fence is still code — that is the streaming case", () => {
  // For most of a streaming answer the closing fence has not arrived. Treating
  // the half-block as prose is what wraps the content that is about to be code.
  const parts = segments("here it is:\n```sh\nnpm run build");
  assert.equal(parts.length, 2);
  assert.equal(parts[1]?.kind, "code");
  assert.deepEqual(parts[1], { kind: "code", open: "```sh", body: ["npm run build"], close: "" });
});

test("four-space indentation is code, not a closing fence", () => {
  // A docstring or a YAML block containing an indented ``` must not end the
  // block. CommonMark allows up to three spaces of fence indent, and the rule is
  // load-bearing: without it the rest of a real code block gets word-wrapped.
  const body = ['    ```', "    still code", "    ```"];
  const parts = segments(["```py", ...body, "```"].join("\n"));
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.kind, "code");
  assert.deepEqual(parts[0], { kind: "code", open: "```py", body, close: "```" });
});

test("tildes fence too, and a backtick run does not close a tilde fence", () => {
  const tilde = segments(["~~~", "a ``` inside", "~~~"].join("\n"));
  assert.deepEqual(tilde, [{ kind: "code", open: "~~~", body: ["a ``` inside"], close: "~~~" }]);
});

test("a longer fence closes a shorter opening", () => {
  const parts = segments(["````", "```", "````"].join("\n"));
  assert.deepEqual(parts, [{ kind: "code", open: "````", body: ["```"], close: "````" }]);
});

test("a code line costs one row however long it is", () => {
  // The budget used to wrap first and count afterwards, which put prose and
  // code through the same arithmetic and wrapped a command to fit a row count.
  const command = `npm run ${"very-long-package-name ".repeat(6)}`;
  assert.ok(command.length > 78);
  const kept = fitTail(["intro", "```sh", command, "```", "outro"].join("\n"), 5, 80);
  assert.ok(kept.includes(command), "a code line past the width is carried whole, not folded");
  assert.equal(kept.split("\n").length, 5, "and it still costs exactly the one row it occupies");
});

test("a tail that starts inside a code block keeps rendering as code", () => {
  // Trimming mid-block leaves an unterminated fence, which has to survive as
  // code rather than turning the rest of the answer into prose.
  const text = ["one", "```js", "a", "b", "c", "```", "after"].join("\n");
  const kept = fitTail(text, 7, 80);
  assert.deepEqual(
    segments(kept),
    [
      { kind: "text", text: "one" },
      { kind: "code", open: "```js", body: ["a", "b", "c"], close: "```" },
      { kind: "text", text: "after" },
    ],
    "a tail that keeps both fences must reassemble into the same segments",
  );
});

test("wrapping leaves no leading space on the continuation line", () => {
  // Ink wraps with trim:false and keeps the space it broke on, so pre-wrapping
  // is what keeps ordinary prose from looking mis-indented.
  const wrapped = wrapText("I am listing the files in the directory to understand it", 30);
  for (const line of wrapped.split("\n")) {
    assert.equal(line, line.trimStart(), `line has a leading space: ${JSON.stringify(line)}`);
  }
});

test("wrapping never loses or duplicates a word", () => {
  const source = "the quick brown fox jumps over the lazy dog again and again and again";
  assert.equal(wrapText(source, 20).split(/\s+/).join(" "), source);
});

test("a word longer than the line is cut rather than dropped", () => {
  const wrapped = wrapText("short " + "x".repeat(50), 20);
  assert.equal(wrapped.replace(/\s+/g, ""), ("short" + "x".repeat(50)).replace(/\s+/g, ""));
});

test("text that fits is not touched, and existing newlines are kept", () => {
  assert.equal(wrapText("one\ntwo", 80), "one\ntwo");
  assert.equal(wrapText("short line", 80), "short line");
});

const card = (over: Partial<Parameters<typeof bannerLines>[0]> = {}) =>
  bannerLines({
    title: "actor0",
    version: "0.1.0",
    model: "gpt-5.6-terra",
    endpoint: "aestral-chat.vercel.app",
    directory: "~/projects/actor0-cli",
    activity: "ready",
    width: 60,
    ...over,
  });
const text = (lines: ReturnType<typeof bannerLines>) => lines.map((line) => line.map((c) => c.text).join(""));

test("every line of the card is the same width, border to border", () => {
  // The short lines are the trap: a title and a blank row are far narrower than
  // the box, and without padding to the inner width the right border falls off
  // them and the card stops reading as a box.
  const rendered = text(card());
  const widths = new Set(rendered.map((line) => line.length));
  assert.equal(widths.size, 1, `ragged card: ${[...widths].join(", ")}`);
  assert.ok(rendered[0]!.startsWith("╭") && rendered[0]!.endsWith("╮"));
  assert.ok(rendered.at(-1)!.startsWith("╰") && rendered.at(-1)!.endsWith("╯"));
});

test("the card opens and closes with corners and sides with pipes", () => {
  const rendered = text(card());
  assert.match(rendered[0]!, /^╭─+╮$/);
  assert.match(rendered.at(-1)!, /^╰─+╯$/);
  for (const line of rendered.slice(1, -1)) {
    assert.ok(line.startsWith("│ ") && line.endsWith(" │"), `not sided: ${JSON.stringify(line)}`);
  }
});

test("the label column is the same width on every row", () => {
  const rendered = text(card());
  const rows = rendered.filter((line) => /^│ (model|endpoint|directory|activity):/.test(line));
  assert.equal(rows.length, 4);
  // `│ ` is two columns and the label column is eleven, so every value has to
  // begin at the same one or the card reads as four unrelated lines.
  const starts = rows.map((row) => {
    const at = row.slice(13).search(/\S/);
    return at === -1 ? -1 : at + 13;
  });
  assert.deepEqual([...new Set(starts)], [13], `values start at ${starts.join(", ")}`);
});

test("the hint is right-aligned in the value column", () => {
  const rendered = text(card({ hint: "/model to change" }));
  const model = rendered[3]!;
  // Strip the borders before asking whether it is flush: the line ends in " │",
  // which trimEnd cannot remove, and the hint would always look one short.
  const inner = model.slice(2, -2);
  assert.ok(inner.includes("gpt-5.6-terra"), "the value was pushed out by its hint");
  assert.ok(inner.trimEnd().endsWith("/model to change"), `the hint is not flush right: ${JSON.stringify(inner)}`);
});

test("a value too long for its column is cut, not wrapped", () => {
  const rendered = text(card({ model: "m".repeat(200), width: 50 }));
  for (const line of rendered) assert.ok(line.length <= 50, `line overflowed: ${line.length}`);
  assert.ok(rendered[3]!.includes("…"));
});

test("a narrow terminal still produces a closed card", () => {
  const rendered = text(card({ width: 10, model: "x".repeat(80) }));
  const widths = new Set(rendered.map((line) => line.length));
  assert.equal(widths.size, 1, "the card fell apart when squeezed");
});

test("the activity row reports the thing happening now", () => {
  const live = (over: Record<string, unknown> = {}) =>
    ({ text: "", reasoning: "", partial: false, ...over }) as Parameters<typeof bannerActivity>[0];
  assert.equal(bannerActivity(live()), "ready");
  assert.equal(bannerActivity(live({ status: "Checking repository access" })), "Checking repository access");
  assert.equal(bannerActivity(live({ tool: { name: "bash", target: "ls -F" } })), "bash ls -F");
  assert.equal(bannerActivity(live({ retrying: { attempt: 2 } })), "retrying (attempt 2)");
  assert.equal(bannerActivity(live({ text: "First sentence. The latest one." })), "The latest one.");
});

test("a successful call shows one line of what it returned", () => {
  assert.equal(toolDetail("ok", "notes.md\nREADME.md\nsrc"), "notes.md");
});

test("a successful call's line is flattened, so a wrapping table stays readable", () => {
  assert.equal(toolDetail("ok", "total  12\tdrwxr-xr-x  root  root"), "total 12 drwxr-xr-x root root");
});

test("a bare section label is skipped in favour of what it labels", () => {
  // The bash tool writes "stderr:" above the message. Reporting the label would
  // tell the reader nothing about why the command produced no stdout.
  assert.equal(
    toolDetail("ok", "stderr:\nwc: missing.md: No such file or directory\n\nCommand exited with code 1"),
    "wc: missing.md: No such file or directory",
  );
});

test("a message that merely contains a colon is not mistaken for a label", () => {
  assert.equal(toolDetail("ok", "error: disk full"), "error: disk full");
});

test("a command that succeeded silently says so", () => {
  assert.equal(toolDetail("ok", "(no output)"), "(no output)");
});

test("a successful call's line is capped rather than allowed to flood the trace", () => {
  const detail = toolDetail("ok", "x".repeat(400));
  assert.equal(detail.length, 100);
  assert.ok(detail.endsWith("…"));
});

test("empty output says nothing rather than printing a blank line", () => {
  assert.equal(toolDetail("ok", ""), "");
  assert.equal(toolDetail("ok", "   \n  "), "");
  assert.equal(toolDetail("error", ""), "");
});

test("a failure keeps every line, because the message is the point", () => {
  const message = "exit 127\nbash: ls: command not found";
  assert.equal(toolDetail("error", message), message);
});

test("a very long failure is capped and says how much was dropped", () => {
  const detail = toolDetail("error", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(detail.split("\n").length, 9);
  assert.match(detail.split("\n").at(-1)!, /22 more lines$/);
});

const TABLE = [
  "| Command | What it does | Cost |",
  "| --- | --- | --- |",
  "| npm test | every suite | 20s |",
  "| npm run build | harness then cli | 8s |",
].join("\n");

/** The one table segment in `text`, failing loudly if there is not exactly one. */
function tableIn(text: string): Extract<Segment, { kind: "table" }> {
  const tables = segments(text).filter((segment) => segment.kind === "table");
  assert.equal(tables.length, 1, `expected one table segment in ${JSON.stringify(text)}`);
  return tables[0] as Extract<Segment, { kind: "table" }>;
}

/** A grid row's cells, with the padding stripped, for comparing what lined up. */
function cellsOf(line: string): string[] {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

/**
 * The physical rows `Lines` will paint, composed the same way the component
 * composes them. A test that budgets rows against this is measuring what the
 * reader sees rather than how many lines of markdown the model happened to
 * write.
 */
function physicalRows(text: string, columns: number): string[] {
  const out: string[] = [];
  for (const segment of segments(text)) {
    if (segment.kind === "text") {
      out.push(...wrapText(segment.text, columns).split("\n"));
    } else if (segment.kind === "table") {
      out.push(...renderTable(segment, columns));
    } else {
      out.push(segment.open, ...segment.body);
      if (segment.close) out.push(segment.close);
    }
  }
  return out;
}

test("a markdown table is laid out as a grid, every value under its own header", () => {
  const lines = renderTable(tableIn(TABLE), 100);
  assert.equal(lines.length, 4, "header, rule, and one line per row");
  // Every line the same width is what "aligned" means here. The header is the
  // one trimmed at the end, so it is the one to measure everything against.
  for (const line of lines) assert.equal(line.length, lines[0]!.length);
  assert.deepEqual(cellsOf(lines[0]!), ["Command", "What it does", "Cost"]);
  assert.deepEqual(cellsOf(lines[2]!), ["npm test", "every suite", "20s"]);
  assert.deepEqual(cellsOf(lines[3]!), ["npm run build", "harness then cli", "8s"]);
});

test("the rule under a grid spans the padded cell, not the text inside it", () => {
  const lines = renderTable(tableIn("| A | B |\n| --- | --- |\n| 1 | 2 |"), 100);
  assert.deepEqual(lines, ["| A   | B   |", "|-----|-----|", "| 1   | 2   |"]);
  // The cells are three wide and the rule is five, because every cell is
  // rendered with a space either side. A rule of three would sit under the text
  // and a column to the left of where a reader looks for it.
  assert.equal(lines[1]!.length, lines[0]!.length);
});

test("alignment markers are honoured: :--- left, :---: centre, ---: right", () => {
  const lines = renderTable(tableIn("| l | c | r |\n| :--- | :---: | ---: |\n| a | b | c |"), 100);
  assert.deepEqual(lines, ["| l   |  c  |   r |", "|-----|-----|-----|", "| a   |  b  |   c |"]);
});

test("a column is as wide as its widest cell, and the grid is drawn only if it fits", () => {
  const wide = renderTable(tableIn(TABLE), 100);
  const border = wide[0]!.length;
  // Command 13, What it does 16, Cost 4 — each cell plus a space either side.
  assert.equal(border, 1 + (13 + 3) + (16 + 3) + (4 + 3));
  for (const line of wide) assert.equal(line.length, border);
  // One column narrower and the grid is not drawn at all, because Ink would
  // cut the last column off mid-value and leave it attached to nothing.
  for (const line of renderTable(tableIn(TABLE), border - 1)) {
    assert.ok(!line.startsWith("|"), `a grid that does not fit was drawn: ${line}`);
  }
});

test("a grid too wide for the terminal becomes key/value lines and loses no value", () => {
  const lines = renderTable(tableIn(TABLE), 20);
  // Whitespace-normalised: a value long enough to wrap is still present, it
  // just has a newline inside it now. What must never happen is one vanishing.
  const joined = lines.join(" ").replace(/\s+/g, " ");
  for (const value of ["npm test", "every suite", "20s", "npm run build", "harness then cli", "8s"]) {
    assert.ok(joined.includes(value), `dropped ${value} on the way to key/value`);
  }
  assert.ok(lines.includes("Command: npm test"));
  // This is the whole point: a value that migrates out of its own column is
  // worse than no table, because it is confidently attached to the wrong row.
  assert.equal(lines.includes("20s"), false, "a bare value has lost its label");
});

test("the key/value fallback obeys the same row budget as prose", () => {
  const border = renderTable(tableIn(TABLE), 100)[0]!.length;
  // Only widths where the grid does *not* fit, so this is really the fallback
  // being measured. At a width where the grid is drawn it is sized to its own
  // content instead, and comparing that against `proseWidth` compares two
  // different things.
  const narrow = [12, 20, 30, border - 1].filter((columns) => columns < border);
  assert.ok(narrow.length >= 3, `expected several fallback widths, got ${narrow.length}`);
  for (const columns of narrow) {
    for (const line of renderTable(tableIn(TABLE), columns)) {
      // The fallback *is* prose, so it inherits `proseWidth` exactly — the
      // two-column margin and the floor of 20. Sizing it against raw `columns`
      // is how the rule under it used to overflow by one.
      assert.ok(
        line.length <= proseWidth(columns),
        `${line.length} > ${proseWidth(columns)} at columns ${columns}: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("a pipe in prose is not a table, however many of them there are", () => {
  for (const text of [
    "Pipe one into the other: a | b",
    "| a | b |\n| c | d |",
    "One | Two | Three\nnot a delimiter row at all |",
  ]) {
    assert.equal(segments(text).some((segment) => segment.kind === "table"), false, text);
  }
});

test("a header with no rows is still a table, because that is what streaming looks like", () => {
  const table = tableIn("| Command | Cost |\n| --- | --- |\n");
  assert.deepEqual(table.rows, []);
  assert.equal(renderTable(table, 80).length, 2);
});

test("an escaped pipe stays inside its cell instead of making a new one", () => {
  const table = tableIn("| a | b |\n| --- | --- |\n| x \\| y | z |");
  assert.deepEqual(table.rows, [["x | y", "z"]]);
});

test("fitTail's row budget counts a table by what it renders, at every width", () => {
  const answer = `intro\n\n${TABLE}\n\n\`\`\`sh\nnpm run build\n\`\`\`\n\nafter`;
  for (const columns of [20, 44, 100]) {
    const painted = physicalRows(answer, columns);
    for (const rows of [1, 2, 5, painted.length - 1, painted.length]) {
      const kept = fitTail(answer, rows, columns).split("\n");
      const where = `columns ${columns}, rows ${rows}`;
      assert.equal(kept.length, Math.min(rows, painted.length), where);
      // Not just the right count — the right rows. A budget counted in lines of
      // markdown instead of rendered rows gets this wrong the moment a table
      // is wrapped, which is precisely when it matters.
      assert.deepEqual(kept, painted.slice(-rows), where);
    }
  }
});
