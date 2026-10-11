import { measureEnvironment } from "../environment.js";
import { parentPort } from "node:worker_threads";

/**
 * Measures the environment off the main thread and posts it back, so the TUI can\n * warm its cache without the shell spawns ever blocking a frame or a turn.\n * Bundled to its own file (env-worker.mjs) and spawned by App at startup.\n */
const env = measureEnvironment();
parentPort?.postMessage(env);
