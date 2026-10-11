import { createElement } from "react";
import { render } from "ink";
import type { ChatMessage } from "@actor0/harness";
import type { CliConfig } from "../config.js";
import { App } from "./App.js";
import { Screen } from "./term.js";
import { setCachedEnvironment } from "./env-cache.js";

/**
 * Boot the full-screen TUI.
 *
 * This is its own module so the bundle can split it out: `index.ts` imports it
 * dynamically, the bundler emits it as a single `tui.mjs`, and the fast paths
 * (`--version`, `--help`, `--sessions`, `-p`) never load it. The TUI is one file,
 * not a dozen esbuild chunks — on an antivirus-scanned disk a chunk per module
 * is a scan per module, and that measured ~10s against ~2s for one read.
 */

/** An env flag is set when it is present and not "0"/"false"/"". */
function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Measure the machine off the main thread and warm the shared env cache. The
 * detection spawns shells (~seconds — the single biggest cost before the first
 * token); a worker keeps that off the boot frame and off the first turn, so
 * time-to-first-token is the model, not a probe. Best-effort: a worker that
 * fails to start leaves the cache cold, and detectEnvironment falls back to a
 * minimal, spawn-free box.
 */
function warmEnvironment(): void {
  void (async () => {
    try {
      const { Worker } = await import("node:worker_threads");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      const path = join(dirname(fileURLToPath(import.meta.url)), "env-worker.mjs");
      const worker = new Worker(path);
      worker.once("message", (env: unknown) => {
        setCachedEnvironment(env as Parameters<typeof setCachedEnvironment>[0]);
        void worker.terminate();
      });
      worker.once("error", () => void worker.terminate());
    } catch {
      // best-effort warm; a cold cache falls back to a minimal environment
    }
  })();
}

export interface BootOptions {
  cwd: string;
  config: CliConfig;
  version: string;
  stdin: NodeJS.ReadStream;
  resumed?: { id: string; createdAt: string; updatedAt: string; messages: ChatMessage[] };
}

/** Start the TUI and return a function that resolves when it exits. */
export async function bootTui(opts: BootOptions): Promise<() => Promise<void>> {
  // Our own renderer owns the terminal. Ink is used only to host React's state
  // and effects, and is handed streams it writes nothing to — the App returns
  // null, so Ink draws nothing and never fights the frame (see ui/App.tsx).
  // Mouse capture is opt-out (it breaks terminal-native copy-paste); keyboard
  // scroll — PgUp/PgDn, the arrows — works either way.
  const screen = new Screen(process.stdout, { mouse: !truthy(process.env.ACTOR0_DISABLE_MOUSE) });
  // Start measuring the machine off the main thread now, so the cache is warm
  // before the first turn builds its system prompt — without ever blocking the
  // first frame. detectEnvironment (in the turn path) reads the warmed cache.
  warmEnvironment();
  const { PassThrough } = await import("node:stream");
  const sink = new PassThrough();
  sink.resume();
  const instanceRef: { current: ReturnType<typeof render> | undefined } = { current: undefined };
  const restoreTerminal = (): void => {
    screen.dispose();
    try {
      opts.stdin.setRawMode?.(false);
    } catch {
      // not a TTY — nothing to restore
    }
  };
  const exit = (): void => {
    restoreTerminal();
    instanceRef.current?.unmount();
    process.exit(0);
  };
  // A `kill`, a crash, or a closed terminal must not leave the user stranded in
  // the alt screen with the mouse captured — restore it on the way down.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      restoreTerminal();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
  if (opts.stdin.isTTY) opts.stdin.setRawMode(true);
  opts.stdin.setEncoding("utf8");
  instanceRef.current = render(
    createElement(App, {
      cwd: opts.cwd,
      config: opts.config,
      version: opts.version,
      screen,
      stdin: opts.stdin,
      onExit: exit,
      ...(opts.resumed ? { resumed: opts.resumed } : {}),
    }),
    // Ctrl+C is handled in the app: it cancels a running turn first and only
    // exits when there is nothing to cancel.
    { exitOnCtrlC: false, stdin: sink as never, stdout: sink as never, patchConsole: false },
  );
  return (): Promise<void> => instanceRef.current!.waitUntilExit() as Promise<void>;
}
