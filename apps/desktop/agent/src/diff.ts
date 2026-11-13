/**
 * Line-oriented diffs, for the edit tool's result and the transcript's view of
 * it.
 *
 * A single-pass common-prefix/common-suffix trim is deliberate rather than a
 * full LCS: an edit made by a model is almost always one contiguous change, and
 * the trimmed form shows exactly that change without the quadratic cost or the
 * arbitrary hunk alignment a general diff produces. When the change is *not*
 * contiguous the rendering is still correct — it is just less minimal — and a
 * correct-but-bigger diff is strictly better than a slow one on a large file.
 */

export type DiffLine = { kind: "add" | "del" | "context"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const out: DiffLine[] = [];
  for (let i = start; i < endA; i += 1) out.push({ kind: "del", text: a[i]! });
  for (let i = start; i < endB; i += 1) out.push({ kind: "add", text: b[i]! });
  return out;
}

/** A compact `-old`/`+new` rendering, capped so a huge rewrite stays readable. */
export function formatEditDiff(before: string, after: string, maxLines = 40): string {
  const lines = diffLines(before, after);
  if (lines.length === 0) return "";
  const shown = lines.slice(0, maxLines);
  const rest = lines.length - shown.length;
  const body = shown
    .map((line) => `${line.kind === "add" ? "+" : "-"}${line.text}`)
    .join("\n");
  return rest > 0 ? `${body}\n... ${rest} more line${rest === 1 ? "" : "s"}` : body;
}
