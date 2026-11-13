import { resolve } from "node:path";
import { Agent } from "./agent.js";
import { openBridge } from "./native/bridge.js";
import { startServer } from "./server.js";

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
 *   ACTOR0_AGENT_PORT   the port to listen on (default: any free port)
 *   ACTOR0_AGENT_TOKEN  the shared secret a client must present
 *   ACTOR0_AGENT_CWD    the working directory the tools are confined to
 *   NL_PATH             the shell's app directory (locates the native API)
 *   NL_TOKEN            the shell's access token, for the native API
 */

const VERSION = "0.5.7";

async function main(): Promise<void> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const cwd = resolve(process.env.ACTOR0_AGENT_CWD?.trim() || process.cwd());
  const bridge = await openBridge(log);

  const agent = new Agent({ cwd, bridge, version: VERSION });

  const port = Number(process.env.ACTOR0_AGENT_PORT ?? "0") || 0;
  const token = process.env.ACTOR0_AGENT_TOKEN?.trim() || undefined;
  const server = await startServer({
    agent,
    port,
    ...(token ? { token } : {}),
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
