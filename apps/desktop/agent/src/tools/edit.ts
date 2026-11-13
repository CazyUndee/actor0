import type { ToolDefinition } from "@actor0/harness";
import { formatEditDiff } from "../diff.js";
import { optionalBoolean, requireString, requireText, withNotice } from "./shared.js";
import { within } from "./within.js";
import type { ToolContext } from "./context.js";

/**
 * The edit tool — replace an exact string in a file.
 *
 * Three details are load-bearing and each was learned the hard way:
 *
 *  - **The replacement is data, not a pattern.** `String.prototype.replace`
 *    reads `$$`, `$&`, `$'` and `` $` `` in a *plain-string replacement* as its
 *    own syntax, so an edit that writes a shell script's `echo $$` silently
 *    lands `echo $` — no error anywhere, and the model cannot see the
 *    difference between what it asked for and what was written. `split` +
 *    `join` is literal by construction, and with exactly one occurrence it is
 *    the same replacement.
 *  - **`new_string: ""` is a deletion.** It is read with `requireText` for the
 *    same reason `write`'s content is.
 *  - **The file's own line endings and BOM are preserved.** A CRLF checkout
 *    normalised to LF would show every line as changed, and the user would be
 *    handed a diff of the whole file for a one-line edit.
 */
export const editDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "edit",
    description:
      "Replace an exact string in a file. `old_string` must match the file's text exactly, including indentation, and must be unique — pass replace_all to change every occurrence. Use this instead of rewriting a whole file. Confined to the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the working directory." },
        old_string: { type: "string", description: "The exact text to replace. Must appear in the file." },
        new_string: { type: "string", description: "The replacement text. May be empty to delete the old text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
};

/** The BOM a file may start with, so it can be written back unchanged. */
const BOM = "\uFEFF";

export async function runEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const asked = requireString(args, "path");
  const oldString = requireText(args, "old_string");
  const newString = requireText(args, "new_string");
  const replaceAll = optionalBoolean(args, "replace_all") ?? false;

  if (oldString === newString) {
    throw new Error("old_string and new_string are identical; nothing to do");
  }
  const target = await within(ctx.cwd, asked);
  const original = await ctx.bridge.readFile(target);

  // Detect, then normalise for matching, then restore on write.
  const hasBom = original.startsWith(BOM);
  const body = hasBom ? original.slice(BOM.length) : original;
  const crlf = body.includes("\r\n");
  const normalized = body.replace(/\r\n/g, "\n");

  // The caller's strings are normalised the same way, so a model that writes
  // `\n` in its anchor still matches a CRLF file on disk.
  const needle = oldString.replace(/\r\n/g, "\n");
  const replacement = newString.replace(/\r\n/g, "\n");

  const occurrences = normalized.split(needle).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `old_string was not found in ${asked}. Read the file first and copy the exact text, including indentation.`,
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${occurrences} times in ${asked}. Add more surrounding context to make it unique, or pass replace_all: true.`,
    );
  }

  // Literal by construction: split/join never interprets `$&`, `$'` or `$$`.
  const next = replaceAll
    ? normalized.split(needle).join(replacement)
    : normalized.split(needle).join(replacement);

  const restored = (crlf ? next.replace(/\n/g, "\r\n") : next);
  await ctx.bridge.writeFile(target, hasBom ? BOM + restored : restored);

  const changed = diffSummary(body, restored);
  const count = replaceAll ? occurrences : 1;
  return withNotice(
    changed,
    `[edited ${asked} — ${count} replacement${count === 1 ? "" : "s"}]`,
  );
}

/** The changed lines only, capped, so an edit's result reads as a diff. */
function diffSummary(before: string, after: string): string {
  const diff = formatEditDiff(before, after);
  return diff || "(no visible change)";
}
