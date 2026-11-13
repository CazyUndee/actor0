import type { ToolDefinition } from "@actor0/harness";
import { requireString, requireText } from "./shared.js";
import { within } from "./within.js";
import type { ToolContext } from "./context.js";

/**
 * The write tool — a whole file, created or replaced.
 *
 * `content` is read with `requireText`, not `requireString`, because emptying a
 * file is a real thing to ask for and the empty string is the value that does
 * it. Rejecting it as a "missing parameter" pushed the model into shelling out
 * with a heredoc, which is both more destructive and less visible.
 *
 * A missing parent directory is created rather than reported: the model asking
 * for `src/new/thing.ts` means `src/new/` should exist, and an error that only
 * says "no such directory" costs a round trip to learn nothing.
 */
export const writeDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "write",
    description:
      "Write a file, creating it or replacing its whole contents. Parent directories are created as needed. Use this for new files; use `edit` for a change to an existing file, so the diff stays small. Confined to the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write, relative to the working directory." },
        content: { type: "string", description: "The complete file contents. May be empty." },
      },
      required: ["path", "content"],
    },
  },
};

export async function runWrite(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const asked = requireString(args, "path");
  const content = requireText(args, "content");
  const target = await within(ctx.cwd, asked);

  const bytes = Buffer.byteLength(content, "utf8");
  await ctx.bridge.writeFile(target, content);
  return `[wrote ${bytes} byte${bytes === 1 ? "" : "s"} to ${asked}]`;
}
