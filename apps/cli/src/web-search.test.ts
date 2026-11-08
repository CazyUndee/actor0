import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createWebSearchClient, formatWebResults } from "./web-search.js";

type ToolHandler = (name: string, args: Record<string, unknown>) => {
  payload?: unknown;
  text?: string;
  error?: boolean;
};

async function withParallelServer(
  handler: ToolHandler,
  run: (endpoint: string, requests: Array<{ method: string; params?: Record<string, unknown>; session?: string }>) => Promise<void>,
): Promise<void> {
  const requests: Array<{ method: string; params?: Record<string, unknown>; session?: string }> = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };

    requests.push({
      method: message.method,
      ...(message.params ? { params: message.params } : {}),
      ...(request.headers["mcp-session-id"] ? { session: String(request.headers["mcp-session-id"]) } : {}),
    });

    if (message.method === "notifications/initialized") {
      response.writeHead(202, {
        "Mcp-Session-Id": "parallel-test-session",
        Connection: "close",
      }).end();
      return;
    }

    let result: unknown;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "parallel", version: "test" },
      };
    } else if (message.method === "tools/call") {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const outcome = handler(name, args);
      result = {
        content: [{ type: "text", text: outcome.text ?? JSON.stringify(outcome.payload ?? {}) }],
        isError: outcome.error ?? false,
      };
    } else {
      response.writeHead(400).end("unexpected method");
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": "parallel-test-session",
      Connection: "close",
    }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/mcp`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("webSearch calls Parallel web_search and normalizes its results", async () => {
  let searchCalls = 0;
  await withParallelServer(
    (name, args) => {
      assert.equal(name, "web_search");
      const expectedQuery = searchCalls++ === 0 ? "rust async runtimes" : "follow-up query";
      assert.equal(args.objective, expectedQuery);
      assert.deepEqual(args.search_queries, [expectedQuery]);
      return {
        payload: {
          search_id: "search_123",
          results: [
            {
              title: "Tokio",
              url: "https://tokio.rs",
              publish_date: "2026-10-01",
              excerpts: ["A runtime for async Rust.", "Built around Tokio."],
            },
            { url: "https://example.com/no-title", excerpts: [] },
            { title: "Missing URL", excerpts: ["This must be discarded."] },
          ],
        },
      };
    },
    async (endpoint, requests) => {
      const client = createWebSearchClient(endpoint);
      const result = await client.webSearch("rust async runtimes", { limit: 2 });
      assert.deepEqual(result, {
        query: "rust async runtimes",
        results: [
          {
            title: "Tokio",
            url: "https://tokio.rs",
            published: "2026-10-01",
            excerpt: "A runtime for async Rust.\n\nBuilt around Tokio.",
          },
          { title: "https://example.com/no-title", url: "https://example.com/no-title" },
        ],
      });
      assert.deepEqual(requests.map((request) => request.method), [
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
      assert.equal(requests[2]?.session, "parallel-test-session");

      await client.webSearch("follow-up query");
      const followUpArgs = requests[3]?.params?.arguments as Record<string, unknown> | undefined;
      assert.equal(requests[3]?.session, "parallel-test-session");
      assert.equal("session_id" in (followUpArgs ?? {}), false);
    },
  );
});

test("openUrl calls Parallel web_fetch and returns full page content", async () => {
  await withParallelServer(
    (name, args) => {
      assert.equal(name, "web_fetch");
      assert.deepEqual(args.urls, ["https://example.com/article"]);
      assert.equal(args.full_content, true);
      return {
        payload: {
          results: [{
            url: "https://example.com/article",
            full_content: "# Article\n\nThe extracted page content.",
            excerpts: ["short excerpt"],
          }],
        },
      };
    },
    async (endpoint) => {
      const client = createWebSearchClient(endpoint);
      assert.equal(
        await client.openUrl("https://example.com/article"),
        "# Article\n\nThe extracted page content.",
      );
    },
  );
});

test("openUrl falls back to excerpts when full_content is absent", async () => {
  await withParallelServer(
    () => ({ payload: { results: [{ url: "https://example.com", excerpts: ["First paragraph.", "Second paragraph."] }] } }),
    async (endpoint) => {
      const client = createWebSearchClient(endpoint);
      assert.equal(await client.openUrl("https://example.com"), "First paragraph.\n\nSecond paragraph.");
    },
  );
});

test("webSearch surfaces errors returned by the Parallel MCP tool", async () => {
  await withParallelServer(
    () => ({ payload: { message: "rate limited" }, error: true }),
    async (endpoint) => {
      const client = createWebSearchClient(endpoint);
      await assert.rejects(() => client.webSearch("test"), /rate limited/);
    },
  );
});

test("webSearch rejects malformed Parallel payloads instead of hiding them as empty results", async () => {
  await withParallelServer(
    () => ({ text: "not JSON" }),
    async (endpoint) => {
      const client = createWebSearchClient(endpoint);
      await assert.rejects(() => client.webSearch("test"), /invalid JSON response/);
    },
  );
});

test("formatWebResults renders numbered results and the empty state", () => {
  const formatted = formatWebResults({
    query: "rust",
    results: [
      { title: "Rust", url: "https://rust-lang.org", published: "2026-10-01", excerpt: "A language.\nFast and safe." },
      { title: "Tokio", url: "https://tokio.rs" },
    ],
  });
  assert.match(formatted, /2 results for "rust"/);
  assert.match(formatted, /1\. Rust/);
  assert.match(formatted, /published 2026-10-01/);
  assert.match(formatted, / {3}A language\.\n {3}Fast and safe\./);
  assert.match(formatWebResults({ query: "nothing", results: [] }), /No web results for "nothing"\./);
});
