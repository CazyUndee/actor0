import { resolve } from "node:path";
import { Agent } from "./agent.js";
import { openBridge, readNeutralinoAuth } from "./native/bridge.js";
import { openShellOs } from "./native/shell-os.js";
import { startServer } from "./server.js";
import { setShellOpener } from "./oauth.js";

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
 *   ACTOR0_AGENT_BUILD      the build number this package was cut at
 *   NL_PATH                 the shell's app directory (locates the native API)
 *   NL_TOKEN            the shell's access token, for the native API
 */

const VERSION = "0.5.7";

/**
 * Which build of the app this is — the number `scripts/build-number.sh` derives
 * from the commits since the last version tag.
 *
 * It rides to the page (and into the title bar) through `agent.hello` rather
 * than being baked into the bundle, because the UI is rebuilt more often than
 * it is packaged and a number written into the bundle rots the moment a commit
 * lands. The launcher passes it: it is the process that knows which checkout
 * this build came out of.
 */
const BUILD = (() => {
  const env = Number.parseInt(process.env.ACTOR0_AGENT_BUILD?.trim() ?? "", 10);
  return Number.isFinite(env) ? env : argValueBuild();
})();

function argValueBuild(): number | undefined {
  const flag = process.argv.indexOf("--build");
  if (flag === -1) return undefined;
  const raw = Number.parseInt(process.argv[flag + 1] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

async function main(): Promise<void> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const cwd = resolve(process.env.ACTOR0_AGENT_CWD?.trim() || process.cwd());

  // Env-first, argv as the fallback, parsed ONCE before anything that reads
  // then: the bridge and the OAuth opener both consume NL_* value
  // coordinates, and openBridge() used to run before applyShellCoordinates —
  // so the bridge decision never saw the values the page passed and always
  // fell back to node:fs (the one engagement earlier in the loop came from a
  // stale auth file the retry could still read). argv/env parse, then
  // coordinates install, THEN the bridge.
  const args = new Map(process.argv.slice(2).map((a, i, all) => [a, all[i + 1]]));
  const argValue = (flag: string): string | undefined => {
    const indexed = args.get(flag)?.replace(/^"|"$/g, "");
    return indexed && indexed.trim() ? indexed.trim() : undefined;
  };
  applyShellCoordinates({
    nlPath: process.env.NL_PATH?.trim() || argValue("--nl-path"),
    nlPort: process.env.NL_PORT?.trim() || argValue("--nl-port"),
    nlToken: process.env.NL_TOKEN?.trim() || argValue("--nl-token"),
  });

  const authBeforeBridge = readNeutralinoAuth();
  const bridge = await openBridge(log);
  const bridgeFellBack = bridge.kind === "node" && !!authBeforeBridge;
  // only native opener a headless Node process has. The bridge already knows how
  // to reach the shell (its auth file, its WebSocket), so the opener is wired
  // from the same connection: without this, openBrowserInShell fell back to
  // `globalThis.Neutralino` (absent in a plain Node process) and every desktop
  // sign-in returned opened:false with a URL for the user to paste by hand.
  const shellOs = openShellOs();
  setShellOpener(shellOs);

  const agent = new Agent({ cwd, bridge, version: VERSION, build: BUILD });

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

  if (bridgeFellBack) {
    (agent as unknown as { notify?: (n: unknown) => void }).notify?.({ type: "notice", tone: "warn", text: "native API unavailable; falling back to unrestricted node:fs" });
  }

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
 * Install the shell's coordinates into process.env, whatever route they came
 * by. The readers (native/bridge.ts readNeutralinoAuth, oauth.ts's opener) all
 * consult process.env.NL_*, so one normalization point here keeps every
 * consumer ignorant of argv-vs-env — the same pattern --token uses.
 *
 * A missing token leaves NL_TOKEN unset rather than empty, because
 * readNeutralinoAuth treats an empty env token as "no shell".
 */
function applyShellCoordinates(input: { nlPath?: string; nlPort?: string; nlToken?: string }): void {
  if (input.nlPath) process.env.NL_PATH = input.nlPath;
  if (input.nlPort) process.env.NL_PORT = input.nlPort;
  if (input.nlToken) process.env.NL_TOKEN = input.nlToken;
}
