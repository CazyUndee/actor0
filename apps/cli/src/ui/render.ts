import chalk from "chalk";
import type { Entry } from "../conversation.js";
import { HELP_TEXT } from "../slash.js";
import { color } from "../theme.js";
import { parseDiffBlock } from "../diff.js";
import { formatTokens } from "../usage.js";
import { flattenText, proseWidth, reasonText, toolRowFailed } from "./parts.js";
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
    case "grep":
      return "Grep";
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
  const text = output.replace(/\r/g, "").trim();
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

const plain = (text: string, tone?: string, dim?: boolean): Seg[] => [{ text, ...(tone ? { color: tone } : {}), ...(dim ? { dim: true } : {}) }];
const blank = (): Seg[] => [{ text: " " }];

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
export function panel(title: string, rows: Seg[][], innerW: number): Seg[][] {
  const boxW = Math.max(24, innerW - 4);
  const inset = Math.max(0, Math.floor((innerW - boxW) / 2));
  const boxed = box(rows, boxW, { border: color.border, title });
  return boxed.map((r) => fitWidth([{ text: " ".repeat(inset), dim: true }, ...r], innerW));
}

/** A full-width rule, for separating sections inside a panel. */
function rule(): Seg[] {
  return [{ text: "─".repeat(200), color: color.dim }];
}

/** The provider list, as a modal panel: search, two-line entries, add, hint. */
export function providerPanelRows(providers: { name: string; label: string; active: boolean }[], cursor: number, query: string): Seg[][] {
  const rows: Seg[][] = [];
  rows.push(query ? [{ text: `search ${query}`, color: color.text }, { text: "▏", color: color.accent }] : [{ text: "search providers…", color: color.dim }]);
  rows.push(blank());
  providers.forEach((p, i) => {
    const focused = i === cursor;
    rows.push([
      { text: focused ? "●" : "○", color: focused ? color.accent : color.dim },
      { text: "  " },
      { text: p.name, color: focused ? color.accent : color.text, bold: focused },
      ...(p.active ? [{ text: "   ACTIVE", color: color.accent } as Seg] : []),
    ]);
    rows.push([{ text: "   " }, { text: p.label, color: color.dim }]);
  });
  if (providers.length === 0) rows.push([{ text: "no providers yet — add one below", color: color.dim }]);
  rows.push(blank());
  rows.push(rule());
  rows.push([{ text: "＋  ", color: color.accent }, { text: "Add provider", color: cursor === providers.length ? color.accent : color.text, bold: cursor === providers.length }]);
  rows.push(blank());
  rows.push([{ text: "↵ Select   → Manage   d Remove   Esc Close", color: color.dim }]);
  return rows;
}

/** The manage screen for one provider: its details, then actions. */
export function managePanelRows(
  provider: { name: string; label: string; model: string; endpoint: string; auth: string },
  cursor: number,
): Seg[][] {
  const rows: Seg[][] = [];
  rows.push([{ text: provider.name, color: color.accent, bold: true }]);
  rows.push([{ text: provider.label, color: color.dim }]);
  rows.push(blank());
  const col = 22;
  const detail = (label: string, value: string): Seg[] => [
    { text: label.padEnd(col), color: color.dim },
    { text: value, color: color.text },
  ];
  rows.push(detail("Model", provider.model || "(none)"));
  rows.push(detail("Endpoint", provider.endpoint));
  rows.push(detail("Authentication", provider.auth));
  rows.push(blank());
  rows.push(rule());
  const actions = ["Change model", "Edit provider", "Test connection", "Remove provider"];
  actions.forEach((a, i) => {
    const focused = i === cursor;
    rows.push([{ text: focused ? "●" : "○", color: focused ? color.accent : color.dim }, { text: "  " }, { text: a, color: focused ? color.accent : color.text, bold: focused }]);
  });
  rows.push(blank());
  rows.push([{ text: "↑↓ Navigate   ↵ Open   Esc Back", color: color.dim }]);
  return rows;
}

/** One committed transcript entry, as rows of segments (each row ≤ `cols`). */
export function entryLines(entry: Entry, cols: number, expandReasoning = false): Seg[][] {
  switch (entry.kind) {
    case "user":
      return [
        blank(),
        [
          { text: "❯ ", color: color.accent, bold: true },
          { text: entry.text, color: color.text },
        ],
      ];

    case "assistant": {
      const rows = renderMarkdown(entry.text, cols - 4);
      if (entry.partial) rows.push(plain("… response ended before completion", color.warning));
      return [blank(), ...box(rows, cols, { border: color.dim })];
    }

    case "reasoning": {
      const { title, body } = reasonText(entry.text);
      const label = `∴ ${title || "thinking"}`;
      // Collapsed by default: a one-line preview with an expand hint, so the
      // model's raw chain-of-thought does not flood the transcript.
      if (!expandReasoning) {
        const flat = body.replace(/\s+/g, " ").trim();
        const room = Math.max(10, cols - label.length - 14);
        const cut = flat.slice(0, room);
        const row: Seg[] = [
          { text: label, color: color.dim },
          { text: `  ${cut}${flat.length > cut.length ? "…" : ""}`, color: color.dim, dim: true },
          { text: "  ⌃r", color: color.dim, dim: true },
        ];
        return [blank(), ...box([row], cols, { border: color.dim })];
      }
      const rows: Seg[][] = [plain(label, color.dim)];
      if (body) for (const line of flattenText(body, proseWidth(cols - 6))) rows.push(plain(line, color.muted, true));
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
        ...(entry.target ? [{ text: `  ${entry.target}`, color: color.dim } as Seg] : []),
      ];
      const rows: Seg[][] = [head];
      if (entry.name === "edit" && !failed) {
        for (const d of parseDiffBlock(entry.output)) {
          const sign = d.kind === "add" ? "+ " : d.kind === "remove" ? "- " : "  ";
          const t = d.kind === "add" ? color.success : d.kind === "remove" ? color.error : color.dim;
          rows.push(plain(`  ${sign}${d.text.replace(/\t/g, "    ")}`, t));
        }
      } else {
        // Output reads as an indented, dimmed block under the header — line
        // structure preserved, long output cut with a count, no cryptic marker.
        for (const line of toolOutputLines(failed ? "error" : "ok", entry.output, cols - 6)) rows.push(plain(`  ${line}`, color.dim, true));
      }
      // A grey, highlighted rounded rectangle — the tool call reads as its own
      // block rather than more transcript chatter.
      return [blank(), ...box(rows, cols, { border: color.muted, bg: color.surface })];
    }

    case "notice": {
      const isError = entry.tone === "error";
      const tone = isError ? color.error : entry.tone === "warn" ? color.warning : color.info;
      const body = isError ? flattenText(entry.text, proseWidth(cols - 4)) : [entry.text];
      const rows = body.map((l) => [{ text: isError ? "" : "· ", color: tone }, { text: l, color: isError ? color.error : color.muted }]);
      // A real error (not a failed tool) gets a red highlighted box.
      return isError ? [blank(), ...box(rows, cols, { border: color.error })] : [blank(), ...rows];
    }

    case "help": {
      const out: Seg[][] = [blank()];
      for (const l of helpBox(cols)) out.push(l);
      return out;
    }

    default:
      return [];
  }
}

/** The commands panel, laid out to fit `cols` and returned as rows of segments. */
export function helpBox(cols: number): Seg[][] {
  const width = Math.max(40, Math.min(cols - 2, 92));
  const inner = width - 4;
  const rows = HELP_TEXT.map(([command, description]) => {
    const [name, alias] = command.split(/\s{2,}/);
    return { name: name ?? command, alias: alias ?? "", description };
  });
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const aliasW = Math.max(...rows.map((r) => r.alias.length));
  const line = (content: string, tone?: string): Seg[] => plain(`│ ${content.padEnd(inner)} │`, tone ?? color.dim);
  const edge = (l: string, r: string): Seg[] => plain(`${l}${"─".repeat(width - 2)}${r}`, color.dim);
  const out: Seg[][] = [edge("╭", "╮"), line("commands", color.muted), line("")];
  for (const r of rows) out.push(line(`${r.name.padEnd(nameW + 2)}${r.alias.padEnd(aliasW + 2)}${r.description}`.slice(0, inner)));
  out.push(line(""), line("esc cancels a running turn · Ctrl+D quits"), edge("╰", "╯"));
  return out;
}

/** The in-flight region (spinner, reasoning, streamed text) as rows of segments. */
export function liveLines(live: { text: string; reasoning: string; status?: string; tool?: { name: string; target: string }; retrying?: { attempt: number } }, frame: number, elapsed: number, cols: number, budget: number, waitingOnUser = false, expandReasoning = false): Seg[][] {
  const busy = Boolean(live.text || live.reasoning || live.tool || live.status || live.retrying);
  if (!busy) return [];
  const spin = waitingOnUser ? "⏸" : "◐◓◑◒"[frame % 4];
  const out: Seg[][] = [blank()];
  if (live.retrying) out.push([{ text: `${spin} `, color: color.warning }, { text: `retrying after an interrupted attempt (${elapsed}s)`, color: color.warning }]);
  else if (live.tool) out.push([{ text: `${spin} `, color: color.accent }, { text: `${toolDisplayName(live.tool.name)}${live.tool.target ? `  ${live.tool.target}` : ""}`, color: color.muted }]);
  else if (live.status) out.push([{ text: `${spin} `, color: color.accent }, { text: live.status, color: color.muted }]);
  if (live.reasoning.trim()) {
    if (expandReasoning) {
      out.push(plain("∴ thinking", color.dim));
      for (const l of flattenText(live.reasoning.trimEnd(), proseWidth(cols - 2)).slice(-budget)) out.push(plain(`  ${l}`, color.muted, true));
    } else {
      // Collapsed: the latest thought, tail-trimmed to one line.
      const flat = live.reasoning.replace(/\s+/g, " ").trim();
      const room = Math.max(20, cols - 20);
      const cut = flat.length > room ? `…${flat.slice(-room)}` : flat;
      out.push([{ text: "∴ thinking ", color: color.dim }, { text: cut, color: color.dim, dim: true }, { text: "  ⌃r", color: color.dim, dim: true }]);
    }
  }
  // The streamed answer is boxed from the first token, identical to the
  // committed entry, so the border is there while it generates and there is no
  // snap when it lands. When it outgrows the viewport the older lines are
  // counted at the top of the box, not silently dropped.
  if (live.text) {
    const all = renderMarkdown(live.text, cols - 4);
    // Leave room for the leading blank, a collapsed reasoning line, the box's
    // two borders and the count, so the box and its indicator both fit.
    const room = Math.max(1, budget - 5);
    const dropped = Math.max(0, all.length - room);
    const rows = dropped > 0 ? [plain(`↑ ${dropped} more line${dropped === 1 ? "" : "s"}`, color.dim, true), ...all.slice(all.length - room)] : all;
    out.push(blank());
    out.push(...box(rows, cols, { border: color.dim }));
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
export function stateFace(input: { live: { text: string; reasoning: string }; lastEntry?: Entry; blocked: boolean; busy: boolean }): Face {
  const { live, lastEntry, blocked, busy } = input;
  if (lastEntry?.kind === "notice" && lastEntry.tone === "error") return "dead";
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
export function composerRows(opts: { cols: number; draft: string; caret: number; busy: boolean }): { rows: Seg[][]; inputRow: number; inputCol: number } {
  const width = Math.max(20, opts.cols);
  const inner = width - 2;
  const draftLines = opts.draft.split("\n");
  const glyph = opts.busy ? "· " : "❯ ";
  const contentH = Math.max(1, draftLines.length);
  const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

  const rows: Seg[][] = [plain(`╭${"─".repeat(inner)}╮`, color.dim)];
  for (let r = 0; r < contentH; r += 1) {
    const content: Seg[] =
      r === 0
        ? [{ text: glyph, color: opts.busy ? color.dim : color.accent, bold: true }, { text: cut(draftLines[r]!, inner - glyph.length), color: color.text }]
        : plain(cut(draftLines[r]!, inner));
    rows.push([{ text: "│", color: color.dim }, ...fitWidth(content, inner), { text: "│", color: color.dim }]);
  }
  rows.push(plain(`╰${"─".repeat(inner)}╯`, color.dim));

  const before = opts.draft.slice(0, Math.min(opts.caret, opts.draft.length));
  const caretLine = before.split("\n").length - 1;
  const caretCol = before.length - before.lastIndexOf("\n") - 1;
  // inputCol is the composer-row column just after the caret's character: the
  // left │ (1) + the prompt start, then the glyph and the characters before it.
  return { rows, inputRow: 1 + caretLine, inputCol: 2 + glyph.length + caretCol };
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
export function pickerRows(opts: {
  title: string;
  items: PickerItem[];
  cursor: number;
  hint: string;
  height: number;
  query?: string;
}): Seg[][] {
  const out: Seg[][] = [plain(opts.title, color.muted)];
  if (opts.query !== undefined) {
    out.push([{ text: "search ", color: color.dim }, { text: opts.query, color: color.text }, { text: "▏", color: color.accent }]);
  }
  // Reserve rows for the title, the search line, the hint and up to two scroll
  // indicators; whatever is left is the item window.
  const reserved = 1 + (opts.query !== undefined ? 1 : 0) + 1 + 2;
  const itemH = Math.max(1, opts.height - reserved);
  const n = opts.items.length;
  const start = n <= itemH ? 0 : Math.max(0, Math.min(opts.cursor - Math.floor(itemH / 2), n - itemH));
  const end = Math.min(n, start + itemH);
  if (start > 0) out.push(plain(`  ↑ ${start} above`, color.dim));
  for (let i = start; i < end; i += 1) {
    const item = opts.items[i]!;
    const focused = i === opts.cursor;
    out.push([
      { text: item.selected ? "● " : "○ ", color: item.selected ? color.accent : color.dim },
      { text: item.label, color: focused ? color.accent : color.text },
      ...(item.detail ? [{ text: `  ${item.detail}`, color: color.dim } as Seg] : []),
    ]);
  }
  if (end < n) out.push(plain(`  ↓ ${n - end} more`, color.dim));
  out.push(plain(opts.hint, color.dim));
  return out;
}

export function modelPickerRows(models: string[], cursor: number, height: number, query?: string): Seg[][] {
  return pickerRows({
    title: query ? `choose a model — ${models.length} match${models.length === 1 ? "" : "es"}` : "choose a model",
    items: models.map((m, i) => ({ label: m, selected: i === cursor })),
    cursor,
    hint: "type to filter · ↑/↓ move · enter select · esc cancel",
    height,
    query,
  });
}

export function thinkingPickerRows(options: { label: string; effort?: string }[], cursor: number, query?: string): Seg[][] {
  return pickerRows({ title: "reasoning effort", items: options.map((o, i) => ({ label: o.label, selected: i === cursor })), cursor, hint: "type to filter · ↑/↓ move · enter select · esc cancel", height: options.length + 6, query });
}

/** The `/usage` panel: a period, a total, and a per-model breakdown. */
export function usagePanelRows(periodLabel: string, sinceTokens: number, sinceTurns: number, allTokens: number, allTurns: number, byModel: { model: string; tokens: number }[]): Seg[][] {
  const out: Seg[][] = [plain("usage", color.muted), plain(periodLabel, color.dim)];
  out.push([{ text: `${formatTokens(sinceTokens)} tokens`, color: color.text }, { text: ` across ${sinceTurns} turn${sinceTurns === 1 ? "" : "s"}`, color: color.dim }]);
  out.push(plain(`all time: ${formatTokens(allTokens)} tokens across ${allTurns} turns`, color.dim));
  if (byModel.length > 0) {
    out.push(plain("", color.dim));
    for (const row of byModel) out.push([{ text: row.model, color: color.muted }, { text: `  ${formatTokens(row.tokens)}`, color: color.dim }]);
  }
  out.push(plain("tab/←/→ switch period · esc close", color.dim));
  return out;
}

export function slashPopupRows(commands: { name: string; description: string }[], selected: number): Seg[][] {
  return commands.map((c, i) => [
    { text: i === selected ? "● " : "○ ", color: i === selected ? color.accent : color.dim },
    { text: `/${c.name}`, color: i === selected ? color.accent : color.text },
    { text: `  ${c.description}`, color: color.dim },
  ]);
}

/** The add-provider flow, one renderer per phase. */
export function addKindRows(onboarding: boolean, kinds: { id: string; label: string; auth: string[] }[], cursor: number, query?: string): Seg[][] {
  const rows = pickerRows({
    title: onboarding ? "welcome to actor0" : "add a provider",
    items: kinds.map((k, i) => ({ label: k.label, detail: k.auth.join(" or "), selected: i === cursor })),
    cursor,
    hint: "type to filter · ↑/↓ move · enter choose · esc cancel",
    height: kinds.length + 8,
    query,
  });
  if (onboarding) rows.splice(1, 0, plain("bring your own provider — pick one to start", color.dim));
  return rows;
}

export function addUrlRows(label: string, url: string): { rows: Seg[][]; inputRow: number; inputCol: number } {
  return {
    rows: [plain(`${label} — base URL`, color.muted), [{ text: "❯ ", color: color.accent }, { text: url, color: color.text }], plain("enter to continue · esc cancel", color.dim)],
    inputRow: 1,
    inputCol: 3,
  };
}

export function addKeyRows(label: string, key: string): { rows: Seg[][]; inputRow: number; inputCol: number } {
  return {
    rows: [plain(`${label} — API key`, color.muted), [{ text: "❯ ", color: color.accent }, { text: "•".repeat(key.length), color: color.text }], plain("enter to continue · esc cancel", color.dim)],
    inputRow: 1,
    inputCol: 3,
  };
}

export function addWorkingRows(label: string, note: string): Seg[][] {
  return [plain(label, color.muted), ...note.split("\n").map((l) => plain(l, color.info)), plain("esc to cancel", color.dim)];
}

export function addErrorRows(message: string): Seg[][] {
  return [plain(message, color.error), plain("enter to try again · esc cancel", color.dim)];
}

export function addModelsRows(label: string, models: string[], cursor: number, chosen: Set<string>, height: number, query?: string): Seg[][] {
  return pickerRows({
    title: `${label} — ${models.length} model${models.length === 1 ? "" : "s"}`,
    items: models.map((m) => ({ label: m, selected: chosen.has(m) })),
    cursor,
    hint: "type to filter · space toggle · a all · n none · enter use · esc cancel",
    height,
    query,
  });
}

export function addManualRows(label: string, manual: string): { rows: Seg[][]; inputRow: number; inputCol: number } {
  return {
    rows: [plain(`${label} — no models listed`, color.muted), plain("type a model name, or enter to add it and set one later with /model", color.dim), [{ text: "❯ ", color: color.accent }, { text: manual, color: color.text }]],
    inputRow: 2,
    inputCol: 3,
  };
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
