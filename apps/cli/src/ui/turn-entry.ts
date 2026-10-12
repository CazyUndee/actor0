/**
 * The turn machinery, bundled into its own file so the boot never loads it.
 *
 * `tools.ts` has a module-level side effect — the shell tool's description calls
 * `resolveShell()`, which spawns a shell synchronously to detect it. That
 * measured ~80% of the whole boot, blocking the first frame. `turn.ts` imports
 * `tools.ts`, so both live here and are loaded lazily on the first turn (via a dynamic import in App), when a few seconds is
 * an expected wait for a response rather than a stall before the composer draws.
 *
 * index.ts reaches this through `import(\"./ui/turn-entry.js\")`, which the
 * bundler rewrites to a runtime `import(\"./turn.mjs\")`.
 */
export {
  cancelledTurnMessages,
  describeRecovery,
  describeStop,
  describeTruncation,
  failedTurnMessages,
  forStorage,
  runTurn,
  verifyProvider,
} from "../turn.js";
export { createToolHost } from "../tools.js";
