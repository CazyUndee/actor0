import { resolveShellSync } from "../tools.js";
import { parentPort } from "node:worker_threads";

/**
 * Resolves the shell off the main thread and posts it back, so the TUI can
 * warm its cache without the shell spawns ever blocking a frame or a turn.
 * Bundled to its own file (shell-worker.mjs) and spawned by App at startup.
 */
const shell = resolveShellSync();
parentPort?.postMessage(shell);
