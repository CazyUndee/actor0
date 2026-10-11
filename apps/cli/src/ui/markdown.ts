import { color } from "../theme.js";
import { segments, renderTable, type Segment } from "./parts.js";
import type { Seg } from "./render.js";

/**
 * Render GitHub markdown to styled terminal rows.
 *
 * `flattenText` already gets the *structure* right — fences stay on one row, a
 * table lines its columns up — but it flattens everything to plain strings, so
 * a fenced command and an ordinary sentence look identical and inline emphasis
 * never renders. This produces the same layout as `Seg[][]` with the emphasis
 * actually painted: inline code, bold, links; headed, listed and quoted blocks;
 * a fenced block that reads as code.
 *
 * The budget is still counted in rendered rows — `segments()` carries the fences
 * so a code line is one row however long, while prose wraps — so this slots in
 * wherever `flattenText` did.
 */

/** Inline markdown → styled segments. Code first, so a backtick run is literal. */
function inline(text: string, base: Omit<Seg, "text"> = {}): Seg[] {
  const out: Seg[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ text: buf, ...base });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // `inline code`
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ text: code[1]!, color: color.accentText, bg: color.surface, ...base });
      i += code[0]!.length;
      continue;
    }
    // **bold**
    const bold = /^\*\*([^*]+)\*\*/.exec(rest) ?? /^__([^_]+)__/.exec(rest);
    if (bold) {
      flush();
      out.push({ text: bold[1]!, bold: true, ...base });
      i += bold[0]!.length;
      continue;
    }
    // [link](url) — the label reads as a link; the URL is not worth a row.
    const link = /^\[([^\]]+)\]\([^)]*\)/.exec(rest);
    if (link) {
      flush();
      out.push({ text: link[1]!, color: color.accent, ...base });
      i += link[0]!.length;
      continue;
    }
    // *italic* / _italic_
    const ital = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest);
    if (ital) {
      flush();
      out.push({ text: ital[1]!, dim: true, ...base });
      i += ital[0]!.length;
      continue;
    }
    buf += text[i]!;
    i += 1;
  }
  flush();
  return out.length ? out : [{ text: "", ...base }];
}

/** Wrap styled segments to `width` at word boundaries, keeping each run's style. */
function wrapSegs(segs: Seg[], width: number): Seg[][] {
  const rows: Seg[][] = [];
  let row: Seg[] = [];
  let used = 0;
  const brk = (): void => {
    rows.push(row);
    row = [];
    used = 0;
  };
  for (const seg of segs) {
    for (const tok of seg.text.split(/(\s+)/)) {
      if (tok === "") continue;
      const space = /^\s+$/.test(tok);
      if (used + tok.length <= width) {
        row.push({ ...seg, text: tok });
        used += tok.length;
        continue;
      }
      if (space) {
        brk();
        continue;
      }
      if (used > 0) brk();
      let w = tok;
      while (w.length > width) {
        row.push({ ...seg, text: w.slice(0, width) });
        brk();
        w = w.slice(width);
      }
      row.push({ ...seg, text: w });
      used = w.length;
    }
  }
  if (row.length) rows.push(row);
  return rows.length ? rows : [[]];
}

/** A fenced code block: the fences dim, the body one row per line, never wrapped. */
function codeBlock(seg: Extract<Segment, { kind: "code" }>, width: number): Seg[][] {
  const rows: Seg[][] = [];
  if (seg.open) rows.push([{ text: seg.open, color: color.dim, dim: true }]);
  for (const line of seg.body) rows.push([{ text: line.length > width ? `${line.slice(0, width - 1)}…` : line, color: color.text }]);
  if (seg.close) rows.push([{ text: seg.close, color: color.dim, dim: true }]);
  return rows;
}

/** A table: the aligned grid with a bold accent header, or the key/value fallback. */
function tableBlock(seg: Extract<Segment, { kind: "table" }>, cols: number): Seg[][] {
  const lines = renderTable(seg, cols);
  const grid = (lines[0] ?? "").startsWith("|");
  return lines.map((line, i) => {
    if (grid) {
      if (i === 0) return [{ text: line, color: color.accent, bold: true }];
      if (i === 1) return [{ text: line, color: color.dim, dim: true }];
      return [{ text: line }];
    }
    // Fallback ("label: value"): the label recedes, the value reads.
    const at = line.indexOf(": ");
    if (at > 0) return [{ text: line.slice(0, at + 1), color: color.muted }, { text: line.slice(at + 1) }];
    return [{ text: line, color: color.muted }];
  });
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/** Prose: headings, rules, quotes, lists and paragraphs, each with inline styling. */
function proseBlock(text: string, cols: number): Seg[][] {
  const width = Math.max(20, cols - 4);
  const lines = text.split("\n");
  const out: Seg[][] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(...wrapSegs([{ text: heading[2]!, bold: true, ...(level <= 2 ? { color: color.accent } : { color: color.text }) }], width));
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      out.push([{ text: "─".repeat(width), color: color.dim, dim: true }]);
      i += 1;
      continue;
    }
    // A run of blockquote lines, joined and rendered behind a dim bar.
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (!q) break;
        quoted.push(q[1]!);
        i += 1;
      }
      for (const row of wrapSegs(inline(quoted.join(" "), { dim: true }), width - 2)) {
        out.push([{ text: "│ ", color: color.dim, dim: true }, ...row]);
      }
      continue;
    }
    // A run of list items; the bullet is accented and wraps with a hanging indent.
    if (LIST.test(line)) {
      while (i < lines.length) {
        const item = LIST.exec(lines[i]!);
        if (!item) break;
        const indent = item[1]!.length;
        const bullet = /\d/.test(item[2]!) ? `${item[2]} ` : "• ";
        const pad = " ".repeat(indent + bullet.length);
        const body = wrapSegs(inline(item[3]!), width - pad.length);
        body.forEach((row, r) => {
          out.push(r === 0 ? [{ text: " ".repeat(indent) + bullet, color: color.accent }, ...row] : [{ text: pad }, ...row]);
        });
        i += 1;
      }
      continue;
    }
    // A paragraph: consecutive plain lines, inline-styled and wrapped together.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === "" || HEADING.test(l) || HR.test(l) || LIST.test(l) || QUOTE.test(l)) break;
      para.push(l);
      i += 1;
    }
    out.push(...wrapSegs(inline(para.join(" ")), width));
  }
  return out;
}

/** Render markdown to styled rows, each row at most `cols` visible columns. */
export function renderMarkdown(text: string, cols: number): Seg[][] {
  const out: Seg[][] = [];
  for (const seg of segments(text)) {
    if (seg.kind === "code") out.push(...codeBlock(seg, Math.max(20, cols - 4)));
    else if (seg.kind === "table") out.push(...tableBlock(seg, cols));
    else out.push(...proseBlock(seg.text, cols));
  }
  return out;
}
