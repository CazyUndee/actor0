import { Box, Static, Text, useStdout } from "ink";
import { Fragment } from "react";
import { useEffect, useState, type ReactNode } from "react";
import { stripReasoningMarkup } from "@actor0/harness";
import type { Entry, Live } from "../conversation.js";
import { HELP_TEXT } from "../slash.js";
import { color, SPINNER_FRAMES, toolGlyph } from "../theme.js";
import { exitedNonZero, toolLabel } from "../tools.js";

/**
 * Presentational components.
 *
 * These are the terminal counterparts of CronixUI's React components. They
 * cannot be the *same* components — those render DOM nodes against a
 * stylesheet — but they are driven by the same tokens, so the two surfaces
 * read as one product.
 *
 * Every colour here comes from `theme.ts`, which is generated from CronixUI.
 * No literal colour appears in this file.
 */

/** Width of the label column, so every value in the card starts on the same one. */
const LABEL_COL = 11;

/** Never narrower than this, however small the terminal claims to be. */
const CARD_MIN = 44;

/** What a run of text in the card is for. Ink colours per `<Text>`, not per string. */
export type BannerTone = "title" | "label" | "value" | "dim";

/** One run of text with its tone. Concatenating a line's cells gives the line. */
export type BannerCell = { text: string; tone: BannerTone };

/**
 * The card's lines, already padded.
 *
 * Layout is separated from rendering for the same reason the rest of this file
 * is: padding a box by hand is exactly the arithmetic that is silent when it is
 * wrong, and it is the kind you want to test without a terminal. The result is
 * tone-tagged segments rather than a finished string, because a colour in
 * Ink belongs to the `<Text>` that wraps it — baking escape codes into the text
 * would make the whole thing untestable and would fight the renderer.
 */
export function bannerLines(opts: {
  title: string;
  version: string;
  model: string;
  endpoint: string;
  directory: string;
  activity: string;
  /** Right-aligned in the value column, the way Codex puts `/model` there. */
  hint?: string;
  width?: number;
}): BannerCell[][] {
  const width = Math.max(CARD_MIN, opts.width ?? 80);
  const inner = width - 4;

  /**
   * One value, truncated to its column, with an optional right-aligned hint.
   *
   * The filler goes *before* the hint rather than being left to the row's
   * padding, so the hint actually sits against the right border. Padding after
   * it would leave the hint floating three columns in from the edge, which is
   * the one place a reader looks for it.
   */
  const cell = (value: string, hint?: string): BannerCell[] => {
    const available = inner - LABEL_COL;
    if (!hint) {
      const text = value.length > available ? `${value.slice(0, Math.max(0, available - 1))}…` : value;
      return [{ text, tone: "value" }];
    }
    const gap = 3;
    const room = Math.max(1, available - hint.length - gap);
    const text = value.length > room ? `${value.slice(0, Math.max(0, room - 1))}…` : value;
    return [
      { text, tone: "value" },
      { text: " ".repeat(Math.max(gap, room - text.length + gap)), tone: "dim" },
      { text: hint, tone: "dim" },
    ];
  };

  const label = (text: string): BannerCell[] => [{ text: text.padEnd(LABEL_COL), tone: "label" }];

  const lines: BannerCell[][] = [
    [{ text: `>_ ${opts.title} (v${opts.version})`, tone: "title" }],
    [],
    [...label("model:"), ...cell(opts.model, opts.hint)],
    [...label("endpoint:"), ...cell(opts.endpoint)],
    [...label("directory:"), ...cell(opts.directory)],
    [...label("activity:"), ...cell(opts.activity)],
  ];

  // An edge carries one character of corner at each end; a row carries a pipe
  // and a space at each end. The rule is two characters narrower than the row
  // it caps, so the dashes are two longer than `inner` or the top and bottom of
  // the box come up short of its sides.
  const edge = (left: string, right: string): BannerCell[] => [
    { text: left + "─".repeat(inner + 2) + right, tone: "dim" },
  ];
  /** Every line is exactly `inner` wide, or the right border falls off the short ones. */
  const pad = (line: BannerCell[]): BannerCell[] => {
    const used = line.reduce((total, cell) => total + cell.text.length, 0);
    return used >= inner ? line : [...line, { text: " ".repeat(inner - used), tone: "dim" }];
  };
  return [
    edge("╭", "╮"),
    ...lines.map((line) => [{ text: "│ ", tone: "dim" as const }, ...pad(line), { text: " │", tone: "dim" as const }]),
    edge("╰", "╯"),
  ];
}

/**
 * What the card's activity row says right now.
 *
 * The card is the only chrome visible while the transcript is empty, so this is
 * the one place that says what the agent is doing before there is any
 * transcript to say it in. The *latest* thing is what matters: "I am checking
 * the files" is useful while it is happening and noise once it is finished.
 */
export function bannerActivity(live: Live): string {
  const lastSentence = (text: string): string => {
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (!trimmed) return "";
    return trimmed.split(/(?<=[.!?])\s/).at(-1) ?? trimmed;
  };
  if (live.tool) return `${live.tool.name}${live.tool.target ? ` ${live.tool.target}` : ""}`;
  if (live.status) return live.status;
  if (live.retrying) return `retrying (attempt ${live.retrying.attempt})`;
  if (live.text) return lastSentence(live.text);
  if (live.reasoning.trim()) return lastSentence(live.reasoning);
  return "ready";
}

/**
 * One piece of an answer: prose, or a fenced code block with its fences intact.
 *
 * The fences are carried rather than consumed so a pass that trims the text
 * (`fitTail`) can flatten and rejoin without losing them.
 */
/** Which way a table column lines its cells up. */
export type Align = "left" | "center" | "right";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; open: string; body: string[]; close: string }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] };

/**
 * A line that opens or closes a fence: up to three spaces of indent, then a
 * run of three or more backticks or tildes, then anything.
 *
 * Three spaces is CommonMark's rule and it is load-bearing here, not pedantry.
 * A run of four or more is code indentation, so a Python docstring or a YAML
 * block containing an indented ``` does not close the block early and get
 * word-wrapped for the rest of its body.
 */
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/**
 * A table's delimiter cell: `:---:` centres, `:---` is left, `---:` is right,
 * and a bare `---` is left, which is the default and needs no marker.
 */
const RULE = /^:?-+:?$/;

/**
 * Stands in for an escaped pipe while cells are being split.
 *
 * A control character rather than a space, because a cell may legitimately
 * contain a space — and a placeholder that collides with real content
 * moves a cell boundary silently, which is the exact failure this function
 * exists to prevent.
 */
const ESCAPED_PIPE = "\u0000";

/**
 * Split a pipe row into its cells.
 *
 * The outer pipes are optional, which GFM allows. An escaped `\|` is a literal
 * pipe rather than a separator — done with a placeholder rather than a
 * lookbehind, for the reason Claude Code gives in its own markdown parser:
 * a lookbehind defeats the JIT on some of the engines this ships to.
 */
function cells(line: string): string[] {
  const body = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .replace(/\\\|/g, ESCAPED_PIPE);
  return body.split("|").map((cell) => cell.trim().split(ESCAPED_PIPE).join("|"));
}

/** Read the alignment a delimiter cell asks for. */
function alignmentOf(mark: string): Align {
  const left = mark.startsWith(":");
  const right = mark.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/**
 * Read the table starting at `start`, if there is one.
 *
 * The delimiter row is what makes this a table rather than prose that happens to
 * contain a pipe, and prose containing a pipe is everywhere: shell pipelines,
 * `a | b`, set notation. So a header row alone is not enough — it must be
 * followed by a row whose cells are all `:?-+:?` and whose count matches.
 *
 * A one-column table is left as prose: there is no column to line anything up
 * against, and the grid would be a box around a single sentence.
 */
function tableAt(
  lines: string[],
  start: number,
): { header: string[]; align: Align[]; rows: string[][]; next: number } | undefined {
  const header = cells(lines[start]!);
  const delimiter = lines[start + 1];
  if (header.length < 2 || delimiter === undefined) return undefined;
  const marks = cells(delimiter);
  if (marks.length !== header.length) return undefined;
  if (!marks.every((mark) => RULE.test(mark))) return undefined;

  const rows: string[][] = [];
  let next = start + 2;
  while (
    next < lines.length &&
    lines[next]!.includes("|") &&
    cells(lines[next]!).length === header.length
  ) {
    rows.push(cells(lines[next]!));
    next += 1;
  }
  // `rows` is allowed to be empty. A header with no body is what a table looks
  // like for the frames between its delimiter row and its first row arriving,
  // and rendering it as prose would make it visibly flip shape mid-stream.
  return { header, align: marks.map(alignmentOf), rows, next };
}

/** Break a run of prose into text and table segments. */
function splitTables(lines: string[]): Segment[] {
  const out: Segment[] = [];
  let pending: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const table = tableAt(lines, index);
    if (!table) {
      pending.push(lines[index]!);
      index += 1;
      continue;
    }
    if (pending.length > 0) {
      out.push({ kind: "text", text: pending.join("\n") });
      pending = [];
    }
    out.push({
      kind: "table",
      header: table.header,
      align: table.align,
      rows: table.rows,
    });
    index = table.next;
  }
  if (pending.length > 0) out.push({ kind: "text", text: pending.join("\n") });
  return out;
}

/**
 * Pad `content` to `targetWidth` according to `align`.
 *
 * Ported from Claude Code's `padAligned`, which is worth copying exactly: the
 * caller passes the visible width separately, so styling inside `content`
 * cannot change how much padding is added and quietly break every column after
 * it.
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: Align,
): string {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return " ".repeat(left) + content + " ".repeat(padding - left);
  }
  if (align === "right") return " ".repeat(padding) + content;
  return content + " ".repeat(padding);
}

/**
 * Lay a table out as a grid, or as key/value lines when the grid will not fit.
 *
 * The grid is Claude Code's plain-text table layout, taken from the `table`
 * case of its `formatToken`: a column is as wide as the widest cell in it and
 * never less than three, cells are padded with `padAligned`, and each row is
 * trimmed at the end so the last column does not drag a tail of spaces behind
 * it. The separator row is `width + 2` dashes because the cells are rendered
 * with a space either side — dashes that were only `width` long would sit under
 * the text and one column left of where the reader expects a rule.
 *
 * A grid wider than the terminal is never rendered. Ink would cut the last
 * column off mid-word, and a value that has migrated out of its own column is
 * worse than no table at all — it is confidently attached to the wrong row.
 * Claude Code answers that with a vertical format and so does this: the content
 * is the thing being read, the shape is not.
 *
 * Every returned line is one physical row that Ink will not re-wrap, so callers
 * can take these as the rows they are: the grid is exactly its own border wide,
 * and the fallback obeys the same `proseWidth` budget as every other sentence
 * in the transcript.
 */
export function renderTable(table: Extract<Segment, { kind: "table" }>, columns: number): string[] {
  const widths = table.header.map((cell, column) => {
    let width = cell.length;
    for (const row of table.rows) width = Math.max(width, row[column]?.length ?? 0);
    return Math.max(width, 3);
  });
  const rule = (cellsIn: string[]): string =>
    (
      "| " +
      cellsIn
        .map((cell, column) =>
          padAligned(cell, cell.length, widths[column]!, table.align[column]!) + " | ",
        )
        .join("")
    ).trimEnd();
  const border = 1 + widths.reduce((sum, width) => sum + width + 3, 0);

  // A header with no rows keeps the grid even when it is too wide: the
  // vertical fallback of a row-less table is nothing at all, and a table that
  // renders as nothing is worse than one whose header is cut short.
  if (border > columns && table.rows.length > 0) {
    const out: string[] = [];
    const divider = "-".repeat(Math.max(1, Math.min(proseWidth(columns) - 1, 40)));
    table.rows.forEach((row, index) => {
      if (index > 0) out.push(divider);
      row.forEach((cell, column) => {
        const label = table.header[column] ?? `Column ${column + 1}`;
        // Wrapped here, by this function, so that the "every line fits" promise
        // above holds for the fallback too and callers need no second rule.
        out.push(...wrapText(`${label}: ${cell}`, columns).split("\n"));
      });
    });
    return out;
  }

  return [
    rule(table.header),
    "|" + widths.map((width) => "-".repeat(width + 2) + "|").join(""),
    ...table.rows.map((row) => rule(table.header.map((_, column) => row[column] ?? ""))),
  ];
}


/**
 * Split text into prose and fenced code.
 *
 * The prompt tells the model that "GitHub markdown renders: fenced code
 * blocks", and none of it did: every answer went through the same word wrapper,
 * which breaks a long line inside a code block at an arbitrary column. A
 * wrapped `npm run` is neither runnable nor readable, and a wrapped JSON blob
 * is worse than not showing it.
 *
 * An unterminated fence is a code block to the end of the text, and that is the
 * streaming case rather than an edge case — for most of a streaming answer the
 * closing fence has not arrived yet. Treating it as prose would wrap exactly the
 * content that is about to be code.
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let prose: string[] = [];
  /** The opening fence line, info string and all, for rendering. */
  let open = "";
  /** The fence run alone, for comparing a candidate closer against. */
  let fence = "";
  let body: string[] = [];

  const flushProse = (): void => {
    if (prose.length === 0) return;
    out.push(...splitTables(prose));
    prose = [];
  };
  const endBlock = (close: string): void => {
    out.push({ kind: "code", open, body, close });
    // Both, or the next line after the block joins it: the fence stays set and
    // the rest of the answer arrives as code.
    open = "";
    fence = "";
    body = [];
  };

  for (const line of text.split("\n")) {
    const match = FENCE.exec(line);
    if (fence !== "") {
      const closes =
        match !== null &&
        match[2]!.startsWith(fence[0]!) &&
        match[2]!.length >= fence.length &&
        match[3]!.trim() === "";
      if (closes) endBlock(line.trim());
      else body.push(line);
      continue;
    }
    if (match) {
      flushProse();
      fence = match[2]!;
      open = line.trim();
      continue;
    }
    prose.push(line);
  }

  if (fence !== "") {
    flushProse();
    // Still open at the end: the answer stopped mid-block, or the tokens have
    // not arrived yet.
    out.push({ kind: "code", open, body, close: "" });
    return out;
  }
  flushProse();
  return out;
}

/**
 * The width prose is really wrapped to: two columns short of the terminal, and
 * never narrower than 20.
 *
 * Exported because it is a promise the rest of the renderer has to keep. The
 * key/value table fallback wraps by the same rule, and `fitTail` budgets rows
 * against what is actually painted — so anything sizing itself against raw
 * `columns` is measuring a width no line will ever be.
 */
export function proseWidth(columns: number): number {
  return Math.max(20, columns - 2);
}

/**
 * Wrap to the terminal at spaces, and leave the break behind.
 *
 * Ink wraps a `<Text>` through wrap-ansi with `trim: false`, which keeps the
 * space it broke on — so every continuation line starts with one. In a
 * transcript that is most of the text, which makes ordinary prose look
 * mis-indented. Pre-wrapping makes the break ours: no leading space, and the
 * width is known up front rather than re-guessed by the row budget afterwards.
 */
export function wrapText(text: string, columns: number): string {
  const width = proseWidth(columns);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(" ", width);
      // No space to break on: a long token has to be cut where it stands.
      if (cut <= 0) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
        continue;
      }
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
    }
    out.push(rest);
  }
  return out.join("\n");
}

function Lines({
  text,
  color: tone,
  dim,
  columns = 80,
}: {
  text: string;
  color?: string;
  dim?: boolean;
  columns?: number;
}) {
  return (
    <>
      {segments(text).map((segment, index) =>
        segment.kind === "text" ? (
          wrapText(segment.text, columns).split("\n").map((line, lineIndex) => (
            // eslint-disable-next-line react/no-array-index-key -- transcript lines are positional and append-only
            <Text key={`t${index}-${lineIndex}`} color={tone} dimColor={dim} wrap="truncate-end">
              {line || " "}
            </Text>
          ))
        ) : segment.kind === "table" ? (
          // Already laid out to the terminal by `renderTable`, which promises
          // every line it returns fits `columns`. Wrapping it again here would
          // reflow the grid straight back into the ragged fragments the table
          // was turned into in the first place.
          // eslint-disable-next-line react/no-array-index-key -- grid rows are positional and append-only
          <Fragment key={`g${index}`}>
            {renderTable(segment, columns).map((line, rowIndex) => (
              // eslint-disable-next-line react/no-array-index-key -- grid rows are positional and append-only
              <Text key={`g${rowIndex}`} wrap="truncate-end">
                {line || " "}
              </Text>
            ))}
          </Fragment>
        ) : (
          // Code is never wrapped. A line too long for the terminal is cut with
          // Ink's own ellipsis rather than folded, because a folded command is
          // not a command — and the fence markers are dimmed so the code reads
          // as a quotation instead of as three more lines of the answer.
          // eslint-disable-next-line react/no-array-index-key -- segments are positional and append-only
          <Fragment key={`b${index}`}>
            <Text color={color.dim}>{segment.open}</Text>
            {segment.body.map((line, lineIndex) => (
              // eslint-disable-next-line react/no-array-index-key -- code lines are positional and append-only
              <Text key={`c${lineIndex}`} wrap="truncate-end">
                {line || " "}
              </Text>
            ))}
            {segment.close ? <Text color={color.dim}>{segment.close}</Text> : null}
          </Fragment>
        ),
      )}
    </>
  );
}

/** How much of a successful call's output to show on its line. */
const TOOL_OUTPUT_CHARS = 100;

/**
 * A line that names a block rather than being one — "stderr:".
 *
 * The bash tool prefixes its stderr section with the word "stderr:", so taking
 * the first line of a failed command's output reports the label instead of the
 * only line that says what went wrong. `wc: missing.md: No such file or
 * directory` does not match: it has content after its first colon.
 */
const SECTION_LABEL = /^[A-Za-z][A-Za-z ]*:[ \t]*$/;

/** How many lines of a failure to show before it is cut. */
const TOOL_ERROR_LINES = 8;

/**
 * What a tool line shows beneath it.
 *
 * The tool line itself says *what ran* and never *what came back*, and those are
 * the only two facts anyone gets out of a tool call. With the output hidden, a
 * command that returned a directory listing and one that returned nothing
 * rendered identically — so a model retrying the same command three times read
 * as three successes rather than three failures to make progress, and the only
 * way to tell was to go and run the command by hand.
 *
 * A success gets one dim line: most output is long and uninteresting, and the
 * transcript is a trace, not a log. A failure gets the whole message, up to a
 * cap — it is short, it is the only thing that says what went wrong, and it is
 * exactly the thing that gets hidden behind an ellipsis when a failure takes
 * three attempts to diagnose.
 */
export function toolDetail(status: "ok" | "error", output: string): string {
  const text = output.trim();
  if (!text) return "";
  if (status === "ok") {
    const first =
      text.split("\n").find((line) => line.trim() && !SECTION_LABEL.test(line.trim())) ?? "";
    const flat = first.replace(/\s+/g, " ").trim();
    if (!flat) return "";
    if (flat.length <= TOOL_OUTPUT_CHARS) return flat;
    return `${flat.slice(0, TOOL_OUTPUT_CHARS - 1)}…`;
  }
  const lines = text.split("\n");
  if (lines.length <= TOOL_ERROR_LINES) return text;
  const rest = lines.length - TOOL_ERROR_LINES;
  return [...lines.slice(0, TOOL_ERROR_LINES), `… ${rest} more line${rest === 1 ? "" : "s"}`].join("\n");
}

/**
 * Did this tool row end in a failure?
 *
 * A `shell` command that exits non-zero is a failure even though the call
 * succeeded: the call's success only says the command ran, and the exit code
 * is the outcome. It is also the only channel a failing command has — the
 * result text — so the row has to read it back. Observed in the TUI preview:
 * a command no shell has came back as a green tick over a truncated fragment
 * of its own stderr, with the line naming the exit code trimmed off the end
 * by the success path. The one row a user most needs to trust was lying.
 */
export function toolRowFailed(entry: Entry): boolean {
  return entry.kind === "tool" && (entry.status === "error" || (entry.name === "shell" && exitedNonZero(entry.output)));
}

/**
 * A reasoning block as a title and a body.
 *
 * Models open a reasoning block with a bare title and then repeat it as a
 * heading — "Exploring the repository", then "## Exploring the repository" —
 * because they were asked for a summary line and supply both shapes at once.
 * Rendered verbatim that is two near-identical lines above every answer, with a
 * literal "##" in between, and it is most of what makes a finished turn look
 * like a log dump rather than something a person said.
 *
 * The harness's own summariser is not used here because its title rule only
 * recognises bracketed lines and markdown headings, and this model emits
 * neither; it would fall back to treating the whole block as one 90-character
 * title. So the title is simply the first line when it reads like one — short,
 * and not a sentence that runs on — and everything after it is the body.
 */
function reasonText(text: string): { title: string; body: string } {
  const lines = text
    .split("\n")
    .map((line) => stripReasoningMarkup(line))
    .filter((line) => line.length > 0);
  const first = lines[0] ?? "";
  const looksLikeTitle = first.length > 0 && first.length <= 60 && !/[.!?]$/.test(first);
  if (!looksLikeTitle) return { title: "", body: lines.join(" ") };
  const rest = lines.slice(1).filter((line) => line.toLowerCase() !== first.toLowerCase());
  return { title: first, body: rest.join(" ") };
}

/** One committed transcript entry. */
export function EntryView({ entry, columns = 80 }: { entry: Entry; columns?: number }) {
  switch (entry.kind) {
    case "user":
      // Grey, not accent. What the user typed is already the loudest thing in
      // the transcript and the answer is the thing being read; tinting the
      // prompt the same colour as the agent's activity made their own words
      // look like a tool call.
      return (
        <Box marginTop={1}>
          <Text color={color.muted} bold>
            ❯{" "}
          </Text>
          <Text color={color.muted}>{entry.text}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Lines text={entry.text} columns={columns} />
          {entry.partial ? <Text color={color.warning}>… response ended before completion</Text> : null}
        </Box>
      );

    case "reasoning": {
      const { title, body } = reasonText(entry.text);
      return (
        <Box marginTop={1} flexDirection="column">
          {/* No "thinking" label. The model names the step itself, and a
              generic word above a specific one is a word of noise on every
              entry in the transcript. */}
          {title ? <Text color={color.dim}>{title}</Text> : null}
          {body ? <Lines text={body} color={color.muted} dim columns={columns} /> : null}
        </Box>
      );
    }

    case "plan":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.info} bold>
            {entry.title}
          </Text>
          <Lines text={entry.plan} color={color.muted} columns={columns} />
        </Box>
      );

    case "tool": {
      const status = toolRowFailed(entry) ? "error" : "ok";
      const tone = status === "ok" ? color.success : color.error;
      // Both rows name the tool. They used not to: a failure printed the
      // word “failed” where the success row prints the tool, so the one row a
      // user most wants to act on was the one that never said what went
      // wrong — `✗ failed wc -l missing.md` reads as a failed read of a file
      // called `wc`, and a shell command and a read of the same path become
      // indistinguishable. The status is already carried three ways: the
      // glyph, the colour, and a detail block that an error always has.
      const label = toolLabel(entry.name);
      const detail = toolDetail(status, entry.output);
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={tone}>{toolGlyph[status]} </Text>
            <Text color={color.muted}>{label}</Text>
            {entry.target ? <Text color={color.dim}> {entry.target}</Text> : null}
          </Box>
          {/* Indented, because a failure is often several lines and a
              left-flush block of stderr under the command is hard to tell from
              the next entry. `flexDirection` is required, not decoration: a Box
              defaults to row, which laid the lines of a multi-line failure out
              side by side as one run-on sentence. */}
          {detail ? (
            <Box marginLeft={2} flexDirection="column">
              <Lines text={detail} color={color.dim} columns={columns - 2} />
            </Box>
          ) : null}
        </Box>
      );
    }

    case "notice": {
      const tone =
        entry.tone === "error" ? color.error : entry.tone === "warn" ? color.warning : color.info;
      const label = entry.tone === "error" ? "error" : entry.tone === "warn" ? "warning" : "·";
      return (
        <Box marginTop={1} flexDirection="column">
          {/* Errors wrap; everything else truncates. The tail of a failure is
              the part that says what to do next — "check the URL, the key, and
              the model name" — and truncating the line throws exactly that
              away, which is how a wall of HTML used to hide the diagnosis. */}
          <Text wrap={entry.tone === "error" ? "wrap" : "truncate-end"}>
            <Text color={tone}>{label}</Text>
            <Text color={color.muted}> {entry.text}</Text>
          </Text>
        </Box>
      );
    }

    case "help":
      return (
        <Box flexDirection="column" marginTop={1}>
          {HELP_TEXT.map(([command, description]) => (
            <Text key={command}>
              <Text color={color.accent}>{command.padEnd(16)}</Text>
              <Text color={color.muted}>{description}</Text>
            </Text>
          ))}
          <Box marginTop={1} flexDirection="column">
            <Text color={color.dim}>Esc cancels a running turn · Ctrl+D quits</Text>
          </Box>
        </Box>
      );

    default:
      return null;
  }
}

/**
 * The tail of a block of text that fits `rows` rendered rows.
 *
 * This is the only height budgeting left in the UI, and it applies to the live
 * region alone. Committed entries need none of it: they live in the terminal's
 * scrollback now, so they can be any length. An in-flight answer cannot, because
 * it is redrawn in place on every frame and a frame taller than the terminal
 * puts Ink into the clear-and-repaint mode that destroys the scrollback.
 *
 * The head goes and the tail stays, because the newest tokens are the ones
 * being read. The budget is in rendered rows, not in lines: a 400-character
 * paragraph occupies six terminal rows at 78 columns, and budgeting by line
 * count would let it straight through.
 *
 * The text is wrapped before it is counted, and the row that is always kept is
 * the newest row rather than the newest line. Those are the same thing until
 * the model answers in one unbroken paragraph — which several models do, and
 * which arrives as a *single* line. Counting first, the cost of that one line
 * exceeded the entire budget, and the rule that always keeps the newest line
 * kept all of it. Measured against the real renderer, a 3,419-character
 * paragraph produced a 42-row live region in a 40-row terminal, which is
 * precisely the condition under which Ink stops painting incrementally and
 * wipes the scrollback to repaint — the one outcome this function exists to
 * prevent, and a single unbroken paragraph away.
 */
export function fitTail(text: string, rows: number, columns: number): string {
  if (rows <= 0) return "";
  // Flattened to physical lines first, because the budget is in rendered rows
  // and a row is not the same thing as a line of input. Prose is wrapped — and
  // so becomes exactly as many rows as it takes — while a line of code is one
  // row no matter how long it is, because `Lines` does not wrap code.
  //
  // Wrapping first and counting afterwards used to be the whole implementation,
  // and it put code and prose through the same arithmetic. The fences are
  // carried in the segments, so rejoining the tail cannot lose one.
  const physical: string[] = [];
  for (const segment of segments(text)) {
    if (segment.kind === "text") {
      physical.push(...wrapText(segment.text, columns).split("\n"));
      continue;
    }
    if (segment.kind === "table") {
      physical.push(...renderTable(segment, columns));
      continue;
    }
    physical.push(segment.open, ...segment.body);
    if (segment.close) physical.push(segment.close);
  }
  return physical.slice(-rows).join("\n");
}

/** The volatile region: in-flight reasoning, streamed text, and activity. */
export function LiveView({
  live,
  frame,
  elapsed,
  rows = 20,
  columns = 80,
  waitingOnUser = false,
}: {
  live: Live;
  frame: number;
  elapsed: number;
  /** Rows available to streamed text before the chrome's share is taken. */
  rows?: number;
  columns?: number;
  /** True while a dialog owns the keyboard and nothing is moving on its own. */
  waitingOnUser?: boolean;
}) {
  const animated = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const busy = Boolean(live.text || live.reasoning || live.tool || live.status || live.retrying);
  if (!busy) return null;

  // A spinner next to a dialog that is waiting for a keypress says "work is
  // happening" when the user is the thing stopping it. Freeze it and say so.
  const spinner = waitingOnUser ? "⏸" : animated;

  return (
    <Box flexDirection="column" marginTop={1}>
      {live.retrying ? (
        <Text color={color.warning}>
          {spinner} retrying after an interrupted attempt ({elapsed}s)
        </Text>
      ) : null}

      {live.tool ? (
        <Text>
          <Text color={color.accent}>{spinner} </Text>
          <Text color={color.muted}>
            {live.tool.name}
            {live.tool.target ? ` ${live.tool.target}` : ""}
          </Text>
          {waitingOnUser ? <Text color={color.dim}> — waiting for you</Text> : null}
        </Text>
      ) : null}

      {!live.tool && !live.retrying && live.status ? (
        <Text color={color.muted}>
          <Text color={color.accent}>{spinner} </Text>
          {live.status}
        </Text>
      ) : null}

      {live.reasoning.trim() ? (
        <Box flexDirection="column" marginTop={1}>
          <Lines
            text={fitTail(live.reasoning.trimEnd(), rows, columns)}
            color={color.muted}
            dim
            columns={columns}
          />
        </Box>
      ) : null}

      {live.text ? <Lines text={fitTail(live.text, rows, columns)} columns={columns} /> : null}
    </Box>
  );
}

/**
 * One-line footer: which endpoint, which model, where, and what the next key
 * does.
 *
 * The endpoint is on screen because it is the one fact that decides whether a
 * request can work, and it used to be invisible. A stale `config.json` pointed
 * at one host while the model name named a different provider's model, so every
 * visible signal said everything was fine and the only symptom was an HTML
 * error page from a server that was never asked the right question.
 */
export function StatusBar({
  cwd,
  hint,
  endpoint,
}: {
  cwd: string;
  hint: string;
  endpoint?: string;
}) {
  // Two dim lines, not four. Claude Code, aider and gh all keep the footer to
  // context and the next keystroke; the model is an implementation detail the
  // user set once and never reads again, and spending a whole line on it pushed
  // the path and the hint off an 80-column terminal.
  const line = `${endpoint ? `${endpoint} · ` : ""}${shortenPath(cwd, 52)}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color.dim} wrap="truncate-end">
        {line}
      </Text>
      <Text color={color.dim} wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );
}

/**
 * Keep the end of a path, drop the beginning.
 *
 * A working directory is a long absolute path and the interesting half is the
 * tail — the project, not the drive letter and the home directory. Truncating
 * from the left keeps the footer on one line on an 80-column terminal; a path
 * that wraps pushes the composer off the bottom of the screen.
 */
export function shortenPath(path: string, max: number): string {
  if (max <= 1) return path.slice(-Math.max(0, max));
  if (path.length <= max) return path;
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(separator).filter(Boolean);
  if (parts.length <= 1) return `…${path.slice(-(max - 1))}`;

  // The marker and its separator are spent before any segment is, and are
  // counted in `budget` — the whole point is that the result fits, and a result
  // one character over wraps the dialog it was supposed to keep on one line.
  const marker = `…${separator}`;
  const budget = max - marker.length;
  if (budget <= 0) return path.slice(0, max);

  let out = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const next = `${parts[i]}${separator}${out}`;
    if (next.length > budget) break;
    out = next;
  }
  if (out.length > budget) out = out.slice(-budget);
  return `${marker}${out}`;
}

/**
 * The transcript, handed to the terminal's own scrollback.
 *
 * `<Static>` prints each committed entry once and never redraws or removes it,
 * so the history belongs to the terminal: the wheel scrolls it, Shift+PageUp
 * scrolls it, and a multiplexer keeps its own buffer of it. None of that has to
 * be reimplemented here.
 *
 * This replaces a bounded window that redrew a fixed-height region on every
 * frame. Because Ink repaints in place, that layout overwrote the terminal's
 * scrollback whether or not anyone was looking at it — an earlier answer was
 * genuinely gone from view — and reading one back required the app's private
 * PageUp window, which the arrow keys were overloaded to drive and which could
 * only be left with more PageUp.
 *
 * The reason `<Static>` was originally rejected belongs on the record:
 * `/clear` cannot un-print. It does not have to. A cleared conversation starts
 * a new block and the old one stays where the user scrolled to, which is what
 * every terminal chat client does and the only behaviour consistent with "the
 * terminal owns my history".
 *
 * `<Static>` requires append-only input, and `entries` is exactly that: every
 * reducer in `conversation.ts` returns a new array with one more element and
 * never mutates an entry in place. `/clear` shrinks it to empty, which is also
 * fine — `<Static>` re-reads the length each render and prints only what
 * arrives afterwards.
 */
/**
 * The opening card.
 *
 * It is the first thing in the transcript rather than part of the frame, so it
 * scrolls away with everything else once the conversation starts instead of
 * spending five rows of every screen forever. While the transcript is still
 * empty it is also drawn in the live region, because a `<Static>` item cannot
 * update and this card's activity row is meant to move.
 */
export function Banner({
  title,
  version,
  model,
  endpoint,
  directory,
  activity,
  hint,
  columns = 80,
}: {
  title: string;
  version: string;
  model: string;
  endpoint: string;
  directory: string;
  activity: string;
  hint?: string;
  columns?: number;
}) {
  const width = Math.min(Math.max(CARD_MIN, columns - 2), 92);
  const lines = bannerLines({ title, version, model, endpoint, directory, activity, ...(hint ? { hint } : {}), width });
  const tone = (t: BannerTone): string | undefined =>
    t === "title" ? color.accent : t === "label" ? color.muted : t === "dim" ? color.dim : color.text;
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // eslint-disable-next-line react/no-array-index-key -- the card is positional and fixed
        <Text key={index} wrap="truncate-end">
          {line.map((cell, cellIndex) => (
            // eslint-disable-next-line react/no-array-index-key -- the card is a fixed set of positional segments per line
            <Text key={cellIndex} color={tone(cell.tone)}>
              {cell.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

export function Transcript({
  entries,
  columns = 80,
  banner,
}: {
  entries: Entry[];
  columns?: number;
  /** Drawn as the first thing in the scrollback, ahead of every entry. */
  banner?: ReactNode;
}) {
  // The banner is item zero rather than an entry of its own kind so that
  // nothing downstream — the reducer, the tests, `/clear` — has to know the
  // card exists. It is an element, not data, so it cannot be mistaken for
  // something the model said.
  const items: (Entry | ReactNode)[] = banner ? [banner, ...entries] : entries;
  return (
    <Static items={items}>
      {/* The second argument is the item's absolute position, and `<Static>`
          prints each item exactly once, so it is a stable key for the batch
          being committed. */}
      {(item, index) =>
        index === 0 && banner === item ? (
          // Keyed like every other child, and for the same reason. The
          // banner is an element the caller built, so it cannot carry its own
          // key, and `<Static>` maps a list — React warns on every commit
          // that it is given a child without one, which prints over the frame
          // the user is reading and buries any warning that matters.
          <Fragment key={index}>{item}</Fragment>
        ) : (
          <EntryView key={index} entry={item as Entry} columns={columns} />
        )
      }
    </Static>
  );
}

/** Terminal size, kept current across resizes. */
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));

  useEffect(() => {
    const stream = stdout;
    if (!stream) return;
    const sync = () => {
      setSize((previous) => {
        const next = { columns: stream.columns ?? previous.columns, rows: stream.rows ?? previous.rows };
        return next.columns === previous.columns && next.rows === previous.rows ? previous : next;
      });
    };
    stream.on("resize", sync);
    return () => {
      stream.off("resize", sync);
    };
  }, [stdout]);

  return size;
}

/** Shared frame for the interactive prompts, so they line up with the transcript. */
export function Panel({ title, tone, children }: { title: string; tone?: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={tone ?? color.muted} bold>
        {title}
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  );
}
