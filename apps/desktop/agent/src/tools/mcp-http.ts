/**
 * A minimal MCP client over Streamable HTTP.
 *
 * Web search and page fetch run on Parallel's hosted MCP server, and MCP is
 * JSON-RPC 2.0 over a transport. The transport here is the "Streamable HTTP"
 * one: each request is its own POST, and the server answers with either a JSON
 * body or a `text/event-stream` whose frames carry the same JSON-RPC messages.
 * A session id issued on `initialize` is echoed on every later request, which is
 * what keeps one conversation on one server-side session.
 *
 * It is deliberately small. Only the *tools* capability is implemented, because
 * that is the only capability this app consumes, and a client that claims a
 * capability it does not implement is worse than one that claims none — the
 * server would try to use it and get silence back. Writing it here rather than
 * reaching for a library keeps the app's dependency surface to what it actually
 * needs, and keeps the wire format visible where it is used.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type McpToolResult = { text: string; isError: boolean };

type JsonRpcError = { code: number; message: string; data?: unknown };

export class McpHttpClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly options: { headers?: Record<string, string>; requestTimeoutMs?: number } = {},
  ) {}

  private baseHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...this.options.headers,
    };
  }

  /** One request, returning the JSON-RPC result or throwing the server's error. */
  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new Error("mcp request timeout")), timeoutMs);
    const upstream = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: upstream,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;

      if (!response.ok) {
        throw new Error(`MCP server answered ${response.status} ${response.statusText}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();

      if (contentType.includes("text/event-stream")) {
        return this.parseStream(body, id);
      }
      const parsed = JSON.parse(body) as { result?: unknown; error?: JsonRpcError };
      if (parsed.error) throw new Error(parsed.error.message || "MCP request failed");
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The JSON-RPC message with this id, out of an SSE body's `data:` frames. */
  private parseStream(body: string, id: number): unknown {
    for (const frame of body.split(/\n\n/)) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data.trim()) continue;
      let message: { id?: number; result?: unknown; error?: JsonRpcError };
      try {
        message = JSON.parse(data);
      } catch {
        continue;
      }
      if (message.id !== id) continue;
      if (message.error) throw new Error(message.error.message || "MCP request failed");
      return message.result;
    }
    throw new Error("MCP server closed the stream without answering");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: "actor0-desktop", version: "0.5.7" },
    });
    this.initialized = true;
    // A notification has no id and no response; it is fire-and-forget by design.
    await fetch(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => undefined);
  }

  /** Call a tool and flatten its content blocks to text. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.initialize();
    const result = (await this.request("tools/call", { name, arguments: args }, signal)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!)
      .join("\n");
    return { text, isError: Boolean(result?.isError) };
  }
}
