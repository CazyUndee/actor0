/**
 * Serve this checkout's Actor0 tools to an external MCP client — ChatGPT's
 * developer mode, Codex, or a raw JSON-RPC test harness.
 *
 * Run:
 *
 *   npx tsx apps/cli/scripts/mcp-serve.ts [--tools read,rg] [--cwd <dir>]
 *
 * The server speaks newline-delimited JSON-RPC on stdin/stdout (the MCP stdio
 * transport). Logs and the startup notice go to stderr only — stdout is the
 * wire and a stray line there kills the connection.
 *
 * Point a connector at `npx tsx apps/cli/scripts/mcp-serve.ts` and the offered
 * tools are the CLI's own, executing against this checkout's cwd. Omit
 * `--tools` to offer the full set; pass a subset for a safer first
 * connection. `task` and `skill` are listed but report themselves
 * unavailable when served without their delegates — a tool that says so is
 * honest, a tool that cannot run is not offered at all, so the default set
 * excludes neither; restrict explicitly with `--tools` if that matters.
 */
import { resolve } from "node:path";
import { createToolHost } from "../src/tools.js";
import { hostMcpServer, restrictedToolHost, serveStdio } from "../src/mcp-serve.js";

function fail(message: string): never {
  process.stderr.write(`mcp-serve: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
if (args.includes("--help") || args.includes("-h")) {
  process.stderr.write("usage: mcp-serve [--tools a,b,c] [--cwd <dir>] [--name <n>] [--version <v>]\n");
  process.exit(0);
}

const toolsFlag = flag("tools");
const cwd = resolve(flag("cwd") ?? process.cwd());
const names = toolsFlag ? toolsFlag.split(",").map((name) => name.trim()).filter(Boolean) : undefined;

const host = names
  ? restrictedToolHost(createToolHost({ cwd }), names)
  : createToolHost({ cwd });
const offered = host.definitions().map((definition) => definition.function.name);
if (names && offered.length === 0) fail(`none of --tools ${toolsFlag} are real tools here; the server would serve an empty list`);

process.stderr.write(`[actor0-mcp] serving ${offered.length} tools over stdio (cwd ${cwd}, name ${flag("name") ?? "actor0"}): ${offered.join(", ")}\n`);

void (async () => {
  await serveStdio(hostMcpServer(host, { name: flag("name") ?? "actor0", version: flag("version") ?? process.env.npm_package_version ?? "0.1.1" }));
  process.stderr.write("[actor0-mcp] input closed; exiting\n");
})().catch((error) => {
  fail((error as Error).message);
});
