/**
 * A unified-diff view of an `edit`.
 *
 * An exact-string edit already *is* a diff — the matched text is removed, the
 * replacement added, at a known line — so no LCS is needed. This renders that
 * change with a few lines of context either side, the way Codex presents an
 * `apply_patch`: a `+`/`-`/space gutter the renderer colours green/red/dim.
 *
 * Pure, so the line math is testable without a terminal; the tool feeds it the
 * pre-edit content and the two strings, and the transcript renders the result.
 */

export type DiffKind = "context" | "add" | "remove";

export type DiffLine = { kind: DiffKind; text: string };

/** How many unchanged lines to show on each side of the change. */
const CONTEXT = 3;

/**
 * The changed region of `content` as diff lines, or [] when `before` is absent.
 *
 * `before`/`after` are the exact strings the edit replaced; their line spans in
 * `content` are located by the first match, and `CONTEXT` lines around them are
 * kept so the change reads in place rather than as two floating fragments.
 */
export function editDiffLines(content: string, before: string, after: string): DiffLine[] {
  const index = content.indexOf(before);
  if (index === -1) return [];
  const lines = content.split("\n");
  const startLine = content.slice(0, index).split("\n").length - 1;
  const beforeLines = before.split("\n");
  // An empty replacement is a deletion: it removes lines and adds none.
  const afterLines = after === "" ? [] : after.split("\n");
  const from = Math.max(0, startLine - CONTEXT);
  const to = Math.min(lines.length, startLine + beforeLines.length + CONTEXT);

  const out: DiffLine[] = [];
  for (let i = from; i < startLine; i += 1) out.push({ kind: "context", text: lines[i] ?? "" });
  for (const text of beforeLines) out.push({ kind: "remove", text });
  for (const text of afterLines) out.push({ kind: "add", text });
  for (let i = startLine + beforeLines.length; i < to; i += 1) out.push({ kind: "context", text: lines[i] ?? "" });
  return out;
}

/** The diff lines as a fenced `diff` block — for the tool result the model reads. */
export function formatEditDiff(content: string, before: string, after: string): string {
  const lines = editDiffLines(content, before, after);
  if (lines.length === 0) return "";
  const body = lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`)
    .join("\n");
  return `\`\`\`diff\n${body}\n\`\`\``;
}

/** The lines inside a fenced `diff` block, or [] if the text has none. */
export function parseDiffBlock(text: string): DiffLine[] {
  const match = /```diff\r?\n([\s\S]*?)\r?\n?```/.exec(text);
  if (!match) return [];
  return match[1]!
    .split("\n")
    .map((line) => {
      const sign = line[0];
      const kind: DiffKind = sign === "+" ? "add" : sign === "-" ? "remove" : "context";
      return { kind, text: line.slice(1) };
    });
}
