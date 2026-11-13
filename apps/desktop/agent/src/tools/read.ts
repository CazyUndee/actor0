import type { ToolDefinition } from "@actor0/harness";
import {
  MAX_READ_LINES,
  LARGE_FILE_BYTES,
  MAX_LINE_COLUMNS,
  binaryReason,
  capLines,
  cutNotice,
  optionalNumber,
  requireString,
  withNotice,
} from "./shared.js";
import { within } from "./within.js";
import type { ToolContext } from "./context.js";

/**
 * The read tool.
 *
 * Every detail below exists because a version without it failed a model in a
 * way the model could not detect: a cap with no continuation offset, a byte
 * budget that a single long line walked straight past, a binary file returned
 * as mojibake, a truncated result that claimed to be complete.
 */

export const readDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "read",
    description:
      "Read a text file. Returns numbered lines with the line prefix. Use `offset` and `limit` to page through a large file — the result says the offset to pass next when it cut the file. Refuses binary files and files that are not UTF-8 text. Paths may be absolute or relative to the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the working directory or absolute." },
        offset: { type: "number", description: "1-based line to start from. Defaults to 1." },
        limit: { type: "number", description: `Maximum number of lines to return. Defaults to ${MAX_READ_LINES}.` },
      },
      required: ["path"],
    },
  },
};

export async function runRead(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const asked = requireString(args, "path");
  const offset = Math.max(1, Math.floor(optionalNumber(args, "offset") ?? 1));
  const limit = Math.max(1, Math.floor(optionalNumber(args, "limit") ?? MAX_READ_LINES));
  const target = await within(ctx.cwd, asked, false);

  const stats = await ctx.bridge.getStats(target);
  if (stats.isDirectory) {
    const entries = await ctx.bridge.readDirectory(target);
    const listing = entries
      .map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b));
    return withNotice(listing.join("\n") || "(empty directory)", `[${asked} is a directory, not a file.]`);
  }

  const binary = await binaryReason(ctx.bridge, target, asked, stats.size);
  if (binary) throw new Error(binary);

  // A file larger than the window is read as a window, so a 400MB log costs one
  // bounded read rather than the whole thing; the line cap below applies either
  // way, and the continuation offset is computed against the file's own lines.
  const readSize = stats.size > LARGE_FILE_BYTES ? LARGE_FILE_BYTES : undefined;
  const raw = await ctx.bridge.readFile(target, readSize === undefined ? undefined : { pos: 0, size: readSize });
  if (raw === "") {
    return `[${asked} is empty.]`;
  }
  const allLines = raw.split("\n");
  // A trailing newline produces a final empty element that is not a line, so
  // the count matches what an editor and a line-numbered read both show.
  const lineCount = raw.endsWith("\n") ? allLines.length - 1 : allLines.length;

  const from = offset - 1;
  if (from >= lineCount) {
    return `[${asked} has ${lineCount} lines; offset ${offset} is past the end.]`;
  }
  // The caller's `limit` and the tool's own line cap both apply; the smaller
  // wins, and the caps are applied *here* rather than by pre-slicing, so the
  // continuation offset can be computed against the file's own length.
  const maxLines = Math.min(limit, MAX_READ_LINES);
  const window = allLines.slice(from);
  const { text, consumed, cuts } = capLines(window, offset, maxLines);

  const body = text
    .split("\n")
    .map((line, index) => `${String(offset + index).padStart(6)}\t${line}`)
    .join("\n");

  const lastShown = offset + consumed - 1;
  const hasMore = from + consumed < lineCount;
  const notes: string[] = [];
  if (cuts.length > 0) notes.push(cutNotice(cuts, asked));
  if (hasMore) {
    const remaining = lineCount - lastShown;
    notes.push(
      `[file has ${lineCount.toLocaleString()} lines; showing ${offset}-${lastShown}. ${remaining.toLocaleString()} more line${remaining === 1 ? "" : "s"}. Read on with offset=${lastShown + 1}.]`,
    );
  } else if (lastShown < lineCount) {
    notes.push(`[showing ${offset}-${lastShown} of ${lineCount.toLocaleString()} lines.]`);
  }
  return notes.length > 0 ? withNotice(body, notes.join("\n")) : body;
}

/** Where the read tool's line cap is documented, for the prompt's tool sentence. */
export const READ_LINE_HEADROOM = MAX_LINE_COLUMNS;
