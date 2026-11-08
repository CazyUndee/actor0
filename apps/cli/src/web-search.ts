/**
 * Web search and page fetch through Parallel's hosted MCP server.
 *
 * The CLI speaks MCP over Streamable HTTP. Parallel exposes `web_search`
 * (objective + search_queries[]) and `web_fetch` (urls[]); the MCP client
 * handles initialization, session IDs, JSON-RPC and response transport.
 */

import { McpClient, httpTransport } from "./mcp.js";

export type SearchResult = {
  title: string;
  url: string;
  published?: string;
  excerpt?: string;
};

export type SearchEnvelope = {
  query: string;
  results: SearchResult[];
};

const EXCERPT_LIMIT = 1_200;
const CONTENT_LIMIT = 40_000;
const DEFAULT_SEARCH_MCP_URL = "https://search.parallel.ai/mcp";

export type WebSearchClient = {
  webSearch(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchEnvelope>;
  openUrl(url: string, options?: { signal?: AbortSignal }): Promise<string>;
};

/** Create a Parallel client. The endpoint override keeps the HTTP protocol testable offline. */
export function createWebSearchClient(
  endpoint = process.env.ACTOR0_SEARCH_MCP_URL ?? DEFAULT_SEARCH_MCP_URL,
): WebSearchClient {
  let ready: Promise<McpClient> | undefined;

  function searchClient(): Promise<McpClient> {
    if (!ready) {
      const client = new McpClient({ transport: httpTransport(endpoint) });
      ready = client.initialize().then(() => client);
      ready.catch(() => {
        ready = undefined;
      });
    }
    return ready;
  }

  function parsePayload(text: string): { results: WireResult[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Parallel returned an invalid JSON response");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Parallel returned an unexpected response");
    }
    const results = (parsed as { results?: unknown }).results;
    return { results: Array.isArray(results) ? results as WireResult[] : [] };
  }

  async function webSearch(
    query: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<SearchEnvelope> {
    const client = await searchClient();
    const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 10;
    const result = await client.callTool(
      "web_search",
      {
        objective: query,
        search_queries: [query],
      },
      options.signal,
    );
    if (result.isError) throw new Error(result.text.trim() || "the search server refused the query");
    const { results } = parsePayload(result.text);
    return {
      query,
      results: results.map(toResult).filter((item): item is SearchResult => Boolean(item)).slice(0, limit),
    };
  }

  async function openUrl(url: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const client = await searchClient();
    const result = await client.callTool(
      "web_fetch",
      { urls: [url], objective: "extract the page's main content", full_content: true },
      options.signal,
    );
    if (result.isError) throw new Error(result.text.trim() || `the search server could not fetch ${url}`);
    const { results } = parsePayload(result.text);
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

type WireResult = {
  url?: unknown;
  title?: unknown;
  publish_date?: unknown;
  excerpts?: unknown;
  full_content?: unknown;
};

function excerptsOf(raw: WireResult): string[] {
  return Array.isArray(raw.excerpts)
    ? raw.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
    : [];
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

/** Search the configured Parallel MCP server. */
const defaultClient = createWebSearchClient();
export const webSearch = (query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchEnvelope> =>
  defaultClient.webSearch(query, options);

/** Fetch a page through Parallel and return its extracted text. */
export const openUrl = (url: string, options?: { signal?: AbortSignal }): Promise<string> =>
  defaultClient.openUrl(url, options);

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
