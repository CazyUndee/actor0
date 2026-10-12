import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcp, McpServer, mcpToolHost } from "./mcp.js";
import type { McpClient } from "./mcp.js";

/**
 * The MCP client, driven end to end. In-process tests wire a real `McpServer`
 * straight to a client through a pipe — no subprocess, no serialization — so
 * the handshake, tool listing, tool calls and the host wrapper are all
 * exercised against the actual protocol. One test spawns a real MCP server over
 * stdio to prove that transport too.
 */

const signal = new AbortController().signal;
const opened: McpClient[] = [];
const track = (client: McpClient): McpClient => {
  opened.push(client);
  return client;
};

const demoServer = (): McpServer =>
  new McpServer({ name: "demo", version: "1.0" }, [
    { name: "echo", description: "echo the input back", run: (args) => `echo: ${String(args.text ?? "")}` },
    { name: "boom", description: "always fails", run: () => { throw new Error("kaboom"); } },
  ]);

after(() => {
  for (const client of opened) void client.close();
});

test("connectMcp completes the handshake and reports the server", async () => {
  const client = track(await connectMcp({ server: demoServer() }));
  assert.deepEqual(client.serverInfo, { name: "demo", version: "1.0" });
});

test("listTools returns the server's tools with their schemas", async () => {
  const client = track(await connectMcp({ server: demoServer() }));
  const tools = await client.listTools(signal);
  assert.deepEqual(tools.map((t) => t.name), ["echo", "boom"]);
  assert.equal(tools[0]!.description, "echo the input back");
});

test("callTool returns the tool's text output", async () => {
  const client = track(await connectMcp({ server: demoServer() }));
  const result = await client.callTool("echo", { text: "hi" }, signal);
  assert.equal(result.text, "echo: hi");
  assert.equal(result.isError, false);
});

test("mcpToolHost namespaces each server's tools and routes calls to them", async () => {
  const client = track(await connectMcp({ server: demoServer() }));
  const host = await mcpToolHost([client]);
  const names = host.definitions().map((d) => d.function.name);
  assert.deepEqual(names.sort(), ["demo__boom", "demo__echo"]);
  const out = await host.execute(
    { id: "1", type: "function", function: { name: "demo__echo", arguments: JSON.stringify({ text: "yo" }) } },
    signal,
  );
  assert.equal(out, "echo: yo");
});

test("a failing MCP tool surfaces as a thrown error, so the harness records a failure", async () => {
  const client = track(await connectMcp({ server: demoServer() }));
  const host = await mcpToolHost([client]);
  await assert.rejects(
    () => host.execute({ id: "1", type: "function", function: { name: "demo__boom", arguments: "{}" } }, signal),
    /kaboom/,
  );
});

test("two servers offering the same tool name do not collide", async () => {
  const a = track(await connectMcp({ server: new McpServer({ name: "alpha" }, [{ name: "read", run: () => "alpha-read" }]) }));
  const b = track(await connectMcp({ server: new McpServer({ name: "beta" }, [{ name: "read", run: () => "beta-read" }]) }));
  const host = await mcpToolHost([a, b]);
  assert.deepEqual(host.definitions().map((d) => d.function.name).sort(), ["alpha__read", "beta__read"]);
  const call = (name: string) => host.execute({ id: "1", type: "function", function: { name, arguments: "{}" } }, signal);
  assert.equal(await call("alpha__read"), "alpha-read");
  assert.equal(await call("beta__read"), "beta-read");
});

// --- stdio transport, against a real spawned server -----------------------

let serverFile: string;
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-mcp-"));
  serverFile = join(dir, "server.mjs");
  writeFileSync(
    serverFile,
    [
      'let buffer = "";',
      "process.stdin.on(\"data\", (chunk) => {",
      "  buffer += chunk;",
      "  let i;",
      "  while ((i = buffer.indexOf(\"\\n\")) !== -1) {",
      "    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
      "    if (line.trim()) handle(JSON.parse(line));",
      "  }",
      "});",
      "const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id, result }) + \"\\n\");",
      "function handle(msg) {",
      "  if (msg.method === \"initialize\") return respond(msg.id, { protocolVersion: \"2025-06-18\", capabilities: { tools: {} }, serverInfo: { name: \"stdio-demo\", version: \"1.0\" } });",
      "  if (msg.method === \"tools/list\") return respond(msg.id, { tools: [{ name: \"add\", description: \"add two numbers\", inputSchema: { type: \"object\", properties: { a: { type: \"number\" }, b: { type: \"number\" } } } }] });",
      "  if (msg.method === \"tools/call\") { const { a, b } = msg.params.arguments; return respond(msg.id, { content: [{ type: \"text\", text: String(a + b) }], isError: false }); }",
      "}",
    ].join("\n"),
    "utf8",
  );
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("a real subprocess over stdio answers initialize, tools/list and tools/call", async () => {
  const client = track(await connectMcp({ command: process.execPath, args: [serverFile] }));
  assert.deepEqual(client.serverInfo, { name: "stdio-demo", version: "1.0" });
  const tools = await client.listTools(signal);
  assert.deepEqual(tools.map((t) => t.name), ["add"]);
  const result = await client.callTool("add", { a: 2, b: 3 }, signal);
  assert.equal(result.text, "5");
});
