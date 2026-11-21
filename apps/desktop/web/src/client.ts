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

type LauncherEndpoint = { port: number; token?: string };

/** Keep the port and its credential together across the boot → client handoff. */
let discovered: LauncherEndpoint | undefined;

export function setDiscoveredEndpoint(endpoint: LauncherEndpoint): void {
  discovered = endpoint;
}

function parseLauncherEndpoint(info: unknown): LauncherEndpoint | null {
  if (!info || typeof info !== "object" || !("port" in info)) return null;
  const { port } = info;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const token = "token" in info && typeof info.token === "string" ? info.token : undefined;
  return { port, ...(token ? { token } : {}) };
}

/** Dev serves its port record next to the page; packaged builds keep it beside the executable. */
export async function readLauncherEndpoint(): Promise<LauncherEndpoint | null> {
  try {
    const res = await fetch("/agent-port.json", { cache: "no-store" });
    if (res.ok) {
      const endpoint = parseLauncherEndpoint(await res.json());
      if (endpoint) return endpoint;
    }
  } catch {
    /* no served record */
  }
  if (typeof window !== "undefined" && window.NL_PATH && window.Neutralino?.filesystem) {
    try {
      const raw = await window.Neutralino.filesystem.readFile(`${window.NL_PATH}/agent/port.json`);
      return parseLauncherEndpoint(JSON.parse(raw));
    } catch {
      /* no packaged record */
    }
  }
  return null;
}

/**
 * Find the agent's endpoint.
 *
 * Sources, in the order they become known and reliable: an endpoint handed to
 * us in-process (freshest), the port file the shell wrote via the native API,
 * the port file a launcher dropped next to the served app (fetchable over HTTP,
 * which is the path that works in chrome mode without a working Neutralino
 * bridge), and finally the dev default — the honest answer only when the agent
 * really is expected on 3000.
 */
export async function discoverAgentUrl(): Promise<{ url: string; token?: string }> {
  if (discovered) {
    return { url: `ws://127.0.0.1:${discovered.port}`, ...(discovered.token ? { token: discovered.token } : {}) };
  }

  const Neutralino = typeof window !== "undefined" ? window.Neutralino : undefined;
  const base = typeof window !== "undefined" ? window.NL_PATH : undefined;
  if (Neutralino?.filesystem && base) {
    try {
      const raw = await Neutralino.filesystem.readFile(`${base}/${AGENT_INFO_FILE}`);
      const info = JSON.parse(raw) as { port?: number; token?: string };
      if (typeof info.port === "number" && info.port > 0) {
        const token = info.token || (typeof sessionStorage !== "undefined" ? sessionStorage.getItem("actor0.agentToken") ?? undefined : undefined);
        return { url: `ws://127.0.0.1:${info.port}`, ...(token ? { token } : {}) };
      }
    } catch {
      // No shell record: try the other sources.
    }
  }

  const launched = await readLauncherEndpoint();
  if (launched) {
    return { url: `ws://127.0.0.1:${launched.port}`, ...(launched.token ? { token: launched.token } : {}) };
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
    // Discovery runs on every *retry*, not only the first attempt: a desktop
    // relaunch can find a port file left by the previous agent (which died
    // with the previous window), so the endpoint the first attempt picked can
    // simply be dead. Re-discovering lets a later attempt pick up the agent
    // that the new launch spawned — pinning the first URL forever is what
    // kept the UI retrying a stale port while a live agent sat elsewhere.
    this.resolvedUrl = this.options.url
      ? { url: this.options.url }
      : await discoverAgentUrl();
    const url = this.resolvedUrl.token
      ? `${this.resolvedUrl.url}?token=${encodeURIComponent(this.resolvedUrl.token)}`
      : this.resolvedUrl.url;
    // Report only host and port: query parameters may contain the launch credential.
    let address = "the local WebSocket endpoint";
    try {
      address = new URL(url).host;
    } catch {
      /* even a malformed URL should not escape through the error message */
    }
    const failure = () => new Error(`could not reach the agent at ${address}`);
    this.setState("connecting");
    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        this.setState("closed");
        reject(failure());
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
        if (this.state === "connecting") reject(failure());
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
