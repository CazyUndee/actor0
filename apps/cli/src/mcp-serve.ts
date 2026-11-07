import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ToolCall, ToolHost, ToolResult } from "@actor0/harness";
import { McpServer, type McpServerInfo, type McpServerTool } from "./mcp.js";

/**
 * Expose an Actor0 `ToolHost` to an external MCP client — ChatGPT's developer
 * mode, Codex, or anything else that speaks MCP.
 *
 * This is the serving direction: `mcp.ts` is the consuming one (it turns other
 * servers' tools into a host the harness can drive). The protocol work already
 * lives in `McpServer` (`tools/list`, `tools/call`); what is added here is only
 * the mapping from `ToolHost` onto it, and a stdio loop that puts the server
 * where an external connector can reach it.
 *
 * Two deliberate properties:
 *
 * - The `tools/call` path routes through `ToolHost.execute`, so the host's own
 *   argument validation (a `shell` that refuses to parse, a `read` confined to
 *   its cwd) is exactly what the external runtime gets. Re-validating the
 *   arguments here would be a second gate that could disagree with the first,
 *   and the error messages that reach the model would name the wrong layer.
 * - No timeout is imposed on a tool run: the CLI's policy is that a shell
 *   command has no default ceiling, and a server-side timer would kill real
 *   installs from a direction the client cannot see. The connector's own
 *   request timeout is the only one that exists.
 */

/**
 * The host's tools as an `McpServer` advertises them.
 *
 * `parameters` and `inputSchema` are both JSON Schema, so the mapping is direct.
 * The round trip is `arguments` object → `JSON.stringify` → `execute` →
 * `JSON.parse` inside the host, which is lossless for a JSON object.
 */
export function mcpToolsFromHost(host: ToolHost): McpServerTool[] {
  return host.definitions().map((definition) => {
    const tool = definition.function;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      run: async (args: Record<string, unknown>): Promise<string> => {
        const result = await host.execute(
          {
            id: "mcp",
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(args) },
          },
          new AbortController().signal,
        );
        return result.text ?? String(result.data);
      },
    };
  });
}

/** A host's tools behind an `McpServer` ready to serve. */
export function hostMcpServer(host: ToolHost, info: McpServerInfo): McpServer {
  return new McpServer(info, mcpToolsFromHost(host));
}

/**
 * Offer a subset of a host's tools without leaking the rest.
 *
 * A restricted server that forwarded excluded calls to the full host would
 * answer "unknown tool X. Available: read, write, shell, …" — a listing of
 * capabilities the connection was never offered. The refusal names only what
 * is offered, which is what the model can act on.
 */
export function restrictedToolHost(host: ToolHost, names: string[]): ToolHost {
  const offered = new Set(names);
  return {
    definitions: () => host.definitions().filter((definition) => offered.has(definition.function.name)),
    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult<unknown>> {
      if (!offered.has(call.function.name)) {
        const available = host.definitions().filter((definition) => offered.has(definition.function.name));
        throw new Error(
          `unknown tool "${call.function.name}". Available: ${available.map((tool) => tool.function.name).join(", ")}`,
        );
      }
      return host.execute(call, signal);
    },
  };
}

export type ServeStdioOptions = {
  /** The stream newline-delimited requests arrive on. `process.stdin` by default. */
  input?: Readable;
  /** The stream responses are written to, one JSON-RPC message per line. `process.stdout` by default. */
  output?: Writable;
};

/**
 * Answer an external MCP client over newline-delimited stdio.
 *
 * A non-JSON line is dropped rather than throwing: a client that sends
 * anything other than JSON-RPC is not the protocol, and the connection must
 * stay up for the next well-formed request — the same rule `stdioTransport`
 * in `mcp.ts` applies to the other direction of this same conversation.
 *
 * The caller must keep whatever it logs on stderr; stdout is the wire.
 * Resolves when the input stream ends.
 */
export function serveStdio(server: McpServer, options: ServeStdioOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const readline = createInterface({ input });
  return new Promise((resolve) => {
    readline.on("line", (line) => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      void server.handle(message as Parameters<McpServer["handle"]>[0]).then((response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      });
    });
    readline.on("close", () => resolve());
  });
}
