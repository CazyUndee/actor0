/**
 * Web search and page fetch over MCP, instead of downloaded binaries.
 *
 * Connects to a remote MCP server (default https://mcp.parallel.ai/mcp) over
 * HTTP, so nothing here downloads a platform-specific binary or verifies a
 * SHA256: ship the JS, point it at the endpoint, and it works.
 *
 * The contract below is what the endpoint actually answers, measured against it
 * rather than assumed. The tools are `web_search` (`objective` plus
 * `search_queries[]` — there is no limit parameter) and `web_fetch` (`urls[]`),
 * and both return `{ results: [{ url, title, publish_date, excerpts }] }`. An
 * earlier draft of this file called `search`/`fetch` with a `limit`, which the
 * server rejects with "Missing required argument: search_queries" — a shape
 * invented from the catalogue, not read off the wire.
 */

import { McpClient, httpTransport } from "./mcp.js";

/** One result from search. */
export type SearchResult = {
  title: string;
  url: string;
  /** The date the page says it was published, when the server reports one. */
  published?: string;
  /** The server's excerpt, trimmed to something a transcript can hold. */
  excerpt?: string;
};

export type SearchEnvelope = {
  query: string;
  results: SearchResult[];
};

/** How much of one excerpt is worth carrying into a tool result. */
const EXCERPT_LIMIT = 1_200;

/** How much of a fetched page survives; long articles are otherwise unbounded. */
const CONTENT_LIMIT = 40_000;

const SEARCH_MCP_URL = process.env.ACTOR0_SEARCH_MCP_URL ?? "https://mcp.parallel.ai/mcp";

/** The server's continuation token, echoed so follow-up searches stay in-session. */
let sessionId: string | undefined;

let ready: Promise<McpClient> | undefined;

/**
 * One client for the process: the handshake is the expensive part, and every
 * search after it is one POST. A failed handshake is not cached — the next call
 * tries again rather than replaying the same refusal forever.
 */
function searchClient(): Promise<McpClient> {
  if (!ready) {
    const client = new McpClient({ transport: httpTransport(SEARCH_MCP_URL) });
    ready = client.initialize().then(() => client);
    ready.catch(() => {
      ready = undefined;
    });
  }
  return ready;
}

/** A result as the server shapes it, before any of it is trusted. */
type WireResult = {
  url?: unknown;
  title?: unknown;
  publish_date?: unknown;
  excerpts?: unknown;
  full_content?: unknown;
};

/** A `web_search`/`web_fetch` payload; junk yields no results, not a throw. */
function parsePayload(text: string): { results: WireResult[] } {
  try {
    const parsed = JSON.parse(text) as { results?: unknown; session_id?: unknown };
    if (typeof parsed.session_id === "string") sessionId = parsed.session_id;
    return { results: Array.isArray(parsed.results) ? (parsed.results as WireResult[]) : [] };
  } catch {
    return { results: [] };
  }
}

/** Pull the strings out of an `excerpts` array, ignoring anything else. */
function excerptsOf(raw: WireResult): string[] {
  return Array.isArray(raw.excerpts) ? raw.excerpts.filter((e): e is string => typeof e === "string") : [];
}

/** Map one wire result, dropping the ones with no URL to cite. */
function toResult(raw: WireResult): SearchResult | undefined {
  const url = typeof raw.url === "string" ? raw.url : "";
  if (!url) return undefined;
  const excerpt = excerptsOf(raw).join("\n\n").trim();
  return {
    url,
    title: typeof raw.title === "string" && raw.title ? raw.title : url,
    ...(typeof raw.publish_date === "string" && raw.publish_date ? { published: raw.publish_date } : {}),
    ...(excerpt ? { excerpt: excerpt.slice(0, EXCERPT_LIMIT) } : {}),
  };
}

/** Search the web and return what the server found, trimmed to a transcript. */
export async function webSearch(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchEnvelope> {
  const client = await searchClient();
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 10;
  const result = await client.callTool(
    "web_search",
    {
      objective: query,
      search_queries: [query],
      ...(sessionId ? { session_id: sessionId } : {}),
    },
    options.signal,
  );
  if (result.isError) throw new Error(result.text.trim() || "the search server refused the query");
  const { results } = parsePayload(result.text);
  return {
    query,
    results: results.map(toResult).filter((r): r is SearchResult => Boolean(r)).slice(0, limit),
  };
}

/** Fetch one page through the server and return its text. */
export async function openUrl(url: string, options: { signal?: AbortSignal } = {}): Promise<string> {
  const client = await searchClient();
  const result = await client.callTool(
    "web_fetch",
    { urls: [url], objective: "extract the page's main content", full_content: true },
    options.signal,
  );
  if (result.isError) throw new Error(result.text.trim() || `the server could not fetch ${url}`);
  const { results } = parsePayload(result.text);
  const page = results.find((r) => typeof r.full_content === "string" && r.full_content) ?? results[0];
  if (!page) return `(no content extracted from ${url})`;
  const full = typeof page.full_content === "string" ? page.full_content : "";
  const text = (full || excerptsOf(page).join("\n\n")).trim();
  if (!text) return `(no content extracted from ${url})`;
  return text.length > CONTENT_LIMIT ? `${text.slice(0, CONTENT_LIMIT)}\n\n[cut: the page was ${text.length} characters]` : text;
}

/** Format results for the model: numbered, with title, url, and excerpt. */
export function formatWebResults(envelope: SearchEnvelope): string {
  if (envelope.results.length === 0) return `No web results for "${envelope.query}".`;
  const lines = envelope.results.map((r, i) => {
    const head = `${i + 1}. ${r.title}\n   ${r.url}${r.published ? `\n   published ${r.published}` : ""}`;
    if (!r.excerpt) return head;
    // Excerpts arrive as page text with hard breaks; indent every line so they
    // read as one block rather than as rows of the transcript.
    return `${head}\n   ${r.excerpt.replace(/\s*\n\s*/g, "\n   ").trim()}`;
  });
  return `${envelope.results.length} result${envelope.results.length === 1 ? "" : "s"} for "${envelope.query}":\n\n${lines.join("\n\n")}`;
}
