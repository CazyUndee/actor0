import { McpHttpClient } from "./mcp-http.js";

/**
 * Web search and page fetch, through Parallel's hosted MCP server.
 *
 * The endpoint is configurable (`ACTOR0_SEARCH_MCP_URL`) so a test can point at
 * a local server, and the default is the hosted one — no API key, no binary,
 * no version to pin. The transport handles initialization and session ids; this
 * file only knows Parallel's tool names and the shape of what they return.
 */

export type SearchResult = {
  title: string;
  url: string;
  published?: string;
  excerpt?: string;
};

export type SearchEnvelope = { query: string; results: SearchResult[] };

const EXCERPT_LIMIT = 1_200;
const CONTENT_LIMIT = 40_000;
const DEFAULT_SEARCH_MCP_URL = "https://search.parallel.ai/mcp";

type WireResult = {
  url?: unknown;
  title?: unknown;
  publish_date?: unknown;
  excerpts?: unknown;
  full_content?: unknown;
};

function excerptsOf(raw: WireResult): string[] {
  return Array.isArray(raw.excerpts) ? raw.excerpts.filter((item): item is string => typeof item === "string") : [];
}

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

function parsePayload(text: string): WireResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the search server returned an invalid JSON response");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the search server returned an unexpected response");
  }
  const results = (parsed as { results?: unknown }).results;
  return Array.isArray(results) ? (results as WireResult[]) : [];
}

export type WebSearchClient = {
  webSearch(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchEnvelope>;
  openUrl(url: string, options?: { signal?: AbortSignal }): Promise<string>;
};

export function createWebSearchClient(
  endpoint = process.env.ACTOR0_SEARCH_MCP_URL ?? DEFAULT_SEARCH_MCP_URL,
): WebSearchClient {
  // One client per process, initialized once and re-initialized if it dies.
  let ready: Promise<McpHttpClient> | undefined;

  function client(): Promise<McpHttpClient> {
    if (!ready) {
      const instance = new McpHttpClient(endpoint);
      ready = instance.initialize().then(() => instance);
      ready.catch(() => {
        ready = undefined;
      });
    }
    return ready;
  }

  async function webSearch(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchEnvelope> {
    const mcp = await client();
    const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 10;
    const result = await mcp.callTool("web_search", { objective: query, search_queries: [query] }, options.signal);
    if (result.isError) throw new Error(result.text.trim() || "the search server refused the query");
    return {
      query,
      results: parsePayload(result.text)
        .map(toResult)
        .filter((item): item is SearchResult => Boolean(item))
        .slice(0, limit),
    };
  }

  async function openUrl(url: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const mcp = await client();
    const result = await mcp.callTool(
      "web_fetch",
      { urls: [url], objective: "extract the page's main content", full_content: true },
      options.signal,
    );
    if (result.isError) throw new Error(result.text.trim() || `the search server could not fetch ${url}`);
    const results = parsePayload(result.text);
    const page = results.find((item) => typeof item.full_content === "string" && item.full_content) ?? results[0];
    if (!page) return `(no content extracted from ${url})`;
    const full = typeof page.full_content === "string" ? page.full_content : "";
    const content = (full || excerptsOf(page).join("\n\n")).trim();
    if (!content) return `(no content extracted from ${url})`;
    return content.length > CONTENT_LIMIT
      ? `${content.slice(0, CONTENT_LIMIT)}\n\n[cut: the page was ${content.length} characters]`
      : content;
  }

  return { webSearch, openUrl };
}

/** Format results for the model: numbered, with title, URL and excerpt. */
export function formatWebResults(envelope: SearchEnvelope): string {
  if (envelope.results.length === 0) return `No web results for "${envelope.query}".`;
  const lines = envelope.results.map((result, index) => {
    const head = `${index + 1}. ${result.title}\n   ${result.url}${result.published ? `\n   published ${result.published}` : ""}`;
    if (!result.excerpt) return head;
    return `${head}\n   ${result.excerpt.replace(/\s*\n\s*/g, "\n   ").trim()}`;
  });
  return `${envelope.results.length} result${envelope.results.length === 1 ? "" : "s"} for "${envelope.query}":\n\n${lines.join("\n\n")}`;
}
