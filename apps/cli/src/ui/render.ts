import chalk from "chalk";
import type { Entry } from "../conversation.js";
import { color } from "../theme.js";
import { parseDiffBlock } from "../diff.js";
import { formatTokens } from "../usage.js";
import { flattenText, proseWidth, toolRowFailed, wrapText } from "./parts.js";
import { renderMarkdown } from "./markdown.js";

/** A clear, human name for a tool — "Bash", not the cryptic "$". */
function toolDisplayName(name: string): string {
  switch (name) {
    case "shell":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "glob":
      return "Glob";
    case "rg":
      return "Rg";
    default:
      return name;
  }
}

/**
 * A tool's output as a few dimmed lines under its header: line structure kept,
 * a leading "path (N lines):" label dropped, and long output cut to a count so a
 * hundred-line result never floods the transcript.
 */
function toolOutputLines(status: "ok" | "error", output: string, cols: number): string[] {
  const text = output.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "").replace(/\r/g, "").trim();
  if (!text) return [];
  const width = Math.max(20, cols - 4);
  const raw = text.split("\n").filter((l, i) => !(i === 0 && /^\S.*\(\d+ .*\):$/.test(l.trim())));
  const lines = raw.flatMap((l) => flattenText(l, width));
  const max = status === "error" ? 8 : 6;
  if (lines.length <= max) return lines;
  const rest = lines.length - max;
  return [...lines.slice(0, max), `… ${rest} more line${rest === 1 ? "" : "s"}`];
}

/**
 * Our own renderer: the transcript and chrome as strings.
 *
 * Ink rendered these as React nodes and laid them out with Yoga; we render them
 * to coloured strings and place them at rows we choose (see term.ts). One styled
 * run of text; `visibleWidth` is the width without escapes, which is what
 * padding and truncation are measured against — the arithmetic that is silent
 * when it is wrong, kept in one place.
 */
export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean; bg?: string };

export function segWidth(segs: Seg[]): number {
  return segs.reduce((n, s) => n + s.text.length, 0);
}

/** Colourise a run of segments into an ANSI string. */
export function paint(segs: Seg[]): string {
  return segs
    .map((s) => {
      let fn = s.color ? chalk.hex(s.color) : chalk;
      if (s.bg) fn = fn.bgHex(s.bg);
      if (s.dim) fn = fn.dim;
      if (s.bold) fn = fn.bold;
      return fn(s.text);
    })
    .join("");
}

/** Truncate or pad a set of segments to exactly `width` visible columns. */
export function fitWidth(segs: Seg[], width: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    if (used >= width) break;
    if (used + s.text.length <= width) {
      out.push(s);
      used += s.text.length;
    } else {
      out.push({ ...s, text: s.text.slice(0, width - used) });
      used = width;
    }
  }
  if (used < width) out.push({ text: " ".repeat(width - used), dim: true });
  return out;
}

/**
 * Give the columns in [from, to] a background, splitting segments as needed.
 *
 * The row is already padded to exactly its width by `fitWidth`, so a segment's
 * offset is a running sum of the text before it and no screen buffer is
 * needed. Segments are split rather than replaced so the text keeps the colour
 * it had — the highlight is a background, exactly like native terminal
 * selection, which is why syntax-highlighted code does not fragment into a
 * stripe per colour.
 */
export function highlight(segs: Seg[], from: number, to: number, bg: string): Seg[] {
  const out: Seg[] = [];
  let col = 0;
  for (const s of segs) {
    const start = col;
    const end = col + s.text.length - 1;
    col += s.text.length;
    if (end < from || start > to) {
      out.push(s);
      continue;
    }
    const lo = Math.max(from, start) - start;
    const hi = Math.min(to, end) - start;
    if (lo > 0) out.push({ ...s, text: s.text.slice(0, lo) });
    out.push({ ...s, text: s.text.slice(lo, hi + 1), bg });
    if (hi + 1 < s.text.length) out.push({ ...s, text: s.text.slice(hi + 1) });
  }
  return out;
}

const plain = (text: string, tone?: string, dim?: boolean): Seg[] => [{ text, ...(tone ? { color: tone } : {}), ...(dim ? { dim: true } : {}) }];
const blank = (): Seg[] => [{ text: " " }];

/**
 * Format elapsed seconds for a reasoning timer: truncate, never round.
 * Under a minute shows `12.2s` (0.1 s accuracy), under an hour `1m 12s`,
 * anything above `2h 13m`. Never days or weeks.
 */
export function formatTimer(seconds: number): string {
  const total = Math.max(0, seconds);
  if (total < 60) return `${(Math.floor(total * 10) / 10).toFixed(1)}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * One frame of the ChatGPT-style shimmer: a soft Gaussian highlight moving
 * across `text`, ported from `d:/chatgpt/main.py`. Each character gets its own
 * 24-bit colour between the base grey and the peak white based on its distance
 * from the moving highlight centre, so the whole word reads as steadily lit
 * with a single soft band sweeping across it.
 */
export function shimmerSegs(text: string, frame: number, speed = 1.2, msPerFrame = 150): Seg[] {
  // Phase is real elapsed time (frames x the ticker's actual period), not an
  // assumed 60 fps, so `speed` stays a sweeps/second value at any ticker rate.
  const phase = (((frame * msPerFrame) / 1000) * speed) % 1.0;
  const center = -0.50 + phase * 2.0;
  const width = 0.18;
  const base = [145, 148, 155];
  const peak = [238, 240, 244];
  const length = text.length;
  return [...text].map((ch, index) => {
    const position = (index + 0.5) / length;
    const distance = (position - center) / width;
    const strength = Math.exp(-0.5 * distance * distance);
    const rgb = base.map((b, i) => Math.round(b + (peak[i] - b) * strength));
    const hex = rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
    return { text: ch, color: `#${hex}` };
  });
}

/**
 * Wrap content rows in a rounded rectangle, `cols` wide, with an optional title
 * set into the top border. Every content row is padded to the inner width, so
 * the right border always lines up. `border` colours the frame; `bg` fills the
 * content rows.
 */
export function box(rows: Seg[][], cols: number, opts: { border?: string; bg?: string; title?: string } = {}): Seg[][] {
  const inner = Math.max(4, cols - 2);
  const b = (s: string): Seg => ({ text: s, color: opts.border });
  const fill = (content: Seg[]): Seg[] => [
    b("│"),
    ...(opts.bg ? content.map((s) => ({ ...s, bg: opts.bg })) : content),
    b("│"),
  ];
  const topTitle = opts.title ? `─ ${opts.title} ` : "";
  const topDashes = Math.max(0, inner - topTitle.length);
  return [
    [b(`╭${topTitle}${"─".repeat(topDashes)}╮`)],
    ...rows.map((r) => fill(fitWidth(r, inner))),
    [b(`╰${"─".repeat(inner)}╯`)],
  ];
}

/**
 * A menu as a bordered panel, inset from the frame's walls and centred — the
 * modal look the provider and manage screens use, as opposed to the flat
 * picker lists. `title` is set into the top border.
 */
/**
 * Place a canonical menu box (the output of `menuRows` and its adapters)
 * in the middle of the frame, inset from the walls — the modal look the
 * provider and manage screens use. The box keeps its own titled border;
 * `panel` only positions it.
 */
export function panel(rows: Seg[][], innerW: number, width?: number, hitMapIn?: number[], hitMapOut?: number[]): Seg[][] {
  const boxW = Math.max(24, Math.min(width ?? MENU_WIDTH, innerW - 4));
  const inset = Math.max(0, Math.floor((innerW - boxW) / 2));
  const out = rows.map((r) => fitWidth([{ text: " ".repeat(inset), dim: true }, ...r], innerW));
  if (hitMapIn && hitMapOut) {
    hitMapOut.length = 0;
    hitMapOut.push(...hitMapIn);
  }
  return out;
}

/* ---- the canonical menu ----
 *
 * Every menu in the app — slash commands, providers, manage, models, thinking
 * effort, usage, the add-provider flow, help — is drawn by `menuRows`, one
 * shared shape: a single rounded rectangle whose first row is the search bar.
 * The search bar is a fixed `⌕  search` label, a `│` unicode divider, then
 * the live input area; the label and icon never move, only the input area
 * changes as the user types. A horizontal divider runs under the search bar
 * and every item below is separated from the next by a horizontal divider —
 * an item is a row of its own, nothing else. `MENU_WIDTH` keeps every menu
 * the same width; callers clamp it to the terminal. The per-menu builders
 * below are thin adapters that map their data onto this one shape.
 */

export const MENU_WIDTH = 60;

/** The column of the search bar's input area (box border + the 12-char
 *  `⌕  search │ ` prefix), for positioning a caret on that row. */
export const SEARCH_INPUT_COL = 13;

export type MenuSubRow = {
  label: string;
  detail?: string;
  /** This sub-row carries the cursor (an expanded action, etc.). */
  active?: boolean;
};

export type MenuEntry = {
  /** A 2-column marker: `● `, `✓ `, `+ `, `  `. */
  marker?: string;
  markerTone?: string;
  /** Primary text; the focused row draws it red and bold on the filled bg. */
  label?: string;
  /** Muted right-hand text. */
  detail?: string;
  /** A full-width plain row (hints, prose) instead of the label/detail split. */
  line?: string;
  lineTone?: string;
  /** Indented rows drawn under this item, each with its own divider. */
  subRows?: MenuSubRow[];
  /** The cursor can never land on this row. */
  selectable?: boolean;
};

/** The canonical search-bar row: fixed `⌕  search` label, `│` divider, input. */
function menuSearchRow(query: string, live: boolean, info: boolean): Seg[] {
  const out: Seg[] = [
    { text: "⌕  ", color: color.dim },
    { text: "search", color: color.dim },
    { text: " ", color: color.dim },
    { text: "│", color: color.border },
    { text: " ", color: color.dim },
  ];
  if (query) out.push({ text: query, color: info ? color.muted : color.text, bold: !info });
  else if (live) out.push({ text: "▏", color: color.accent });
  return out;
}

export function menuRows(o: {
  title: string;
  /** Text in the input area; empty + `live` shows the block caret. */
  query?: string;
  /** The input area is being typed into. */
  live?: boolean;
  /** The input text is shown for information (muted), not as a typed search. */
  info?: boolean;
  items: MenuEntry[];
  /** Index into `items` that carries the cursor; omitted → none. */
  cursor?: number;
  /** Window the items to this total height (borders and dividers included). */
  height?: number;
  /** Box width; the default keeps every menu the same width. */
  width?: number;
  emptyText?: string;
  /** Optional out-array filled with a per-row item index (-1 = not an item). */
  hitMapOut?: number[];
}): Seg[][] {
  const width = Math.max(24, o.width ?? MENU_WIDTH);
  const innerW = width - 2;
  const query = o.query ?? "";
  const divider: Seg[] = [{ text: "─".repeat(innerW), color: color.border }];
  const rows: Seg[][] = [menuSearchRow(query, o.live ?? false, o.info ?? false), divider];
  const hitMapInner: number[] = [-1, -1];

  // Column layout: a fixed 2-column marker, an aligned label column, and the
  // muted detail — the label is what gets truncated, never the layout.
  const labeled = o.items.filter((i) => i.label !== undefined);
  const nameW = labeled.length > 0 ? Math.min(26, Math.max(4, ...labeled.map((i) => i.label!.length))) : 4;
  const gapW = 2;
  const labelW = Math.max(0, innerW - 2 - nameW - gapW);
  const cut = (s: string, w: number): string => (w <= 0 ? "" : s.length > w ? `${s.slice(0, w - 1)}…` : s);
  const entryRow = (i: number, focused: boolean): Seg[] => {
    const e = o.items[i]!;
    if (e.line !== undefined) {
      const out: Seg[] = [{ text: e.line, color: e.lineTone, bg: focused ? color.surface : undefined }];
      if (e.line.length < innerW) out.push({ text: " ".repeat(innerW - e.line.length), bg: focused ? color.surface : undefined, dim: true });
      return out;
    }
    const bg = focused ? color.surface : undefined;
    const label = cut(e.label ?? "", nameW);
    const out: Seg[] = [
      { text: (e.marker ?? "  ").slice(0, 2).padEnd(2), color: e.markerTone, bg },
      { text: label, color: focused ? "#ff5555" : color.text, bold: focused, bg },
      { text: " ".repeat(nameW - label.length + gapW), bg },
    ];
    if (e.detail !== undefined && labelW > 0) out.push({ text: cut(e.detail, labelW), color: color.muted, bg });
    return out;
  };
  const subRow = (sr: MenuSubRow): Seg[] => {
    const bg = sr.active ? color.surface : undefined;
    const detail = sr.detail !== undefined ? `  ${cut(sr.detail, Math.max(0, innerW - 4 - sr.label.length - 2))}` : "";
    return [
      { text: "    ", bg },
      { text: sr.label, color: sr.active ? "#ff5555" : color.muted, bold: sr.active, bg },
      ...(detail ? [{ text: detail, color: color.text, bg } as Seg] : []),
    ];
  };

  // Windowing: a content row is an item (plus its sub-rows) or a marker, and a
  // divider follows every row — so C content rows cost `3 + 2*C` box rows, and
  // B content rows fit in `o.height`.
  let start = 0;
  let end = o.items.length;
  if (o.height !== undefined && o.items.length > 0) {
    const n = o.items.length;
    const units = o.items.map((i) => 1 + (i.subRows?.length ?? 0));
    const totalUnits = units.reduce((a, b) => a + b, 0);
    const B = Math.max(1, Math.floor((o.height - 3) / 2));
    if (totalUnits > B) {
      const walk = (s: number): number => {
        let e = s;
        while (e < n) {
          const shown = units.slice(s, e + 1).reduce((a, b) => a + b, 0);
          const c = shown + (s > 0 ? 1 : 0) + (e + 1 < n ? 1 : 0); // items, sub-rows, markers
          if (c > B) break;
          e += 1;
        }
        // Never window to zero items: force the first row in rather than an empty box.
        return e === s ? Math.min(n, s + 1) : e;
      };
      start = o.cursor !== undefined ? Math.max(0, Math.min(o.cursor - Math.floor(B / 2), n - 1)) : 0;
      end = walk(start);
      // The cursor's item must be in the window; a heavy block before it can
      // push it out, so re-anchor the window at the cursor when that happens.
      if (o.cursor !== undefined && o.cursor >= end && o.cursor < n) {
        start = o.cursor;
        end = walk(start);
      }
    }
  }
  const above = start;
  const below = o.items.length - end;

  const body: Seg[][] = [];
  const push = (r: Seg[], itemIndex = -1): void => {
    if (body.length > 0) { body.push(divider); hitMapInner.push(-1); }
    body.push(r);
    hitMapInner.push(itemIndex);
  };
  if (above > 0) push(plain(`  ↑ ${above} above`, color.dim));
  for (let i = start; i < end; i += 1) {
    const e = o.items[i]!;
    push(entryRow(i, o.cursor === i && e.selectable !== false), e.selectable === false ? -1 : i);
    // Sub-rows are a divider-free block that belongs to the item, not the
    // list — they ride under it without earning their own dividers.
    (e.subRows ?? []).forEach((sr, j) => {
      body.push(subRow(sr));
      hitMapInner.push(e.selectable === false ? -1 : 100000 + i * 10 + j);
    });
  }
  if (below > 0) push(plain(`  ↓ ${below} more`, color.dim));
  if (start === end) push(plain(`  ${o.emptyText ?? "no matches"}`, color.dim));
  rows.push(...body);
  // Every menu with a height budget fills it: pad the frame with blank rows so
  // filtering rewrites rows inside a static box instead of resizing it — the
  // search bar and the frame's edges never move while typing.
  if (o.height !== undefined) {
    const target = Math.max(0, o.height - 2);
    while (rows.length < target) { rows.push([{ text: " ".repeat(innerW), dim: true }]); hitMapInner.push(-1); }
  }
  if (o.hitMapOut) {
    o.hitMapOut.length = 0;
    o.hitMapOut.push(-1, ...hitMapInner, -1);
  }
  return box(rows, width, { border: color.border, title: o.title });
}




/**
 * The provider list, as the canonical menu: one rounded rectangle with the
 * search bar on top, each provider a single row (status dot, name, muted
 * label), the expanded actions as sub-rows, then the add entry — a
 * horizontal divider between every row.
 */
export function providerPanelRows(
  providers: { name: string; label: string; active: boolean }[],
  cursor: number,
  query: string,
  width?: number,
  expandedIndex?: number | null,
  actionCursor?: number,
  height?: number,
  hitMapOut?: number[],
): Seg[][] {
  const items: MenuEntry[] = providers.map((p, i) => ({
    marker: p.active ? "● " : "  ",
    markerTone: p.active ? color.success : undefined,
    label: p.name,
    detail: p.label,
    subRows:
      expandedIndex === i
        ? [
            { label: "Use provider", active: (actionCursor ?? 0) === 0 },
            { label: "Edit provider", active: (actionCursor ?? 0) === 1 },
          ]
        : undefined,
  }));
  items.push({ marker: "+ ", markerTone: color.accent, label: "Add provider" });
  return menuRows({
    title: "Providers",
    query,
    live: true,
    items,
    cursor,
    width,
    height,
    emptyText: "no providers yet",
    hitMapOut,
  });
}

/** The manage screen for one provider: its details as sub-rows, then actions. */
export function managePanelRows(
  provider: { name: string; label: string; model: string; endpoint: string; auth: string },
  cursor: number,
  width?: number,
  height?: number,
  hitMapOut?: number[],
): Seg[][] {
  const actions = ["Change model", "Edit provider", "Test connection", "Remove provider"];
  const items: MenuEntry[] = [
    {
      label: provider.name,
      detail: provider.label,
      selectable: false,
      subRows: [
        { label: "Model", detail: provider.model || "(none)" },
        { label: "Endpoint", detail: provider.endpoint },
        { label: "Authentication", detail: provider.auth },
      ],
    },
    ...actions.map((label, i) => ({
      marker: i === cursor ? "● " : "○ ",
      markerTone: i === cursor ? color.accent : color.dim,
      label,
    })),
  ];
  return menuRows({
    title: "Manage provider",
    query: provider.name,
    info: true,
    items,
    cursor: cursor + 1, // the cursor walks the four actions, not the details block
    width: width ?? MENU_WIDTH,
    height,
    hitMapOut,
  });
}
/** One committed transcript entry, as rows of segments (each row ≤ `cols`). */
export function entryLines(entry: Entry, cols: number, expandReasoning = false, tight = false): Seg[][] {
  switch (entry.kind) {
    case "user": {
      // The user's own message: wrapped to width and boxed like an answer,
      // but with the crimson accent border and a grey fill so it reads as
      // the user's side of the conversation.
      const wrapped = wrapText(entry.text, cols - 4).split("\n").map((l) => plain(l, color.text));
      return [blank(), ...box(wrapped, cols, { border: color.accent, bg: color.selectionBg })];
    }

    case "assistant": {
      const rows = renderMarkdown(entry.text, cols - 4);
      if (entry.partial) rows.push(plain("… response ended before completion", color.warning));
      const boxed = box(rows, cols, { border: color.dim });
      return tight ? boxed : [blank(), ...boxed];
    }

    case "reasoning": {
      // Committed reasoning: collapsed it is one sentence — "thought for 12.2s"
      // — inside the same rounded rectangle the composer uses. Expanded it is
      // the full chain, rendered as any other long text with no truncation,
      // even if it runs past the bottom of the screen.
      const rows: Seg[][] = expandReasoning
        ? flattenText(entry.text, proseWidth(cols - 6)).map((l) => plain(l, color.muted))
        : [[
            { text: entry.durationSeconds != null ? `thought for ${formatTimer(entry.durationSeconds)}` : "thinking", color: color.muted },
          ]];
      if (rows.length === 0) rows.push(plain("…", color.muted));
      return [blank(), ...box(rows, cols, { border: color.dim })];
    }

    case "plan": {
      // The title is the plan's own heading; the body is markdown, rendered the
      // same way an answer is. The model often repeats the title as a leading
      // heading in the body — drop it, or the heading shows twice.
      const lines = entry.plan.split("\n");
      const first = lines.findIndex((l) => l.trim() !== "");
      const h = first >= 0 ? /^#{1,6}\s+(.*)$/.exec(lines[first]!.trim()) : null;
      const body = h && h![1]!.trim() === entry.title.trim() ? lines.filter((_, i) => i !== first).join("\n") : entry.plan;
      return [blank(), plain(`◆ ${entry.title}`, color.info, true), ...renderMarkdown(body, cols - 4)];
    }

    case "tool": {
      const failed = toolRowFailed(entry);
      const tone = failed ? color.error : color.success;
      const head: Seg[] = [
        { text: `${failed ? "✗" : "✓"} `, color: tone },
        { text: toolDisplayName(entry.name), color: color.text, bold: true },
        ...(entry.target ? [{ text: `  ${entry.target}`, color: color.muted } as Seg] : []),
      ];
      const rows: Seg[][] = [head];
      const outputText = entry.output.text ?? String(entry.output.data);
      if (entry.name === "edit" && !failed) {
        for (const d of parseDiffBlock(outputText)) {
          const sign = d.kind === "add" ? "+" : d.kind === "remove" ? "-" : " ";
          const t = d.kind === "add" ? color.success : d.kind === "remove" ? color.error : color.muted;
          const num = d.line !== undefined ? String(d.line).padStart(4) : "    ";
          rows.push(plain(`  ${num} ${sign} ${d.text.replace(/\t/g, "    ")}`, t));
        }
      } else {
        // Output reads as an indented block under the header, in the muted tone
        // — `dim` was nearly invisible on the filled background.
        for (const line of toolOutputLines(failed ? "error" : "ok", outputText, cols - 6)) rows.push(plain(`  ${line}`, color.muted));
      }
      // A grey, highlighted rounded rectangle — the tool call reads as its own
      // block rather than more transcript chatter.
      return [blank(), ...box(rows, cols, { border: color.muted, bg: color.surface })];
    }

    default:
      return [];
  }
}

/**
 * One slot each, held by the caller (the App owns one): the two content
 * boxes of the live region — the streamed answer and the expanded reasoning
 * chain — are pure functions of (text, cols) and of nothing else. The
 * animation state (`frame`, `elapsed`, spinner, shimmer) must not make them
 * re-layout: at a 16 ms tick on a long answer that is the whole cost of the
 * frame, so a warm frame hits in O(1) and only a new token or a resize
 * recomputes. The rows are shared with the cache on purpose — nothing
 * downstream mutates a row, and the committed `entryRowList` already works
 * the same way through its memo.
 */
export type LiveLayoutCache = {
  answer: { text: string; cols: number; rows: Seg[][] } | null;
  reasoning: { text: string; cols: number; rows: Seg[][] } | null;
};

export function newLiveLayoutCache(): LiveLayoutCache {
  return { answer: null, reasoning: null };
}

/** The in-flight region (spinner, reasoning, streamed text) as rows of segments. */
export function liveLines(live: { text: string; reasoning: string; status?: string; tool?: { name: string; target: string }; retrying?: { attempt: number }; readingToolOutput?: boolean }, frame: number, elapsed: number, cols: number, budget: number, waitingOnUser = false, expandReasoning = true, reasoningStartedAt: number | null = null, // eslint-disable-next-line @typescript-eslint/no-explicit-any
msPerFrame = 150, layoutCache: LiveLayoutCache | undefined = undefined, ...rest: any[]): Seg[][] {
  void budget;
  const busy = Boolean(live.text || live.reasoning || live.tool || live.status || live.retrying);
  let showThinking = false;
  let turnStartedAt: number | null = null;
  for (const arg of rest) {
    if (typeof arg === "boolean") {
      if (arg) showThinking = true;
    } else if (typeof arg === "number") {
      if (arg >= 1_000_000_000_000) {
        turnStartedAt = arg;
        if (Date.now() - arg >= 200) showThinking = true;
      } else if (arg >= 200) {
        showThinking = true;
      }
    } else if (arg && typeof arg === "object") {
      if (typeof arg.show === "boolean" && arg.show) showThinking = true;
      if (typeof arg.startedAt === "number") {
        turnStartedAt = arg.startedAt;
        const now = typeof arg.now === "number" ? arg.now : Date.now();
        if (now - arg.startedAt >= 200) showThinking = true;
      }
      if (typeof arg.elapsedMs === "number" && arg.elapsedMs >= 200) showThinking = true;
      if (typeof arg.turnStartedAt === "number") {
        turnStartedAt = arg.turnStartedAt;
        const now = typeof arg.now === "number" ? arg.now : Date.now();
        if (now - arg.turnStartedAt >= 200) showThinking = true;
      }
    }
  }
  if (!busy && !showThinking) return [];
  const spin = waitingOnUser ? "⏸" : "◐◓◑◒"[frame % 4];
  const out: Seg[][] = [];
  if (live.retrying) { out.push(blank()); out.push([{ text: `${spin} `, color: color.warning }, { text: `retrying after an interrupted attempt (${elapsed}s)`, color: color.warning }]); }
  else if (live.tool) { out.push(blank()); out.push([{ text: `${spin} `, color: color.accent }, { text: `${toolDisplayName(live.tool.name)}${live.tool.target ? `  ${live.tool.target}` : ""}`, color: color.muted }]); }
  else if (live.status) { out.push(blank()); out.push([{ text: `${spin} `, color: color.accent }, { text: live.status, color: color.muted }]); }
  if (live.reasoning.trim()) {
    // The current reasoning block: collapsed it is a one-row rounded rectangle
    // identical in height to the composer, with a shimmer on the left and a
    // running timer on the right. Expanded it is the full chain, rendered as
    // any other long text with no truncation — it never yields to the row
    // budget, even if it runs past the bottom of the screen.
    if (expandReasoning) {
      const hit = layoutCache?.reasoning && layoutCache.reasoning.text === live.reasoning && layoutCache.reasoning.cols === cols ? layoutCache.reasoning.rows : null;
      const reasoningLines = flattenText(live.reasoning.trimEnd(), proseWidth(cols - 6)).map((l) => plain(l, color.muted));
      if (reasoningLines.length === 0) {
        // nothing to draw; leave the cache untouched and fall through to the
        // answer path instead of aborting the whole live region.
      } else {
        const boxed = hit ?? box(reasoningLines, cols, { border: color.dim });
        if (layoutCache && !hit) layoutCache.reasoning = { text: live.reasoning, cols, rows: boxed };
        out.push(blank());
        out.push(...boxed);
      }
    } else {
      const elapsedSec = reasoningStartedAt != null ? Math.max(0, Date.now() - reasoningStartedAt) / 1000 : 0;
      const timer = formatTimer(elapsedSec);
      const inner = Math.max(4, cols - 2);
      // A gentle sweep so a long TTFT wait does not look frantic.
      const shimmer = shimmerSegs("thinking", frame, 1.2, msPerFrame);
      const shimmerW = shimmer.reduce((n, s) => n + s.text.length, 0);
      const fill = Math.max(0, inner - shimmerW - timer.length);
      const row: Seg[] = [...shimmer, { text: " ".repeat(fill) }, { text: timer, color: color.dim }];
      out.push(blank());
      out.push(...box([row], cols, { border: color.dim }));
    }
  }
  if (!live.reasoning.trim() && !live.text.trim() && showThinking) {
    const effectiveStarted = turnStartedAt ?? reasoningStartedAt;
    const elapsedSec = effectiveStarted != null ? Math.max(0, Date.now() - effectiveStarted) / 1000 : elapsed;
    const timer = formatTimer(elapsedSec);
    const inner = Math.max(4, cols - 2);
    const shimmerLabel = live.readingToolOutput ? "reading tool output" : "reading your message";
    const shimmer = shimmerSegs(shimmerLabel, frame, 1.2, msPerFrame);
    const shimmerW = shimmer.reduce((n, s) => n + s.text.length, 0);
    const fill = Math.max(0, inner - shimmerW - timer.length);
    const row: Seg[] = [...shimmer, { text: " ".repeat(fill) }, { text: timer, color: color.dim }];
    out.push(blank());
    out.push(...box([row], cols, { border: color.dim }));
  }
  // The streamed answer is boxed from the first token, identical to the
  // committed entry, so the border is there while it generates and there is no
  // snap when it lands. When it outgrows the viewport the older lines are
  // counted at the top of the box, not silently dropped.
  if (live.text.trim()) {
    const hit = layoutCache?.answer && layoutCache.answer.text === live.text && layoutCache.answer.cols === cols ? layoutCache.answer.rows : null;
    const rendered = renderMarkdown(live.text, cols - 4);
    if (rendered.length === 0) return out;
    const all = hit ?? box(rendered, cols, { border: color.dim });
    if (layoutCache && !hit) layoutCache.answer = { text: live.text, cols, rows: all };
    out.push(...all);
  }
  return out;
}

/* ---- pure helpers moved here from the old ReactNode renderer (scroll.tsx) ---- */

export type Face = "normal" | "startled" | "idle" | "confused" | "suffering" | "dead" | "happy" | "thinking";

const FACE: Record<Face, string> = {
  normal: "o_o", startled: "0_0", idle: "-_-", confused: "?_?",
  suffering: "T_T", dead: "x_x", happy: "ᵔᴥᵔ", thinking: "o_0",
};

/** The mood from the conversation's state, worst first. */
export function stateFace(input: { live: { text: string; reasoning: string }; lastEntry?: Entry; notice?: { tone: "info" | "warn" | "error" }; blocked: boolean; busy: boolean }): Face {
  const { live, lastEntry, notice, blocked, busy } = input;
  // A failure is status rather than the last thing said, so the grim face is
  // read off the composer's notice line, not off the transcript.
  if (notice?.tone === "error") return "dead";
  if (lastEntry?.kind === "tool" && lastEntry.status === "error") return "suffering";
  if (blocked) return "confused";
  if (live.reasoning.trim()) return "thinking";
  if (busy) return "normal";
  return "idle";
}

export function faceChar(face: Face): string {
  return FACE[face];
}

/** The window of rows a scrolled transcript shows; offset 0 is the bottom. */
export function windowRows<T>(all: T[], height: number, offsetFromBottom: number): T[] {
  if (height <= 0) return [];
  const maxOffset = Math.max(0, all.length - height);
  const offset = Math.min(Math.max(0, offsetFromBottom), maxOffset);
  const start = Math.max(0, all.length - height - offset);
  return all.slice(start, start + height);
}

/** Width of the content between the frame's sides (border + a space each side). */
export function frameInnerWidth(columns: number): number {
  return Math.max(8, columns - 4);
}

/** The frame's top border, with the title and version set into it. */
export function topFrameBorder(title: string, version: string, columns: number): string {
  const left = ` ${title} `;
  const right = ` v${version} `;
  const dashes = Math.max(4, columns - 2 - left.length - right.length);
  const mid = Math.max(1, dashes - 4);
  return `╭${"─".repeat(2)}${left}${"─".repeat(mid)}${right}${"─".repeat(2)}╮`;
}

/** The frame's plain bottom border. */
export function bottomFrameBorder(columns: number): string {
  return `╰${"─".repeat(Math.max(1, columns - 2))}╯`;
}

/** One content row of the frame: `│ ` + text padded/truncated + ` │`. */
export function frameLine(text: string, columns: number): string {
  const inner = frameInnerWidth(columns);
  return `│ ${text.length > inner ? text.slice(0, inner) : text.padEnd(inner)} │`;
}

/* ---- the composer and every menu, as rows of segments ---- */

/** The composer: a compact rounded box around the draft. Grows with the draft. */
export function composerRows(opts: { cols: number; draft: string; caret: number; busy: boolean; maxHeight?: number; topRight?: string; topRightColor?: string }): { rows: Seg[][]; inputRow: number; inputCol: number } {
  const width = Math.max(20, opts.cols);
  const inner = width - 2;
  const glyph = opts.busy ? "· " : "❯ ";
  // The first visual row is narrower — the glyph sits in front of it.
  const firstWidth = Math.max(8, inner - glyph.length);
  const caret = Math.max(0, Math.min(opts.caret, opts.draft.length));

  // Hard-wrap the draft into visual rows of fixed width, so a long line wraps
  // and stays fully visible instead of truncating. Fixed-width slices also mean
  // the caret's character offset maps exactly onto a row and column — no
  // dropped break-space to account for. Each row remembers where it starts.
  type Row = { text: string; start: number; first: boolean };
  const logical = opts.draft.split("\n");
  const all: Row[] = [];
  let lineStart = 0;
  for (let li = 0; li < logical.length; li += 1) {
    const line = logical[li]!;
    const lineWidth = li === 0 ? firstWidth : inner;
    const n = Math.max(1, Math.ceil(line.length / lineWidth));
    for (let wi = 0; wi < n; wi += 1) {
      all.push({ text: line.slice(wi * lineWidth, wi * lineWidth + lineWidth), start: lineStart + wi * lineWidth, first: li === 0 && wi === 0 });
    }
    lineStart += line.length + 1;
  }
  if (all.length === 0) all.push({ text: "", start: 0, first: true });

  // The caret's absolute visual row and its column within that row.
  let caretRow = all.length - 1;
  let caretCol = 0;
  for (let i = 0; i < all.length; i += 1) {
    const row = all[i]!;
    if (caret >= row.start && caret <= row.start + row.text.length) {
      caretRow = i;
      caretCol = caret - row.start;
      break;
    }
  }

  // Cap the visible height and scroll so the caret stays on screen; a prompt
  // taller than the box keeps its tail and counts what scrolled off the top.
  const maxRows = Math.max(1, (opts.maxHeight ?? 8) - 3); // borders + optional count
  let startIdx = 0;
  if (all.length > maxRows) startIdx = Math.max(0, Math.min(caretRow - maxRows + 1, all.length - maxRows));
  const visible = all.slice(startIdx, startIdx + maxRows);
  const above = startIdx;

  let topBorder: Seg[];
  if (opts.topRight) {
    // The label carries status — a notice or a hint — and status grows: an
    // error can be a whole sentence. It is clamped to the border it sits in,
    // because a label wider than the box pushes the closing corner off the
    // row and the composer stops being a box.
    const room = Math.max(1, inner - 5);
    const status = opts.topRight.length > room ? `${opts.topRight.slice(0, room - 1)}…` : opts.topRight;
    const label = ` ${status} `;
    const pos = Math.max(2, inner - label.length - 1);
    const rightPad = Math.max(0, inner - pos - label.length);
    topBorder = [
      { text: "╭", color: color.accent },
      { text: "─".repeat(pos), color: color.accent },
      { text: label, color: opts.topRightColor ?? color.accent },
      { text: "─".repeat(rightPad), color: color.accent },
      { text: "╮", color: color.accent },
    ];
  } else {
    topBorder = [{ text: `╭${"─".repeat(inner)}╮`, color: color.accent }];
  }
  const rows: Seg[][] = [topBorder];
  if (above > 0) rows.push([{ text: "│", color: color.accent }, ...plain(`↑ ${above} more line${above === 1 ? "" : "s"}`, color.dim, true), { text: "│", color: color.accent }]);
  visible.forEach((row) => {
    const content: Seg[] = [];
    if (row.first) content.push({ text: glyph, color: opts.busy ? color.dim : color.accent, bold: true });
    // No block caret: the draft renders as plain text, no reverse-filled cell.
    content.push({ text: row.text, color: color.text, bg: color.selectionBg });
    rows.push([{ text: "│", color: color.accent }, ...fitWidth(content, inner), { text: "│", color: color.accent }]);
  });
  rows.push(plain(`╰${"─".repeat(inner)}╯`, color.accent));

  // inputRow is the caret's row within `rows` (rows[0] is the top border);
  // inputCol is the composer-box column just after its character.
  const inputRow = 1 + (above > 0 ? 1 : 0) + (caretRow - startIdx);
  const prefix = all[caretRow]!.first ? glyph.length : 0;
  return { rows, inputRow, inputCol: 2 + prefix + caretCol };
}

export interface PickerItem {
  label: string;
  detail?: string;
  /** A filled bullet (●) rather than an open one (○). */
  selected?: boolean;
}

/**
 * The one selectable list every menu uses, so they all look and behave the
 * same: a title, an optional search line, a windowed list, and a hint. There is
 * no caret pushing rows in — the selected row is the one whose bullet is filled
 * (●), and the focused row is the one whose label is accented. A list that runs
 * long (a provider's models) windows to `height`, following the cursor, with
 * ↑/↓ markers for the rest.
 */
/** A filterable / multi-select picker, as the canonical menu. */
export function pickerRows(opts: {
  title: string;
  items: PickerItem[];
  cursor: number;
  /** A dim line under the search bar, above the first item. */
  prefix?: string;
  /** A dim line at the bottom, after the last item. */
  hint?: string;
  height?: number;
  width?: number;
  query?: string;
  hitMapOut?: number[];
}): Seg[][] {
  const entries: MenuEntry[] = [];
  if (opts.prefix) entries.push({ line: opts.prefix, lineTone: color.dim, selectable: false });
  for (const it of opts.items) {
    entries.push({
      marker: it.selected ? "● " : "○ ",
      markerTone: it.selected ? color.accent : color.dim,
      label: it.label,
      detail: it.detail,
    });
  }
  if (opts.hint) entries.push({ line: opts.hint, lineTone: color.dim, selectable: false });
  return menuRows({
    title: opts.title,
    query: opts.query ?? "",
    live: opts.query !== undefined,
    items: entries,
    cursor: opts.cursor + (opts.prefix ? 1 : 0),
    height: opts.height,
    width: opts.width,
    hitMapOut: opts.hitMapOut,
  });
}

export function modelPickerRows(
  entries: { model: string; provider: string }[],
  cursor: number,
  height?: number,
  query = "",
  width?: number,
  activeModel?: string,
  activeProvider?: string,
  hitMapOut?: number[],
): Seg[][] {
  void activeProvider;
  return menuRows({
    title: "models",
    query,
    live: true,
    items: entries.map((e) => ({
      marker: e.model === activeModel ? "✓ " : "  ",
      markerTone: e.model === activeModel ? color.success : undefined,
      label: e.model,
      detail: e.provider || undefined,
    })),
    cursor,
    height,
    width,
    emptyText: "no models",
    hitMapOut,
  });
}

/** A saved session for the picker: its id and how recently it was touched. */
export type SessionItem = { id: string; updatedAt: string; messageCount: number; active?: boolean };

/**
 * The session picker: a list of saved sessions, most recent first. The active
 * session is marked; the detail carries when it was last used and its size,
 * so a long-id list is still scannable. Selecting one switches the whole app
 * to it (see `switchToSession` in App.tsx).
 */
export function sessionPickerRows(sessions: SessionItem[], cursor: number, height?: number, query = "", width?: number): Seg[][] {
  return menuRows({
    title: "sessions",
    query,
    live: true,
    items: sessions.map((s) => ({
      marker: s.active ? "✓ " : "  ",
      markerTone: s.active ? color.success : undefined,
      label: s.id,
      detail: `${s.messageCount} message${s.messageCount === 1 ? "" : "s"} · ${s.updatedAt}`,
    })),
    cursor,
    height,
    width,
    emptyText: "no saved sessions",
  });
}

export function thinkingPickerRows(options: { label: string; effort?: string }[], cursor: number, query = "", width?: number, height?: number, hitMapOut?: number[]): Seg[][] {
  return pickerRows({
    title: "reasoning effort",
    items: options.map((o, i) => ({ label: o.label, selected: i === cursor })),
    cursor,
    query,
    width,
    height,
    hitMapOut,
  });
}
/** The `/usage` menu: period summary and per-model rows in the canonical menu frame. */
export type UsagePeriod = {
  label: string;
  tokens: number;
  turns: number;
  byModel: { model: string; tokens: number }[];
};

/**
 * The usage panel as a real layout, not a pile of divider-separated lines:
 * a tab strip (today / week / month / all) with the active tab highlighted,
 * a summary for the active period, and a grouped "by model" section.
 */
export function usagePanelRows(periods: UsagePeriod[], active: number, width?: number, height?: number, hitMapOut?: number[]): Seg[][] {
  const period = periods[active] ?? periods[0]!;
  const items: MenuEntry[] = [
    { line: periods.map((p, i) => (i === active ? `[ ${p.label} ]` : `  ${p.label}  `)).join("  "), selectable: false },
    { line: `${formatTokens(period.tokens)} tokens · ${period.turns} turn${period.turns === 1 ? "" : "s"}`, selectable: false },
    { line: "by model", lineTone: color.muted, selectable: false },
    ...period.byModel.map((model) => ({
      marker: "· ",
      markerTone: color.muted,
      label: model.model,
      detail: formatTokens(model.tokens),
      selectable: false,
    })),
  ];
  if (period.byModel.length === 0) items.push({ line: "no usage recorded", lineTone: color.dim, selectable: false });
  return menuRows({
    title: "usage",
    info: true,
    items,
    width,
    height,
    emptyText: "no usage recorded",
    hitMapOut,
  });
}

/** The MCP information screen, using the same menu frame as every other picker. */
export function mcpPanelRows(width?: number, height?: number, hitMapOut?: number[]): Seg[][] {
  return menuRows({
    title: "MCP servers",
    width,
    height,
    items: [
      { line: "No MCP servers configured.", selectable: false },
      { line: "Configure MCP servers in your config file.", lineTone: color.dim, selectable: false },
    ],
    hitMapOut,
  });
}

/** The slash-command menu: the canonical rectangle whose search bar filters it. */
export function slashPopupRows(commands: { name: string; description: string; alias?: string }[], selected: number, query = "", width?: number, height?: number, hitMapOut?: number[]): Seg[][] {
  return menuRows({
    title: "commands",
    query,
    live: true,
    items: commands.map((c) => ({
      marker: c.alias !== undefined && c.alias.length === 1 ? `${c.alias} ` : "  ",
      markerTone: color.muted,
      label: `/${c.name}`,
      detail: c.description,
    })),
    cursor: selected,
    width,
    height,
    hitMapOut,
  });
}
/** The add-provider flow, one renderer per phase. */
export function addKindRows(onboarding: boolean, kinds: { id: string; label: string; auth: string[] }[], cursor: number, query?: string, height?: number, hitMapOut?: number[]): Seg[][] {
  return pickerRows({
    title: onboarding ? "welcome to actor0" : "add a provider",
    prefix: onboarding ? "bring your own provider — pick one to start" : undefined,
    items: kinds.map((k, i) => ({ label: k.label, detail: k.auth.join(" or "), selected: i === cursor })),
    cursor,
    hint: "type to filter · ↑/↓ move · enter choose · esc cancel",
    query,
    height,
    hitMapOut,
  });
}

export function addUrlRows(label: string, url: string, height?: number, hitMapOut?: number[]): { rows: Seg[][]; inputRow: number; inputCol: number } {
  const rows = menuRows({
    title: `${label} — base URL`,
    query: url,
    live: true,
    items: [{ line: "enter to continue · esc cancel", lineTone: color.dim, selectable: false }],
    height,
    hitMapOut,
  });
  return { rows, inputRow: 1, inputCol: SEARCH_INPUT_COL };
}

export function addKeyRows(label: string, key: string, height?: number, hitMapOut?: number[]): { rows: Seg[][]; inputRow: number; inputCol: number } {
  const rows = menuRows({
    title: `${label} — API key`,
    query: "•".repeat(key.length),
    live: true,
    items: [{ line: "enter to continue · esc cancel", lineTone: color.dim, selectable: false }],
    height,
    hitMapOut,
  });
  return { rows, inputRow: 1, inputCol: SEARCH_INPUT_COL };
}

export function addWorkingRows(label: string, note: string, height?: number, hitMapOut?: number[]): Seg[][] {
  const items: MenuEntry[] = [
    ...note.split("\n").map((l): MenuEntry => ({ line: l, lineTone: color.info, selectable: false })),
    { line: "esc to cancel", lineTone: color.dim, selectable: false },
  ];
  return menuRows({ title: label, items, height, hitMapOut });
}

export function addErrorRows(message: string, height?: number, hitMapOut?: number[]): Seg[][] {
  return menuRows({
    title: "add failed",
    items: [
      { line: message, lineTone: color.error, selectable: false },
      { line: "enter to try again · esc cancel", lineTone: color.dim, selectable: false },
    ],
    height,
    hitMapOut,
  });
}

export function addModelsRows(label: string, models: string[], cursor: number, chosen: Set<string>, height: number, query?: string, hitMapOut?: number[]): Seg[][] {
  return pickerRows({
    title: `${label} — ${models.length} model${models.length === 1 ? "" : "s"}`,
    items: models.map((m) => ({ label: m, selected: chosen.has(m) })),
    cursor,
    hint: "type to filter · click/space toggle · a all · n none · enter use · esc cancel",
    height,
    query,
    hitMapOut,
  });
}

export function addManualRows(label: string, manual: string, height?: number, hitMapOut?: number[]): { rows: Seg[][]; inputRow: number; inputCol: number } {
  const rows = menuRows({
    title: `${label} — no models listed`,
    query: manual,
    live: true,
    items: [{ line: "type a model name, or enter to add it and set one later with /model", lineTone: color.dim, selectable: false }],
    height,
    hitMapOut,
  });
  return { rows, inputRow: 1, inputCol: SEARCH_INPUT_COL };
}
/** The 3×3 status face box: ╭───╮ / │face│ / ╰───╯. */
export function faceBox(face: Face): Seg[][] {
  const f = FACE[face];
  return [
    plain("╭───╮", color.dim),
    [{ text: "│", color: color.dim }, { text: f, color: color.accent, bold: true }, { text: "│", color: color.dim }],
    plain("╰───╯", color.dim),
  ];
}

/**
 * The top of the screen: the status bar in its own rounded rectangle on the
 * left, the mascot at the top-right. The mascot's right edge is one column from
 * the wall and one from the status bar, which itself stops a few columns short
 * of the wall to leave room.
 */
export function topArea(cols: number, headerInfo: string, face: Face): Seg[][] {
  const inner = frameInnerWidth(cols);
  const mascot = faceBox(face);
  const mascotW = 5;
  const statusW = Math.max(16, inner - mascotW - 2);
  const status = box(
    [[{ text: headerInfo || "no provider configured — /setup", color: color.muted }]],
    statusW,
    { border: color.border },
  );
  const gap = Math.max(1, inner - statusW - mascotW - 1);
  const rows: Seg[][] = [];
  for (let r = 0; r < 3; r += 1) {
    rows.push([...status[r]!, { text: " ".repeat(gap) }, ...mascot[r]!, { text: " " }]);
  }
  return rows;
}


