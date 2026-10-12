import type { ToolCall } from "@actor0/harness";
import { createToolHost } from "../../src/tools.js";
import { createTaskDelegate } from "../../src/subagent.js";
import { formatRepoTree, getRepoIndex, queryRepoIndex } from "../../src/repo-index.js";
import { formatWebResults, openUrl, webSearch } from "../../src/web-search.js";
import type { ResolvedProvider } from "../../src/config.js";

/**
 * The shared operations every candidate dispatches to.
 *
 * Built from Actor0's real capabilities: the production tools (read, rg, glob,
 * write, edit, shell, skill, task) plus the newer ones (tree/index from the
 * repo index, web_search/fetch from mst+webclaw). Every candidate routes here,
 * so a comparison isolates the *interface*, not the underlying behaviour.
 *
 * `delete` is deliberately absent: Actor0 has no delete capability, so it is an
 * unsupported operation the dispatcher records rather than one invented here.
 */

export type OperationName =
  | "read" | "grep" | "glob" | "tree" | "index" | "skill"
  | "web_search" | "fetch" | "write" | "edit" | "delete" | "shell" | "delegate";

/** Required arguments per operation — the schema-level check, never auto-filled. */
export const OPERATION_REQUIRED: Record<OperationName, string[]> = {
  read: ["path"],
  grep: ["pattern"],
  glob: ["pattern"],
  tree: [],
  index: ["query"],
  skill: ["name"],
  web_search: ["query"],
  fetch: ["url"],
  write: ["path", "content"],
  edit: ["path", "old", "new"],
  delete: ["path"],
  shell: ["command"],
  delegate: ["task"],
};

/** The fields each operation accepts (besides `op`), for the strict no-extra-field check. */
export const OPERATION_FIELDS: Record<OperationName, string[]> = {
  read: ["path", "offset", "limit"],
  grep: ["pattern", "path", "glob", "literal"],
  glob: ["pattern", "path"],
  tree: ["path", "depth"],
  index: ["query"],
  skill: ["name"],
  web_search: ["query", "limit"],
  fetch: ["url"],
  write: ["path", "content"],
  edit: ["path", "old", "new", "all"],
  delete: ["path"],
  shell: ["command", "timeout"],
  delegate: ["task"],
};

/** Operations Actor0 can actually execute. `delete` is not among them. */
export const SUPPORTED_OPERATIONS: OperationName[] = [
  "read", "grep", "glob", "tree", "index", "skill", "web_search", "fetch", "write", "edit", "shell", "delegate",
];

/** Operation name → production tool name, where they differ. */
const PRODUCTION_NAME: Partial<Record<OperationName, string>> = { grep: "rg", delegate: "task" };

export type Underlying = {
  cwd: string;
  run(operation: OperationName, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
};

export function createUnderlying(options: { cwd: string; provider?: ResolvedProvider }): Underlying {
  const { cwd } = options;
  const taskDelegate = options.provider ? createTaskDelegate({ provider: options.provider, cwd }) : undefined;
  const host = createToolHost({ cwd, ...(taskDelegate ? { taskDelegate } : {}) });

  return {
    cwd,
    async run(operation, args, signal): Promise<string> {
      switch (operation) {
        case "tree": {
          const index = getRepoIndex(cwd);
          const depth = typeof args.depth === "number" ? args.depth : 2;
          return formatRepoTree(index, { maxDepth: depth }) || "(the repo has no files to show)";
        }
        case "index": {
          const index = getRepoIndex(cwd);
          const limit = typeof args.limit === "number" ? args.limit : 50;
          const hits = queryRepoIndex(index, String(args.query ?? ""), limit);
          return hits.length > 0 ? hits.join("\n") : `No files matching "${String(args.query ?? "")}".`;
        }
        case "web_search": {
          const envelope = await webSearch(String(args.query ?? ""), {
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
            signal,
          });
          return formatWebResults(envelope);
        }
        case "fetch":
          return openUrl(String(args.url ?? ""), { signal });
        default: {
          const name = PRODUCTION_NAME[operation] ?? operation;
          const call: ToolCall = { id: "bench", type: "function", function: { name, arguments: JSON.stringify(args) } };
          return host.execute(call, signal);
        }
      }
    },
  };
}
