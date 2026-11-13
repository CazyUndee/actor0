import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat as statPath, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import WebSocket from "ws";

/**
 * The file bridge: the one seam between the agent's tools and the machine.
 *
 * The agent is a Node process, so it *could* touch the filesystem directly
 * everywhere — and a bridge over `node:fs` does, for tests and for headless
 * runs. But when the app is packaged, the Neutralino shell is the process that
 * owns the OS integration, and it exposes `filesystem.*` as a real native API
 * over its own local WebSocket. Routing content access through it means:
 *
 *   - the app declares its filesystem scopes once, in the shell config, and the
 *     shell enforces them — the agent cannot reach outside them by accident;
 *   - file *watchers* live with the process that can act on them, so the UI can
 *     show a change the moment it lands;
 *   - a path the shell cannot express is refused by the shell, not by a policy
 *     check the agent could get wrong.
 *
 * Both backends answer the same small interface, so the tools never branch on
 * which one is live. One thing deliberately does *not* go through the bridge:
 * path containment. That is a question about symlinks, and answering it needs
 * `realpath` — a path-resolution detail the host resolves locally against the
 * paths it is about to hand the bridge. See `tools/within.ts`.
 */

export type FileStat = {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  /** Epoch ms of the last modification, when the backend reports it. */
  modifiedAt?: number;
};

export type DirEntry = { name: string; isDirectory: boolean };

/** A byte window to read, so a 400MB file costs one small read. */
export type ReadOptions = { pos?: number; size?: number };

export interface FileBridge {
  /** Which backend is live, for diagnostics and for the UI's status line. */
  readonly kind: "neutralino" | "node";
  readFile(path: string, options?: ReadOptions): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  readDirectory(path: string, options?: { recursive?: boolean }): Promise<DirEntry[]>;
  getStats(path: string): Promise<FileStat>;
  /** An absolute path for `path`; works for paths that do not exist yet. */
  absolutePath(path: string): Promise<string>;
  close(): Promise<void>;
}

/** The bridge used in tests, in `npm run dev`, and as the fallback. */
export function nodeBridge(): FileBridge {
  return {
    kind: "node",
    async readFile(path, options = {}) {
      const pos = options.pos ?? 0;
      const size = options.size;
      if (size === undefined && pos === 0) return readFile(path, "utf8");
      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = createReadStream(path, size === undefined ? { start: pos } : { start: pos, end: pos + size - 1 });
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.on("error", reject);
      });
    },
    async writeFile(path, data) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, "utf8");
    },
    async createDirectory(path) {
      await mkdir(path, { recursive: true });
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
    async readDirectory(path) {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    },
    async getStats(path) {
      const info = await statPath(path);
      return { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory(), modifiedAt: info.mtimeMs };
    },
    async absolutePath(path) {
      // `resolve` alone is right here: this method answers "where would this
      // path point", not "what is really there", and the caller does the
      // symlink resolution that matters for containment separately.
      const { resolve } = await import("node:path");
      return resolve(path);
    },
    async close() {
      /* nothing to release */
    },
  };
}

/** Where Neutralino writes the WS port and access token for external clients. */
export function neutralinoAuthFile(): string | undefined {
  const nlPath = process.env.NL_PATH?.trim();
  if (!nlPath) return undefined;
  return join(nlPath, ".tmp", "auth_info.json");
}

type AuthInfo = { port: number | string; accessToken: string };

/** Read the auth file the shell exports, if one exists. */
export function readNeutralinoAuth(): AuthInfo | undefined {
  const envPort = process.env.NL_WS_PORT?.trim() || process.env.NL_PORT?.trim();
  const envToken = process.env.NL_TOKEN?.trim();
  if (envPort && envToken) return { port: envPort, accessToken: envToken };
  const file = neutralinoAuthFile();
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AuthInfo>;
    if (parsed.port === undefined || !parsed.accessToken) return undefined;
    return { port: parsed.port, accessToken: parsed.accessToken };
  } catch {
    return undefined;
  }
}

/**
 * A Neutralino native-API client.
 *
 * Speaks the framework's own IPC: a local WebSocket whose handshake carries a
 * connect token derived from the access token, and whose frames are
 * `{ id, method, data, accessToken }` requests answered by
 * `{ id, data: { success, returnValue } }`. Requests are matched by a uuid and
 * resolved out of order; an error frame rejects with the framework's own error
 * object, so a failure surfaces as the shell described it rather than as a
 * generic timeout.
 */
class NeutralinoClient {
  private socket: WebSocket | undefined;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private ready: Promise<void> | undefined;

  constructor(private readonly auth: AuthInfo) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const connectToken = this.auth.accessToken.includes(".")
        ? this.auth.accessToken.split(".")[1]!
        : this.auth.accessToken;
      const socket = new WebSocket(`ws://127.0.0.1:${this.auth.port}?connectToken=${connectToken}`);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error("neutralino connect timeout")), 5_000);
      socket.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("close", () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("neutralino socket closed"));
        }
        this.pending.clear();
      });
      socket.on("message", (raw) => {
        let message: { id?: string; data?: { success?: boolean; returnValue?: unknown; error?: unknown } };
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!message.id) return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.data?.error) entry.reject(Object.assign(new Error("neutralino call failed"), { cause: message.data.error }));
        else entry.resolve(message.data?.returnValue ?? message.data);
      });
    });
    return this.ready;
  }

  async call<T>(method: string, data?: unknown): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("neutralino socket is not open");
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, data, accessToken: this.auth.accessToken }));
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}

/** A `FileBridge` that performs its work in the Neutralino shell. */
export function neutralinoBridge(client: NeutralinoClient): FileBridge {
  return {
    kind: "neutralino",
    readFile: (path, options = {}) => client.call<string>("filesystem.readFile", { path, ...options }),
    writeFile: (path, data) => client.call<void>("filesystem.writeFile", { path, data }),
    async createDirectory(path) {
      await client.call("filesystem.createDirectory", { path });
    },
    async remove(path) {
      await client.call("filesystem.remove", { path });
    },
    async readDirectory(path, options = {}) {
      const entries = await client.call<{ entry: string; type: string }[]>("filesystem.readDirectory", { path, ...options });
      return entries.map((entry) => ({ name: entry.entry, isDirectory: entry.type === "DIRECTORY" }));
    },
    async getStats(path) {
      const stats = await client.call<{ size: number; isFile: boolean; isDirectory: boolean; modifiedAt?: number }>(
        "filesystem.getStats",
        { path },
      );
      return { size: stats.size, isFile: stats.isFile, isDirectory: stats.isDirectory, ...(stats.modifiedAt !== undefined ? { modifiedAt: stats.modifiedAt } : {}) };
    },
    absolutePath: (path) => client.call<string>("filesystem.getAbsolutePath", { path }),
    async close() {
      client.close();
    },
  };
}

/**
 * The bridge to use: the shell's, when the shell is there to be talked to.
 *
 * The choice is made once, at startup, and a failure to reach the shell is not
 * fatal — it falls back to `node:fs` and says so. That matters because the same
 * agent binary runs in three places: inside the packaged app (shell available),
 * under `npm run dev` (no shell), and under `node --test` (no shell), and a
 * harness that refused to start without a GUI would be untestable.
 */
export async function openBridge(log: (line: string) => void = () => {}): Promise<FileBridge> {
  const auth = readNeutralinoAuth();
  if (!auth) return nodeBridge();
  const client = new NeutralinoClient(auth);
  try {
    // One cheap round trip proves the socket works before the tools rely on it.
    await client.call("app.getConfig");
    log(`[bridge] using the Neutralino native filesystem API (port ${auth.port})`);
    return neutralinoBridge(client);
  } catch (error) {
    client.close();
    log(`[bridge] native API unavailable (${(error as Error).message}); falling back to node:fs`);
    return nodeBridge();
  }
}
