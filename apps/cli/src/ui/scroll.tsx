import { Text } from "ink";
import type { ReactNode } from "react";
import type { Entry, Live } from "../conversation.js";
import { HELP_TEXT } from "../slash.js";
import { color, SPINNER_FRAMES, toolGlyph } from "../theme.js";
import { toolLabel } from "../tools.js";
import { parseDiffBlock } from "../diff.js";
import { bannerLines, flattenText, reasonText, toolDetail, toolRowFailed, type BannerCell } from "./parts.js";

/**
 * The transcript as *rows*, not as Ink layout, so it can be scrolled.
 *
 * Stock Ink lays the live frame out relative to the cursor and there is no way
 * to pin one child to the bottom of the screen or to scroll another — it has no
 * absolute positioning and no scroll region. Rather than keep working around
 * that, the transcript is flattened here into one element per terminal row and
 * the App windows the slice it wants. That is the whole mechanism behind
 * "composer stays put, wheel scrolls the transcript".
 *
 * Every entry's rows match `EntryView` line for line; this is the same content
 * rendered a row at a time so a row count is knowable without a terminal.
 */

/** A blank spacer row — the vertical rhythm `EntryView` gets from `marginTop`. */
const blank = (): ReactNode => <Text> </Text>;

function row(children: ReactNode): ReactNode {
  return <Text wrap="truncate-end">{children}</Text>;
}

/** One pipe of a plain colored line; an empty line still costs a row. */
function plain(text: string, tone?: string, dim?: boolean): ReactNode {
  return (
    <Text color={tone} dimColor={dim} wrap="truncate-end">
      {text || " "}
    </Text>
  );
}

/**
 * The commands panel, pre-laid-out to fit `columns` and returned as rows.
 *
 * Rendered to strings rather than as a bordered Box because the box's borders
 * have to occupy rows this module can count — a scroll window over nested Boxes
 * cannot know how tall the resulting box is.
 */
function helpRows(columns: number): ReactNode[] {
  const width = Math.max(40, Math.min(columns - 2, 92));
  const inner = width - 4;
  const rows = HELP_TEXT.map(([command, description]) => {
    const [name, alias] = command.split(/\s{2,}/);
    return { name: name ?? command, alias: alias ?? "", description };
  });
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const aliasW = Math.max(...rows.map((r) => r.alias.length));
  const line = (content: string): string => `│ ${content.padEnd(inner)} │`;
  const edge = (l: string, r: string): string => `${l}${"─".repeat(width - 2)}${r}`;
  const out: ReactNode[] = [plain(edge("╭", "╮"), color.dim)];
  out.push(plain(line("commands"), color.muted));
  out.push(plain(line(""), color.dim));
  for (const r of rows) {
    const content = `${r.name.padEnd(nameW + 2)}${r.alias.padEnd(aliasW + 2)}${r.description}`;
    out.push(plain(line(content.slice(0, inner))));
  }
  out.push(plain(line(""), color.dim));
  out.push(plain(line("esc cancels a running turn · Ctrl+D quits"), color.dim));
  out.push(plain(edge("╰", "╯"), color.dim));
  return out;
}

/** Flatten one committed entry into the terminal rows it occupies. */
const BANNER_TONE = (t: BannerCell["tone"]): string | undefined =>
  t === "title" ? color.accent : t === "label" ? color.muted : t === "dim" ? color.dim : color.text;

/** The opening card, flattened into the rows it occupies so it scrolls away. */
export function bannerRows(opts: Parameters<typeof bannerLines>[0]): ReactNode[] {
  return bannerLines(opts).map((line, lineIndex) => (
    // eslint-disable-next-line react/no-array-index-key -- the card is positional and fixed
    <Text key={lineIndex} wrap="truncate-end">
      {line.map((cell, cellIndex) => (
        // eslint-disable-next-line react/no-array-index-key -- fixed set of positional segments per line
        <Text key={cellIndex} color={BANNER_TONE(cell.tone)}>
          {cell.text}
        </Text>
      ))}
    </Text>
  ));
}

export function entryRows(entry: Entry, columns: number): ReactNode[] {
  switch (entry.kind) {
    case "user":
      return [
        blank(),
        row(
          <>
            <Text color={color.accent} bold>
              ❯{" "}
            </Text>
            <Text color={color.text} wrap="truncate-end">
              {entry.text}
            </Text>
          </>,
        ),
      ];

    case "assistant": {
      const lines = flattenText(entry.text, columns);
      const out: ReactNode[] = [blank(), ...lines.map((l) => plain(l))];
      if (entry.partial) out.push(plain("… response ended before completion", color.warning));
      return out;
    }

    case "reasoning": {
      const { title, body } = reasonText(entry.text);
      const out: ReactNode[] = [blank(), plain(`∴ Thinking${title ? ` · ${title}` : ""}`, color.dim)];
      if (body) {
        const w = Math.max(4, columns - 2);
        out.push(...flattenText(body, w).map((l) => plain(`  ${l}`, color.muted, true)));
      }
      return out;
    }

    case "plan":
      return [blank(), plain(entry.title, color.info), ...flattenText(entry.plan, columns).map((l) => plain(l, color.muted))];

    case "tool": {
      const failed = toolRowFailed(entry);
      const tone = failed ? color.error : color.success;
      const header = row(
        <>
          <Text color={tone}>{toolGlyph[failed ? "error" : "ok"]} </Text>
          <Text color={color.text} bold>
            {toolLabel(entry.name)}
          </Text>
          {entry.target ? <Text color={color.dim}> {entry.target}</Text> : null}
        </>,
      );
      const out: ReactNode[] = [blank(), header];
      if (entry.name === "edit" && !failed) {
        const diff = parseDiffBlock(entry.output);
        if (diff.length > 0) {
          for (const d of diff) {
            const sign = d.kind === "add" ? "+ " : d.kind === "remove" ? "- " : "  ";
            const t = d.kind === "add" ? color.success : d.kind === "remove" ? color.error : color.dim;
            out.push(plain(`  ${sign}${d.text.replace(/\t/g, "    ")}`, t));
          }
        }
        return out;
      }
      const detail = toolDetail(failed ? "error" : "ok", entry.output);
      if (detail) {
        out.push(plain("  ⎿", color.dim));
        const w = Math.max(4, columns - 2);
        out.push(...flattenText(detail, w).map((l) => plain(`  ${l}`, color.dim, true)));
      }
      return out;
    }

    case "notice": {
      const tone = entry.tone === "error" ? color.error : entry.tone === "warn" ? color.warning : color.info;
      const label = entry.tone === "error" ? "error" : entry.tone === "warn" ? "warning" : "·";
      // Errors wrap (their tail is the advice); the rest truncate to one row.
      const body =
        entry.tone === "error" ? flattenText(entry.text, columns) : [entry.text];
      return [blank(), ...body.map((l) => row(<><Text color={tone}>{label}</Text><Text color={color.muted}> {l}</Text></>))];
    }

    case "help":
      return [blank(), ...helpRows(columns)];

    default:
      return [];
  }
}

/** Flatten the in-flight region (spinner, reasoning, streamed text) into rows. */
export function liveRows(live: Live, frame: number, elapsed: number, columns: number, budget: number, waitingOnUser = false): ReactNode[] {
  const busy = Boolean(live.text || live.reasoning || live.tool || live.status || live.retrying);
  if (!busy) return [];
  const spinner = waitingOnUser ? "⏸" : SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const out: ReactNode[] = [blank()];
  if (live.retrying) out.push(plain(`${spinner} retrying after an interrupted attempt (${elapsed}s)`, color.warning));
  else if (live.tool) {
    out.push(
      row(
        <>
          <Text color={color.accent}>{spinner} </Text>
          <Text color={color.muted}>
            {live.tool.name}
            {live.tool.target ? ` ${live.tool.target}` : ""}
          </Text>
        </>,
      ),
    );
  } else if (live.status) {
    out.push(row(<><Text color={color.accent}>{spinner} </Text><Text color={color.muted}>{live.status}</Text></>));
  }
  if (live.reasoning.trim()) {
    out.push(plain("∴ Thinking", color.dim));
    out.push(...flattenText(live.reasoning.trimEnd(), columns - 2).slice(-budget).map((l) => plain(`  ${l}`, color.muted, true)));
  }
  if (live.text) {
    out.push(...flattenText(live.text, columns).slice(-budget).map((l) => plain(l)));
  }
  return out;
}

/**
 * The slice of rows a scroll window shows.
 *
 * `offsetFromBottom` is 0 when pinned to the bottom (following new output) and
 * positive when the user has scrolled up. Returns the rows to render; the caller
 * gives the window a fixed height, so the composer below it never moves.
 */
export function windowRows(all: ReactNode[], height: number, offsetFromBottom: number): ReactNode[] {
  if (height <= 0) return [];
  const maxOffset = Math.max(0, all.length - height);
  const offset = Math.min(Math.max(0, offsetFromBottom), maxOffset);
  const start = Math.max(0, all.length - height - offset);
  return all.slice(start, start + height);
}
