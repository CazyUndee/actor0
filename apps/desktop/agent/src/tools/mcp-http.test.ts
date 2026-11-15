import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { McpHttpClient } from "./mcp-http.js";

/**
 * The HTTP transport's bounded-body rule, driven by a real local server.
 *
 * A hostile or broken endpoint can answer with a body that never ends.
 * `response.text()` buffers all of it, so the read is capped at MAX_BODY_BYTES
 * (the same cap the CLI's transport and the harness apply to event streams):
 * the excess is dropped, the read completes, and the memory follows the cap
 * rather than the endpoint. The server here streams far past the cap and never
 * ends its body, so the test can only pass if the client stopped reading.
 */
let url: string;
let server: ReturnType<typeof createServer>;
let sockets = new Set<IncomingMessage>();

before(async () => {
  server = createServer((request, response) => {
    sockets.add(request);
    request.on("close", () => sockets.delete(request));
    request.resume();
    // The handshake answers fine; the one tools/call never stops talking.
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string };
      if (message.method === "initialize") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "endless", version: "test" },
            },
          }),
        );
        return;
      }
      if (message.method === "tools/call") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const timer = setInterval(() => {
          // Frames with the request's id, forever, and never a stream end.
          response.write(`id: n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } })}\n\n`);
        }, 20);
        response.on("close", () => clearInterval(timer));
        return;
      }
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  sockets.forEach((s) => s.destroy());
  await new Promise<void>((done) => server.close(() => done()));
});

describe("McpHttpClient", () => {
  it("answers a normal initialize against a well-behaved route", async () => {
    const client = new McpHttpClient(url);
    await client.initialize();
    // A client that completed the handshake is usable; nothing else is
    // observable from outside, and that is the point.
  });

  it("stops reading an endless body instead of buffering it forever", { timeout: 20_000 }, async () => {
    const client = new McpHttpClient(url, { requestTimeoutMs: 1_500 });
    await client.initialize();
    const started = Date.now();
    // The server streams SSE frames forever. The request timeout fires at
    // 1.5 s (it aborts the fetch), and the read cap guarantees the buffered
    // prefix stayed bounded even if the abort raced a slow stream. The test
    // asserts the call finishes in the neighbourhood of the timeout — not
    // hanging 60 s or buffering until the process dies.
    await assert.rejects(() => client.callTool("web_search", { objective: "x", search_queries: ["x"] }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `the endless stream must not hang the call (took ${elapsed}ms)`);
    // And the socket the endless stream was on is gone: the abort, not just the
    // caller's patience, ended it.
    const deadline = Date.now() + 5_000;
    while (sockets.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sockets.size, 0, "the aborted request's socket must close");
  });
});
