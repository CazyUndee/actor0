import { getRepoIndex } from "../repo-index.js";
import { parentPort } from "node:worker_threads";

/**
 * Builds the repo index off the main thread and posts it back, so the TUI can
 * warm its cache without the rg spawn ever blocking a frame or a turn.
 * Bundled to its own file (repo-index-worker.mjs) and spawned by App at startup.
 */
const index = getRepoIndex(process.cwd());
parentPort?.postMessage(index);
