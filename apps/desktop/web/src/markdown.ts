/**
 * Markdown, parsed into blocks.
 *
 * The CLI promised the model that "GitHub markdown renders: fenced code blocks
 * with a language tag, inline code for paths and identifiers, lists, tables and
 * headings" — and for a long time the promise was a lie, because every answer
 * went through one word wrapper. A prompt is a specification, not decoration, so
 * the renderer here has to actually do it.
 *
 * Two behaviours matter more than the block list:
 *
 *  - **An unterminated fence is the streaming case, not an edge case.** For most
 *    of a streaming answer the closing fence has not arrived yet, so a parser
 *    that treats it as prose wraps exactly the content that is about to become
 *    code. It is returned as a code block with `closed: false`.
 *  - **A table is a data-loss trap when it is re-wrapped.** Folded by the word
 *    wrapper, the `| --- |` delimiter row prints as literal dashes and each
 *    value separates from its own row. So a table is a block of its own and is
 *    never re-flowed.
 *
 * The parser is pure so it is testable without a browser, which matters because
 * the failure mode above is invisible in a screenshot.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang?: string; text: string; closed: boolean }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "rule" };

const FENCE = /^(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Split a table row into cells, dropping the outer pipes. */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let i = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1]!;
      const lang = fence[2] || undefined;
      const body: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const candidate = lines[i]!;
        if (candidate.trimEnd().startsWith(marker) && candidate.trim().replace(/`+$|~+$/, "").length === 0) {
          closed = true;
          i += 1;
          break;
        }
        // A nested fence of a different length is content, not the end.
        body.push(candidate);
        i += 1;
      }
      blocks.push({ type: "code", ...(lang ? { lang } : {}), text: body.join("\n"), closed });
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!) && lines[i]!.includes("|")) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (i < lines.length) {
        const match = (isOrdered ? ORDERED : BULLET).exec(lines[i]!);
        if (match) {
          items.push(match[1]!.trim());
          i += 1;
          continue;
        }
        // An indented continuation line belongs to the item above it.
        if (items.length > 0 && /^\s{2,}\S/.test(lines[i]!)) {
          items[items.length - 1] = `${items[items.length - 1]} ${lines[i]!.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const quoted: string[] = [quote[1]!];
      i += 1;
      while (i < lines.length) {
        const next = QUOTE.exec(lines[i]!);
        if (!next) break;
        quoted.push(next[1]!);
        i += 1;
      }
      blocks.push({ type: "quote", text: quoted.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

/**
 * Split a line into inline runs.
 *
 * One pass, left to right, longest marker first, so `` `code` `` wins over
 * `**`, and a marker inside code is literal text. Anything unclosed is text —
 * a streamed half-written `**bold` must render as the characters the model
 * actually wrote, not as an empty strong run.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const pushText = (): void => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    if (rest.startsWith("`")) {
      const end = rest.indexOf("`", 1);
      if (end > 0) {
        pushText();
        out.push({ type: "code", text: rest.slice(1, end) });
        i += end + 1;
        continue;
      }
    }

    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const end = rest.indexOf(marker, 2);
      if (end > 2) {
        pushText();
        out.push({ type: "strong", text: rest.slice(2, end) });
        i += end + 2;
        continue;
      }
    }

    if (rest.startsWith("*") || rest.startsWith("_")) {
      const marker = rest[0]!;
      const end = rest.indexOf(marker, 1);
      if (end > 1) {
        pushText();
        out.push({ type: "em", text: rest.slice(1, end) });
        i += end + 1;
        continue;
      }
    }

    if (rest.startsWith("[")) {
      const close = rest.indexOf("](");
      const end = close === -1 ? -1 : rest.indexOf(")", close + 2);
      if (close > 0 && end > close + 2) {
        pushText();
        out.push({ type: "link", text: rest.slice(1, close), href: rest.slice(close + 2, end) });
        i += end + 1;
        continue;
      }
    }

    buffer += text[i];
    i += 1;
  }
  pushText();
  return out;
}

/** Plain text of an inline run list — used by tests and by a copy action. */
export function inlineText(runs: Inline[]): string {
  return runs.map((run) => run.text).join("");
}
