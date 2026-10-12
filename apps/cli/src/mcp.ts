import { spawn, type ChildProcess } from "node:child_process";
import type { ToolCall, ToolDefinition, ToolHost } from "@actor0/harness";
import { compositeToolHost, namespacedToolHost } from "@actor0/harness";

/**
 * A Model Context Protocol client.
 *
 * MCP is JSON-RPC 2.0 over a transport — stdio (a spawned subprocess, one JSON
 * object per line) or, here, in-process (an `McpServer` wired straight to a
 * client, for tests and for exposing the CLI's own tools without a subprocess).
 * The handshake is `initialize` then `notifications/initialized`; after that a
 * client lists tools with `tools/list` and runs them with `tools/call`.
 *
 * Only the *tools* capability is implemented. Sampling, roots, prompts and
 * resources are part of the protocol but nothing in this CLI consumes them, and
 * a client that claims a capability it does not implement is worse than one
 * that claims none — the server would try to use it and get silence back.
 *
 * The three exports mirror the shape the rest of the CLI expects:
 * `McpServer` defines an in-process server, `connectMcp` opens a connection to
 * one (stdio or in-process) and returns a live `McpClient`, and `mcpToolHost`
 * turns one or more clients into a `ToolHost` the harness can drive, with each
 * server's tools namespaced so they cannot collide with each other or with the
 * CLI's own.
 */

/** The MCP protocol revision this client speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// --- JSON-RPC 2.0 ---------------------------------------------------------

export type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: JsonRpcError };
export type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
/** Any single JSON-RPC message, in either direction. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

const isResponse = (message: JsonRpcMessage): message is JsonRpcResponse =>
  "id" in message && ("result" in message || "error" in message);

// --- MCP types ------------------------------------------------------------

/** A tool as an MCP server advertises it. */
export type McpTool = {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema?: Record<string, unknown>;
};

/** One block of a tool result's content. */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string } };

export type McpServerInfo = { name: string; version?: string };

/** A tool result, flattened to text for the harness. */
export type McpToolResult = { text: string; isError: boolean };

// --- transport ------------------------------------------------------------

/** A bidirectional JSON-RPC channel to a server. */
export type McpTransport = {
  send(message: JsonRpcMessage): void;
  /** Subscribe to inbound messages; returns an unsubscribe. */
  onMessage(handler: (message: JsonRpcMessage) => void): () => void;
  close(): void | Promise<void>;
};

/**
 * A two-ended pipe. Each end can send to the other and subscribe to what the
 * other sends; used to wire a client to an in-process `McpServer` with no
 * subprocess and no serialization.
 */
function createPipe(): { a: McpTransport; b: McpTransport } {
  const aHandlers = new Set<(m: JsonRpcMessage) => void>();
  const bHandlers = new Set<(m: JsonRpcMessage) => void>();
  const end = (
    send: (m: JsonRpcMessage) => void,
    own: Set<(m: JsonRpcMessage) => void>,
  ): McpTransport => ({
    send: (m) => send(m),
    onMessage: (handler) => {
      own.add(handler);
      return () => own.delete(handler);
    },
    close: () => {
      own.clear();
    },
  });
  return {
    a: end((m) => { for (const h of bHandlers) h(m); }, aHandlers),
    b: end((m) => { for (const h of aHandlers) h(m); }, bHandlers),
  };
}

/**
 * Spawn a subprocess and speak newline-delimited JSON-RPC over its stdio.
 *
 * The dominant MCP transport: `npx some-mcp-server` and friends. Framing is one
 * JSON object per line — MCP delimits messages by newline over stdio, not by
 * Content-Length. A partial line is buffered until its newline arrives, and a
 * line that is not valid JSON is dropped rather than thrown: a server that
 * logs to stdout would otherwise kill the connection.
 */
export function stdioTransport(
  command: string,
  args: string[] = [],
  options: { env?: Record<string, string>; cwd?: string } = {},
): McpTransport {
  const child: ChildProcess = spawn(command, args, {
    env: { ...process.env, ...options.env },
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const handlers = new Set<(m: JsonRpcMessage) => void>();
  let buffer = "";
  const emit = (line: string): void => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      for (const handler of handlers) handler(message);
    } catch {
      // Not ours (a stray log line on stdout); drop it rather than crash.
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      emit(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  return {
    send: (message) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close: () => {
      handlers.clear();
      if (!child.killed) child.kill();
    },
  };
}

// --- server ---------------------------------------------------------------

/** A tool an `McpServer` exposes. */
export type McpServerTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  run: (args: Record<string, unknown>) => string | Promise<string>;
};

/**
 * An in-process MCP server: a named set of tools that answers the protocol.
 *
 * It handles `initialize`, `ping`, `tools/list` and `tools/call`, and ignores
 * notifications (which carry no id and expect no response). Connect to it with
 * `connectMcp({ server })` — no subprocess, no serialization — which is how the
 * client is tested and how the CLI could expose its own tools to another MCP
 * client.
 */
export class McpServer {
  constructor(
    private readonly info: McpServerInfo,
    private readonly tools: McpServerTool[] = [],
  ) {}

  /** Handle one inbound message; return a response for a request, nothing for a notification. */
  async handle(message: JsonRpcMessage): Promise<JsonRpcResponse | undefined> {
    if (!("id" in message) || !("method" in message)) return undefined;
    const request = message as JsonRpcRequest;
    try {
      return { jsonrpc: "2.0", id: request.id, result: await this.dispatch(request) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: this.info,
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: this.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          })),
        };
      case "tools/call": {
        const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const name = params.name ?? "";
        const tool = this.tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`unknown tool: ${name}`);
        const text = await tool.run(params.arguments ?? {});
        return { content: [{ type: "text", text }], isError: false };
      }
      default:
        throw new Error(`method not found: ${request.method}`);
    }
  }
}

/** Attach a server to one end of a pipe, answering whatever arrives on it. */
function serveOn(pipe: McpTransport, server: McpServer): void {
  pipe.onMessage((message) => {
    void server.handle(message).then((response) => {
      if (response) pipe.send(response);
    });
  });
}

// --- client ---------------------------------------------------------------

export type McpClientOptions = {
  transport: McpTransport;
  clientInfo?: McpServerInfo;
  requestTimeoutMs?: number;
};

/**
 * A live connection to one MCP server.
 *
 * Requests are correlated by id: each carries a fresh id, and the matching
 * response resolves the promise that is waiting on it. A request has a timeout
 * and honours an `AbortSignal`, so a server that never answers cannot hang a
 * turn — the same discipline the harness applies to the model stream.
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (response: JsonRpcResponse) => void; reject: (error: Error) => void }
  >();
  private unsubscribe: () => void;
  private info: McpServerInfo | undefined;

  constructor(private readonly options: McpClientOptions) {
    this.unsubscribe = options.transport.onMessage((message) => this.receive(message));
  }

  /** The server's own name and version, once `initialize` has run. */
  get serverInfo(): McpServerInfo | undefined {
    return this.info;
  }

  private receive(message: JsonRpcMessage): void {
    if (!isResponse(message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message);
  }

  private request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error(`MCP "${method}" timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );
      this.pending.set(id, {
        resolve: (response) => settle(() => resolve(response.result)),
        reject: (error) => settle(() => reject(error)),
      });
      if (signal) {
        const onAbort = () => settle(() => reject(new Error("cancelled")));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      this.options.transport.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    });
  }

  /** The handshake. Safe to call once; a second call is a no-op that returns the cached info. */
  async initialize(signal?: AbortSignal): Promise<McpServerInfo | undefined> {
    if (this.info) return this.info;
    const result = (await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.options.clientInfo ?? { name: "actor0", version: "0.1.0" },
      },
      signal,
    )) as { serverInfo?: McpServerInfo };
    this.info = result.serverInfo;
    this.options.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return this.info;
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {}, signal)) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, signal)) as {
      content?: McpContent[];
      isError?: boolean;
    };
    return { text: joinTextContent(result.content ?? []), isError: result.isError ?? false };
  }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const pending of this.pending.values()) pending.reject(new Error("connection closed"));
    this.pending.clear();
    await this.options.transport.close();
  }
}

// --- connect + host -------------------------------------------------------

export type ConnectOptions = {
  clientInfo?: McpServerInfo;
  requestTimeoutMs?: number;
} & (
  | { transport: McpTransport }
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { server: McpServer }
);

/**
 * Open a connection to an MCP server and complete the handshake.
 *
 * Three ways in: an existing `transport`, a `command` to spawn over stdio, or
 * an in-process `server`. All three return the same live `McpClient`; the
 * difference is only where the bytes go.
 */
export async function connectMcp(options: ConnectOptions): Promise<McpClient> {
  let transport: McpTransport;
  if ("transport" in options) {
    transport = options.transport;
  } else if ("command" in options) {
    transport = stdioTransport(options.command, options.args ?? [], {
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } else {
    const { a, b } = createPipe();
    serveOn(b, options.server);
    transport = a;
  }
  const client = new McpClient({
    transport,
    ...(options.clientInfo ? { clientInfo: options.clientInfo } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  await client.initialize();
  return client;
}

/**
 * Turn connected clients into one `ToolHost` the harness can drive.
 *
 * Every server's tools are namespaced with the server's own name (`server__tool`),
 * so two servers that both offer `read` — or a server that offers a tool the CLI
 * already has — do not collide, and a tool result always says which server it
 * came from. The clients' tool lists are fetched once, here, because
 * `ToolHost.definitions()` is synchronous and the list is not.
 *
 * A tool result flagged `isError` is thrown rather than returned, so the harness
 * records it as a failed call the model can read and react to — the same shape a
 * failing CLI tool produces.
 */
export async function mcpToolHost(clients: McpClient[]): Promise<ToolHost> {
  const namespaced = await Promise.all(
    clients.map(async (client) => {
      const tools = await client.listTools();
      const definitions: ToolDefinition[] = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      }));
      const prefix = `${client.serverInfo?.name ?? "mcp"}__`;
      const host: ToolHost = {
        definitions: () => definitions,
        async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
          const result = await client.callTool(call.function.name, parseArgs(call.function.arguments), signal);
          if (result.isError) throw new Error(result.text);
          return result.text;
        },
      };
      return namespacedToolHost(prefix, host);
    }),
  );
  return compositeToolHost(namespaced);
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function joinTextContent(content: McpContent[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "resource":
          return `[resource: ${block.resource?.uri ?? "?"}]`;
        case "image":
          return `[image: ${block.mimeType}]`;
        default:
          // A content type this build does not model; say what it was rather
          // than dropping it silently.
          return `[${(block as { type: string }).type}]`;
      }
    })
    .join("\n");
}
