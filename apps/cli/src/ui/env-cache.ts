import type { Environment } from "../environment.js";

/**
 * The measured environment, shared across the whole process.
 *
 * It lives here, not in environment.ts, so the TUI bundle can inject a warmed
 * measurement without importing environment.ts (which pulls in tools.ts, whose
 * module top level spawns a shell and would put that spawn back on the boot
 * path). And it lives on globalThis, not in module scope, because the app ships
 * as several bundles (cli, tui, turn, env-worker) — each would otherwise get its
 * own module instance, and a value warmed in one would be invisible to the
 * others. globalThis is the one store they all share. The import above is
 * type-only, so it is erased and this module has no runtime dependency on the
 * detection code.
 */
const KEY = "__actor0_environment__";

type Store = { [KEY]?: Environment };
const store = (): Store => globalThis as Store;

export const getCachedEnvironment = (): Environment | undefined => store()[KEY];

export const setCachedEnvironment = (env: Environment): void => {
  store()[KEY] = env;
};

export const clearCachedEnvironment = (): void => {
  delete store()[KEY];
};
