import chalk from "chalk";
import type { Entry } from "../conversation.js";
import { HELP_TEXT } from "../slash.js";
import { color } from "../theme.js";
import { toolLabel } from "../tools.js";
import { parseDiffBlock } from "../diff.js";
import { formatTokens } from "../usage.js";
import { flattenText, proseWidth, reasonText, toolDetail, toolRowFailed } from "./parts.js";

/**
 * Our own renderer: the transcript and chrome as strings.
 *
 * Ink rendered these as React nodes and laid them out with Yoga; we render them
 * to coloured strings and place them at rows we choose (see term.ts). One styled
 * run of text; `visibleWidth` is the width without escapes, which is what
 * padding and truncation are measured against — the arithmetic that is silent
 * when it is wrong, kept in one place.
 */
export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean };

export function segWidth(segs: Seg[]): number {
  return segs.reduce((n, s) => n + s.text.length, 0);
}

/** Colourise a run of segments into an ANSI string. */
export function paint(segs: Seg[]): string {
  return segs
    .map((s) => {
      let fn = s.color ? chalk.hex(s.color) : chalk;
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

/** One committed transcript entry, as rows of segments (each row ≤ `cols`). */
export function entryLines(entry: Entry, cols: number): Seg[][] {
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
      const out: Seg[][] = [blank()];
      for (const line of flattenText(entry.text, proseWidth(cols))) out.push(plain(line));
      if (entry.partial) out.push(plain("… response ended before completion", color.warning));
      return out;
    }

    case "reasoning": {
      const { title, body } = reasonText(entry.text);
      const out: Seg[][] = [blank(), plain(`∴ Thinking${title ? ` · ${title}` : ""}`, color.dim)];
      if (body) for (const line of flattenText(body, proseWidth(cols - 2))) out.push(plain(`  ${line}`, color.muted, true));
      return out;
    }

    case "plan":
      return [blank(), plain(entry.title, color.info), ...flattenText(entry.plan, proseWidth(cols)).map((l) => plain(l, color.muted))];

    case "tool": {
      const failed = toolRowFailed(entry);
      const tone = failed ? color.error : color.success;
      const out: Seg[][] = [
        blank(),
        [
          { text: `${failed ? "✗" : "✓"} `, color: tone },
          { text: toolLabel(entry.name), color: color.text, bold: true },
          ...(entry.target ? [{ text: ` ${entry.target}`, color: color.dim } as Seg] : []),
        ],
      ];
      if (entry.name === "edit" && !failed) {
        for (const d of parseDiffBlock(entry.output)) {
          const sign = d.kind === "add" ? "+ " : d.kind === "remove" ? "- " : "  ";
          const t = d.kind === "add" ? color.success : d.kind === "remove" ? color.error : color.dim;
          out.push(plain(`  ${sign}${d.text.replace(/\t/g, "    ")}`, t));
        }
        return out;
      }
      const detail = toolDetail(failed ? "error" : "ok", entry.output);
      if (detail) {
        out.push(plain("  ⎿", color.dim));
        for (const line of flattenText(detail, proseWidth(cols - 2))) out.push(plain(`  ${line}`, color.dim, true));
      }
      return out;
    }

    case "notice": {
      const tone = entry.tone === "error" ? color.error : entry.tone === "warn" ? color.warning : color.info;
      const label = entry.tone === "error" ? "error" : entry.tone === "warn" ? "warning" : "·";
      const body = entry.tone === "error" ? flattenText(entry.text, proseWidth(cols)) : [entry.text];
      return [blank(), ...body.map((l) => [{ text: label, color: tone }, { text: ` ${l}`, color: color.muted }])];
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
export function liveLines(live: { text: string; reasoning: string; status?: string; tool?: { name: string; target: string }; retrying?: { attempt: number } }, frame: number, elapsed: number, cols: number, budget: number, waitingOnUser = false): Seg[][] {
  const busy = Boolean(live.text || live.reasoning || live.tool || live.status || live.retrying);
  if (!busy) return [];
  const spin = waitingOnUser ? "⏸" : "◐◓◑◒"[frame % 4];
  const out: Seg[][] = [blank()];
  if (live.retrying) out.push([{ text: `${spin} `, color: color.warning }, { text: `retrying after an interrupted attempt (${elapsed}s)`, color: color.warning }]);
  else if (live.tool) out.push([{ text: `${spin} `, color: color.accent }, { text: `${live.tool.name}${live.tool.target ? ` ${live.tool.target}` : ""}`, color: color.muted }]);
  else if (live.status) out.push([{ text: `${spin} `, color: color.accent }, { text: live.status, color: color.muted }]);
  if (live.reasoning.trim()) {
    out.push(plain("∴ Thinking", color.dim));
    for (const l of flattenText(live.reasoning.trimEnd(), proseWidth(cols - 2)).slice(-budget)) out.push(plain(`  ${l}`, color.muted, true));
  }
  if (live.text) for (const l of flattenText(live.text, proseWidth(cols)).slice(-budget)) out.push(plain(l));
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

/** The composer box: draft on the left, status face and [Send] on the right. */
export function composerRows(opts: { cols: number; draft: string; caret: number; face: Face; canSend: boolean; busy: boolean }): { rows: Seg[][]; inputRow: number; inputCol: number } {
  const width = Math.max(20, opts.cols);
  const inner = width - 2;
  const draftLines = opts.draft.split("\n");
  const hint = opts.busy ? "esc to cancel" : "enter to send · / for commands · ↑ history";
  const leftRows = Math.max(1, draftLines.length) + 1; // draft lines + hint
  const contentH = Math.max(leftRows, 4); // right column is face (3) + send (1)
  const faceW = 5;
  const promptW = Math.max(8, inner - faceW - 1);
  const glyph = opts.busy ? "· " : "❯ ";
  const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

  // A tight 3×3 face box: ╭───╮ / │face│ / ╰───╯, the face flush to the sides.
  const face = faceChar(opts.face);
  const faceBoxRows = [
    plain("╭───╮", color.dim),
    [{ text: "│", color: color.dim }, { text: face, color: color.accent, bold: true }, { text: "│", color: color.dim }],
    plain("╰───╯", color.dim),
  ];

  // Caret: which draft line and column it sits on.
  const before = opts.draft.slice(0, Math.min(opts.caret, opts.draft.length));
  const caretLine = before.split("\n").length - 1;
  const caretCol = before.length - before.lastIndexOf("\n") - 1;

  const rows: Seg[][] = [plain(`╭${"─".repeat(inner)}╮`, color.dim)];
  for (let r = 0; r < contentH; r += 1) {
    let left: Seg[];
    if (r < draftLines.length) {
      left = r === 0 ? [{ text: glyph, color: opts.busy ? color.dim : color.accent, bold: true }, { text: cut(draftLines[r]!, promptW - glyph.length), color: color.text }] : plain(cut(draftLines[r]!, promptW));
    } else if (r === draftLines.length) {
      left = plain(cut(hint, promptW), color.dim);
    } else {
      left = plain("", color.dim);
    }
    const leftFit = fitWidth(left, promptW);
    const right = r < 3 ? faceBoxRows[r]! : opts.canSend ? [{ text: "[Send]", color: color.accentText, bold: true }] : plain("      ");
    rows.push([{ text: "│", color: color.dim }, ...leftFit, { text: " " }, ...right, { text: "│", color: color.dim }]);
  }
  rows.push(plain(`╰${"─".repeat(inner)}╯`, color.dim));
  return { rows, inputRow: 1 + caretLine, inputCol: 1 + glyph.length + caretCol };
}

/** A generic selectable list, used by the provider and model pickers. */
function listRows(title: string, items: { label: string; detail?: string; mark?: string }[], cursor: number, hint: string): Seg[][] {
  const out: Seg[][] = [plain(title, color.muted)];
  items.forEach((item, i) => {
    const sel = i === cursor;
    out.push([
      { text: sel ? "❯ " : "  ", color: color.accent },
      ...(item.mark ? [{ text: item.mark, color: color.text } as Seg] : []),
      { text: item.label, color: sel ? color.accent : color.text },
      ...(item.detail ? [{ text: `  ${item.detail}`, color: color.dim } as Seg] : []),
    ]);
  });
  out.push(plain(hint, color.dim));
  return out;
}

export function providerMenuRows(providers: { name: string; label: string; active: boolean }[], cursor: number): Seg[][] {
  return listRows(
    "providers",
    providers.map((p) => ({ label: p.name, detail: p.active ? `${p.label} (active)` : p.label, mark: p.active ? "● " : "○ " })),
    cursor,
    "↑/↓ move · enter switch · a add · d remove · esc close",
  );
}

export function modelPickerRows(models: string[], cursor: number): Seg[][] {
  return listRows("choose a model", models.map((m) => ({ label: m })), cursor, "↑/↓ move · enter select · esc cancel");
}

export function thinkingPickerRows(options: { label: string; effort?: string }[], cursor: number): Seg[][] {
  return listRows("reasoning effort", options.map((o) => ({ label: o.label })), cursor, "↑/↓ move · enter select · esc cancel");
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
    { text: i === selected ? "❯ " : "  ", color: color.accent },
    { text: `/${c.name}`, color: i === selected ? color.accent : color.text },
    { text: `  ${c.description}`, color: color.dim },
  ]);
}

/** The add-provider flow, one renderer per phase. */
export function addKindRows(onboarding: boolean, kinds: { id: string; label: string; auth: string[] }[], cursor: number): Seg[][] {
  const out: Seg[][] = onboarding ? [plain("welcome to actor0", color.accent), plain("bring your own provider — pick one to start", color.dim)] : [plain("add a provider", color.muted)];
  kinds.forEach((k, i) => out.push([
    { text: i === cursor ? "❯ " : "  ", color: color.accent },
    { text: k.label, color: i === cursor ? color.accent : color.text },
    { text: `  ${k.auth.join(" or ")}`, color: color.dim },
  ]));
  out.push(plain("↑/↓ move · enter choose · esc cancel", color.dim));
  return out;
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

export function addModelsRows(label: string, models: string[], cursor: number, chosen: Set<string>): Seg[][] {
  const out: Seg[][] = [plain(`${label} — ${models.length} models`, color.muted)];
  models.forEach((m, i) => out.push([
    { text: i === cursor ? "❯ " : "  ", color: color.accent },
    { text: chosen.has(m) ? "◉ " : "○ ", color: color.text },
    { text: m, color: i === cursor ? color.accent : color.text },
  ]));
  out.push(plain("space toggles · a all · n none · enter uses highlighted · esc cancel", color.dim));
  return out;
}

export function addManualRows(label: string, manual: string): { rows: Seg[][]; inputRow: number; inputCol: number } {
  return {
    rows: [plain(`${label} — no models listed`, color.muted), plain("type a model name, or enter to add it and set one later with /model", color.dim), [{ text: "❯ ", color: color.accent }, { text: manual, color: color.text }]],
    inputRow: 2,
    inputCol: 3,
  };
}
