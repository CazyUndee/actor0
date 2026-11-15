// Red tests for the unbounded/mortal reads in the CLI MCP httpTransport.
//
// Two defects, one root: the per-request timeout settles McpClient's promise
// but never aborts the underlying fetch, and the JSON-body path reads
// response.text() to the end. A hostile (or merely broken) endpoint that
// answers with a body that never ends keeps the connection open and the
// buffer growing long after every request has "timed out" — the timeout
// lies, and the memory follows the connection, not the request.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { httpTransport, McpClient } from "./mcp.js";

/**
 * A one-route local MCP server that records its open request sockets, so a
 * test can prove the client actually hung up rather than merely gave up
 * waiting.
 */
function serve(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; sockets: Set<IncomingMessage> }> {
  const sockets = new Set<IncomingMessage>();
  const server = createServer((request, response) => {
    sockets.add(request);
    request.on("close", () => sockets.delete(request));
    respond(request, response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
        sockets,
      });
    });
  });
}

test("a request that times out also aborts its fetch and closes the connection", { timeout: 15_000 }, async () => {
  const { url, close, sockets } = await serve((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    // Stream the body "forever": a chunk every 50ms, never an end.
    const timer = setInterval(() => {
      response.write("x".repeat(64 * 1024));
    }, 50);
    response.on("close", () => clearInterval(timer));
  });
  try {
    const transport = httpTransport(url);
    const client = new McpClient({ transport, requestTimeoutMs: 300 });
    await assert.rejects(() => client.initialize(), /timed out/);
    // The request gave up; the fetch it spawned must be aborted too. The
    // server sees the socket go away — that is the observable proof.
    const deadline = Date.now() + 5_000;
    while (sockets.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sockets.size, 0, "a timed-out request must not leave its fetch streaming");
  } finally {
    await close();
  }
});
