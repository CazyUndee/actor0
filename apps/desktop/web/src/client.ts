import type { AgentCalls, AgentCallName, AgentNotification } from "./protocol";

/**
 * The UI's connection to the agent.
 *
 * One WebSocket, two channels: a call is a request with an id and a matching
 * reply, and a notification is a push that arrives whenever the agent has
 * something to say. Nothing polls — a turn streams its events as they happen,
 * which is the only way a token can appear on screen before the answer is done.
 *
 * The connection is *found*, not configured, and it is found in the one place
 * that works in all three environments the UI runs in:
 *
 *   - inside the app, the shell wrote the agent's port beside Neutralino's own
 *     auth file, and the UI reads it with the native filesystem API;
 *   - under `vite dev`, there is no shell, so the dev default is used and the
 *     agent is started by hand with the same port;
 *   - in a test, an explicit URL is passed in.
 *
 * Reconnection is deliberate rather than incidental: the agent survives a UI
 * reload (it is a separate process), so a window refresh must not orphan a turn
 * that is still streaming.
 */

export type ConnectionState = "connecting" | "open" | "closed";

export type AgentClientOptions = {
  /** An explicit URL skips discovery entirely (tests, and a host that knows). */
  url?: string;
  onNotification?: (notification: AgentNotification) => void;
  onState?: (state: ConnectionState) => void;
  /** How long to wait before reconnecting; 0 disables it. */
  reconnectDelayMs?: number;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };


const DEV_DEFAULT_PORT = 3000;

/** Where the shell records the agent's port and token, beside its own auth file. */
export const AGENT_INFO_FILE = ".tmp/agent.json";

/**
 * Find the agent's endpoint.
 *
 * The shell writes `{port, token}` when it starts the agent, and the UI reads
 * it through the native API. A missing file is not an error — it means the UI
 * is not running under the shell (a browser, a test), and the dev default is
 * the honest answer there.
 */
export async function discoverAgentUrl(): Promise<{ url: string; token?: string }> {
  const Neutralino = typeof window !== "undefined" ? window.Neutralino : undefined;
  const base = typeof window !== "undefined" ? window.NL_PATH : undefined;
  if (Neutralino?.filesystem && base) {
    try {
      const raw = await Neutralino.filesystem.readFile(`${base}/${AGENT_INFO_FILE}`);
      const info = JSON.parse(raw) as { port?: number; token?: string };
      if (typeof info.port === "number" && info.port > 0) {
        return { url: `ws://127.0.0.1:${info.port}`, ...(info.token ? { token: info.token } : {}) };
      }
    } catch {
      // No shell record: fall through to the dev default rather than failing.
    }
  }
  const envPort = typeof import.meta !== "undefined" ? import.meta.env?.VITE_AGENT_PORT : undefined;
  const port = envPort ? Number(envPort) : DEV_DEFAULT_PORT;
  return { url: `ws://127.0.0.1:${port}` };
}

export class AgentClient {
  private socket: WebSocket | undefined;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private state: ConnectionState = "closed";
  private closedByCaller = false;
  private readonly options: AgentClientOptions;
  private resolvedUrl: { url: string; token?: string } | undefined;

  constructor(options: AgentClientOptions = {}) {
    this.options = options;
  }

  /** Open the connection, discovering the endpoint when none was given. */
  async connect(): Promise<void> {
    this.resolvedUrl ??= this.options.url
      ? { url: this.options.url }
      : await discoverAgentUrl();
    const url = this.resolvedUrl.token
      ? `${this.resolvedUrl.url}?token=${encodeURIComponent(this.resolvedUrl.token)}`
      : this.resolvedUrl.url;
    this.setState("connecting");
    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        this.setState("closed");
        reject(error as Error);
        return;
      }
      this.socket = socket;
      socket.onopen = () => {
        this.setState("open");
        resolve();
      };
      socket.onerror = () => {
        // A socket error is always followed by a close; that is where the
        // reconnect decision belongs, so this only rejects the first attempt.
        if (this.state === "connecting") reject(new Error(`could not reach the agent at ${url}`));
      };
      socket.onclose = () => {
        this.failPending(new Error("the agent connection closed"));
        this.setState("closed");
        if (!this.closedByCaller) this.scheduleReconnect();
      };
      socket.onmessage = (event) => this.receive(String(event.data));
    });
  }

  private scheduleReconnect(): void {
    const delay = this.options.reconnectDelayMs ?? 1_000;
    if (delay <= 0) return;
    setTimeout(() => {
      if (this.closedByCaller || this.state === "open" || this.state === "connecting") return;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state);
  }

  private failPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private receive(raw: string): void {
    let message: { id?: string; result?: unknown; error?: { message?: string }; event?: AgentNotification };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.event) {
      this.options.onNotification?.(message.event);
      return;
    }
    if (typeof message.id !== "string") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? "the agent refused the call"));
    else entry.resolve(message.result);
  }

  /** Make one call. Rejects when the socket is not open, rather than queueing. */
  call<K extends AgentCallName>(method: K, params?: Parameters<AgentCalls[K]>[0]): Promise<ReturnType<AgentCalls[K]>> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("the agent is not connected"));
    }
    const id = `c${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.closedByCaller = true;
    this.socket?.close();
    this.socket = undefined;
    this.setState("closed");
  }
}
