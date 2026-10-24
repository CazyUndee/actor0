import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { hostMcpServer, restrictedToolHost, serveStdio } from "./mcp-serve.js";
import { connectMcp } from "./mcp.js";
import type { ToolCall, ToolHost, ToolDefinition } from "@actor0/harness";

/**
 * The serving direction of MCP: Actor0's own `ToolHost` behind an `McpServer`.
 *
 * In-process tests wire a real `McpServer` to the repo's own `McpClient`
 * through a pipe (the same discipline `mcp.test.ts` applies to the other
 * direction), and `serveStdio` runs against injected streams — a
 * `Readable.from` input and a collecting `Writable` — so the wire framing is
 * tested without touching `process.stdout`, which the test runner owns.
 */

const definition = (name: string, description: string, parameters: Record<string, unknown> = { type: "object", properties: {} }): ToolDefinition => ({
  type: "function",
  function: { name, description, parameters },
});

/** A host that records what it was executed with. */
function fakeHost(tools: ToolDefinition[], output: string): { host: ToolHost; executed: ToolCall[] } {
  const executed: ToolCall[] = [];
  const host: ToolHost = {
    definitions: () => tools,
    async execute(call: ToolCall): Promise<string> {
      executed.push(call);
      return output;
    },
  };
  return { host, executed };
}

const signal = new AbortController().signal;

test("mcpToolsFromHost maps a host's definitions to MCP tools and routes calls through execute", async () => {
  const { host, executed } = fakeHost([definition("read", "read a file", { type: "object", properties: { path: { type: "string" } } }), definition("shell", "run a command")], "file-contents");
  const server = hostMcpServer(host, { name: "actor0" });
  const client = await connectMcp({ server });
  const tools = await client.listTools(signal);
  assert.deepEqual(tools.map((tool) => tool.name), ["read", "shell"]);
  assert.equal(tools[0]!.inputSchema?.type, "object");

  const result = await client.callTool("read", { path: "AGENTS.md" }, signal);
  assert.equal(result.text, "file-contents");
  assert.equal(result.isError, false);
  // The round trip is object → stringified arguments → execute, and the host
  // is the layer that validates: what it saw is the contract.
  assert.deepEqual(JSON.parse(executed[0]!.function.arguments), { path: "AGENTS.md" });
  assert.equal(executed[0]!.function.name, "read");
  await client.close();
});

test("a failing tool surfaces as a JSON-RPC error the client sees", async () => {
  const host: ToolHost = {
    definitions: () => [definition("boom", "always fails")],
    async execute(): Promise<string> {
      throw new Error("kaboom");
    },
  };
  const client = await connectMcp({ server: hostMcpServer(host, { name: "actor0" }) });
  await assert.rejects(() => client.callTool("boom", {}, signal), /kaboom/);
  await client.close();
});

test("restrictedToolHost offers only the subset and never lists what it withholds", async () => {
  const { host } = fakeHost(
    [definition("read", "read"), definition("write", "write"), definition("shell", "run"), definition("rg", "search")],
    "out",
  );
  const restricted = restrictedToolHost(host, ["read", "rg"]);
  assert.deepEqual(restricted.definitions().map((tool) => tool.function.name).sort(), ["read", "rg"]);

  const out = await restricted.execute(
    { id: "1", type: "function", function: { name: "rg", arguments: "{}" } },
    signal,
  );
  assert.equal(out, "out");

  // The refusal names only the offered set: an error that listed `write` and
  // `shell` would advertise capabilities the connection was never given.
  await assert.rejects(
    () => restricted.execute({ id: "1", type: "function", function: { name: "write", arguments: "{}" } }, signal),
    (error: Error) => {
      assert.match(error.message, /unknown tool "write"/);
      assert.match(error.message, /Available: read, rg/);
      assert.doesNotMatch(error.message, /shell/);
      return true;
    },
  );
});

test("serveStdio answers initialize, tools/list and tools/call on the injected wire", { timeout: 10_000 }, async () => {
  const { host } = fakeHost([definition("echo", "echo", { type: "object", properties: { text: { type: "string" } } })], "echo: hi");
  const server = hostMcpServer(host, { name: "actor0" });

  const linesOut: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      linesOut.push(chunk.toString());
      callback();
    },
  });
  // Every well-formed request gets a response — five: initialize, tools/list,
  // the successful call, and the two refusals. The notification and the
  // garbage line produce none. The only async hazard is the response that is
  // still in its .then when the input ends, so wait for the count rather than
  // for a fixed sleep.
  const received = (count: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const check = (): void => {
        if (linesOut.length >= count) return resolve();
        if (Date.now() > deadline) return reject(new Error(`expected ${count} responses, got ${linesOut.length}`));
        setTimeout(check, 5);
      };
      check();
    });
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    "not-json-garbage", // dropped, connection survives
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } }),
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "bogus/method", params: {} }),
  ];
  const stdin = Readable.from(lines.map((line) => `${line}\n`));

  const drained = serveStdio(server, { input: stdin, output: stdout });
  await received(5);
  void drained;

  const responses = linesOut
    .join("")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string }; tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: { code: number; message: string } });
  const byId = new Map(responses.filter((r) => r.id !== undefined).map((r) => [r.id!, r]));
  assert.equal(byId.get(1)!.result?.serverInfo?.name, "actor0");
  assert.deepEqual(byId.get(2)!.result?.tools?.map((tool) => tool.name), ["echo"]);
  assert.equal(byId.get(3)!.result?.content?.[0]?.text, "echo: hi");
  // Unknown tool and unknown method are JSON-RPC errors, not crashes:
  // the connection is still answering after both.
  assert.equal(byId.get(4)!.error?.code, -32603);
  assert.match(byId.get(4)!.error!.message, /unknown tool: nope/);
  assert.equal(byId.get(5)!.error?.code, -32603);
  assert.match(byId.get(5)!.error!.message, /method not found/);
});
