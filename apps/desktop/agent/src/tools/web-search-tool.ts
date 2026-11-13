import type { ToolDefinition } from "@actor0/harness";
import { optionalNumber, requireString } from "./shared.js";
import { createWebSearchClient, formatWebResults } from "./web-search.js";
import type { ToolContext } from "./context.js";

/**
 * The web-search tool.
 *
 * Split from `web-search.ts` so the registry can import the *definition*
 * cheaply: this module pulls in the HTTP client and the MCP transport, and the
 * host loads it lazily on the first search, keeping the boot path free of a
 * network stack it may never use.
 */

export const webSearchDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for information about anything. Returns a list of results with titles, URLs and snippets. Use it for questions about current events, facts, documentation, or anything you do not already know.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: { type: "number", description: "Maximum number of results to return (default 10, max 20)." },
      },
      required: ["query"],
    },
  },
};

// One client per process: initialization is a round trip, and a search
// followed by another should not pay for it twice.
let client: ReturnType<typeof createWebSearchClient> | undefined;

export async function runWebSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const query = requireString(args, "query");
  const limit = Math.floor(Number(optionalNumber(args, "limit") ?? 10)) || 1;
  const cappedLimit = Math.min(Math.max(limit, 1), 20);
  client ??= createWebSearchClient();
  const envelope = await client.webSearch(query, { limit: cappedLimit, signal: ctx.signal });
  return formatWebResults(envelope);
}

/** Test seam: replace the client for a deterministic run. */
export function setWebSearchClient(next: ReturnType<typeof createWebSearchClient> | undefined): void {
  client = next;
}
