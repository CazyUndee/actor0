import { resolve } from "node:path";
import { Agent } from "./agent.js";
import { openBridge, readNeutralinoAuth } from "./native/bridge.js";
import { startServer } from "./server.js";
import { setShellOpener } from "./oauth.js";
import WebSocket from "ws";

/**
 * The agent core's entry point.
 *
 * Launched by the Neutralino shell, which supervises and respawns it. It has
 * three jobs and no more: pick a filesystem bridge, build the agent, and serve
 * it. Everything else — the turn loop, the tools, the config — lives behind
 * `Agent`, so this file is short on purpose.
 *
 * Configuration is environment-first, because the shell is the thing that
 * knows where the app lives:
 *
 *   ACTOR0_AGENT_PORT       the port to listen on (default: any free port)
 *   ACTOR0_AGENT_TOKEN      the shared secret a client must present
 *   ACTOR0_AGENT_PORT_FILE  where to write `{port}` once listening
 *   ACTOR0_AGENT_CWD        the working directory the tools are confined to
 *   NL_PATH                 the shell's app directory (locates the native API)
 *   NL_TOKEN            the shell's access token, for the native API
 */

const VERSION = "0.5.8";

async function main(): Promise<void> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const cwd = resolve(process.env.ACTOR0_AGENT_CWD?.trim() || process.cwd());
  const bridge = await openBridge(log);

  // OAuth sign-in opens the browser through the shell's `os.open`, which is the
  // only native opener a headless Node process has. The bridge already knows how
  // to reach the shell (its auth file, its WebSocket), so the opener is wired
  // from the same connection: without this, openBrowserInShell fell back to
  // `globalThis.Neutralino` (absent in a plain Node process) and every desktop
  // sign-in returned opened:false with a URL for the user to paste by hand.
  const shellOs = openShellOs();
  setShellOpener(shellOs);

  const agent = new Agent({ cwd, bridge, version: VERSION });

  // Env-first, argv as the fallback: the packaged desktop app spawns this
  // process through Neutralino's `os.spawnProcess`, which silently fails
  // (pid 0, no process) whenever `envs` is passed — measured, not assumed.
  // So the shell passes --token/--port-file as plain arguments, and both
  // routes end at the same values.
  const args = new Map(process.argv.slice(2).map((a, i, all) => [a, all[i + 1]]));
  const argValue = (flag: string): string | undefined => {
    const indexed = args.get(flag)?.replace(/^"|"$/g, "");
    return indexed && indexed.trim() ? indexed.trim() : undefined;
  };
  const port = Number(process.env.ACTOR0_AGENT_PORT ?? "0") || 0;
  const token = process.env.ACTOR0_AGENT_TOKEN?.trim() || argValue("--token");
  const portFile = process.env.ACTOR0_AGENT_PORT_FILE?.trim() || argValue("--port-file");
  const server = await startServer({
    agent,
    port,
    ...(token ? { token } : {}),
    ...(portFile ? { portFile } : {}),
    onLog: log,
  });

  log(`[agent] actor0 ${VERSION} ready — cwd=${cwd} bridge=${bridge.kind} shell=${(await agent["agent.hello"]()).shell}`);

  const shutdown = async (): Promise<void> => {
    agent.dispose();
    await server.close();
    await bridge.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  process.stderr.write(`[agent] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

/**
 * The shell's `os` namespace, as a MinimalNeutralinoClient-shaped object.
 *
 * The opener needs exactly one method (`os.open`), and the bridge already
 * proves the shell is reachable before this runs. A shell that cannot be
 * reached (no Neutralino auth file, no socket) leaves the opener undefined,
 * which `openBrowserInShell` turns into "show the URL by hand" rather than a
 * silent failure.
 */
function openShellOs(): { open: (url: string) => Promise<void> } | undefined {
  const auth = readNeutralinoAuth();
  if (!auth) return undefined;
  const client = new WebSocket(
    `ws://127.0.0.1:${auth.port}?connectToken=${encodeURIComponent(String(auth.accessToken).split(".")[0] ?? "")}`,
  );
  // One round trip proves the socket before sign-in relies on it; if it does
  // not answer, the opener stays undefined and the caller falls back to the URL.
  return {
    async open(url: string): Promise<void> {
      const reply = await new Promise<{ success: boolean } | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 5_000);
        client.once("message", (raw) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(String(raw)));
          } catch {
            resolve(undefined);
          }
        });
        client.once("error", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        client.send(JSON.stringify({ id: "open", method: "os.open", data: { url }, accessToken: auth.accessToken }));
      });
      if (!reply?.success) throw new Error("the shell refused to open the browser");
    },
  };
}
