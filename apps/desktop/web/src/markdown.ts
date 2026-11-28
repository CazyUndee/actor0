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

/**
 * One list item, and the list nested under it.
 *
 * A flat list of strings was a *hierarchy loss*: a model writing
 *
 *   - surfaces
 *     - the bar
 *     - the composer
 *
 * meant two levels of meaning and got one, because the indented line was joined
 * onto the item above it as a continuation. A reader cannot tell a child from a
 * continuation, and a continuation is exactly what an indented prose line is —
 * so the shape has to carry the depth rather than the text.
 */
export type ListItem = { text: string; children?: ListBlock };

export type ListBlock = { type: "list"; ordered: boolean; items: ListItem[] };

export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang?: string; text: string; closed: boolean }
  | ListBlock
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "rule" };

const FENCE = /^(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
/** A list line: indent, marker, text. */
const LIST_LINE = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Indent width of a list marker: a tab is one level, so are two spaces. */
function indentOf(whitespace: string): number {
  let width = 0;
  for (const ch of whitespace) width += ch === "\t" ? 2 : 1;
  return width;
}

/**
 * A list, with the nesting the model actually wrote.
 *
 * Depth is the marker's own indent (a tab and two spaces are both one level —
 * models write both, often in the same list). A blank line inside a list is
 * spacing, not the end: a list that stops at every blank line turns a model's
 * grouped bullets into three lists. An *indented* line that is not a marker
 * continues the deepest item, which is what keeps a wrapped bullet a paragraph.
 */
function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const stack: { indent: number; block: ListBlock }[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = LIST_LINE.exec(line);
    if (!match) {
      if (line.trim() === "") {
        const nextMatch = i + 1 < lines.length ? LIST_LINE.exec(lines[i + 1]!) : null;
        if (nextMatch) {
          i += 1;
          continue;
        }
        break;
      }
      const deepest = stack[stack.length - 1];
      const item = deepest?.block.items[deepest.block.items.length - 1];
      if (item && /^\s+\S/.test(line)) {
        item.text = `${item.text} ${line.trim()}`;
        i += 1;
        continue;
      }
      break;
    }
    const indent = indentOf(match[1]!);
    const ordered = /\d/.test(match[2]!);
    // Close every list this line is not inside.
    while (stack.length > 0 && indent < stack[stack.length - 1]!.indent) stack.pop();
    let frame = stack[stack.length - 1];
    if (frame && indent === frame.indent && ordered !== frame.block.ordered) {
      // Same level, a different marker: a new list rather than more of this one.
      break;
    }
    if (!frame) {
      frame = { indent, block: { type: "list", ordered, items: [] } };
      stack.push(frame);
    } else if (indent > frame.indent) {
      const parent = frame.block.items[frame.block.items.length - 1];
      const child: ListBlock = { type: "list", ordered, items: [] };
      if (parent) parent.children = child;
      frame = { indent, block: child };
      stack.push(frame);
    }
    frame.block.items.push({ text: match[3]!.trim() });
    i += 1;
  }
  return { block: stack[0]!.block, next: i };
}

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

    if (LIST_LINE.test(line)) {
      flushParagraph();
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
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
