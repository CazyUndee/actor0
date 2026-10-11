import { build } from "esbuild";
import { rmSync } from "node:fs";

/**
 * Bundle the CLI into two files: a small `cli.mjs` entry and one `tui.mjs`.
 *
 * `tsc` emits one module per source file, and the CLI's dependency tree (ink
 * pulls in es-toolkit, ws and ~20 more, each split across many small files) is
 * read from disk on every start. On a slow or antivirus-scanned disk that added
 * ~4s to every launch — the whole app felt frozen before its first frame.
 *
 * Bundling collapses the tree. The TUI is bundled to its own `tui.mjs` and
 * loaded through a dynamic import, so `--version`/`--help`/`--sessions`/`-p`
 * never read it. Crucially the TUI stays a *single* file: esbuild's `splitting`
 * would emit a chunk per module, and on an antivirus-scanned disk that is a scan
 * per chunk — it measured ~10s against ~2s for one read. So: two single-file
 * builds, not one split build.
 *
 * Kept as a separate script rather than inline flags because the shebang and
 * the long flag list do not survive shell quoting.
 */

// ink imports the optional, DEV-only `react-devtools-core` through a
// DEV-guarded dynamic import. esbuild pulls that branch into the bundle and
// hoists the import to the top level, so leaving it external would crash at
// load. Stub it instead — the real module is only touched when DEV is set.
const stubDevtools = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "devtools-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      contents: "export default {}",
      loader: "js",
    }));
  },
};

// ESM, and it has to be. The dependency tree is ESM now — `ink` 6 and
// `yoga-layout` 3 both use top-level await — and esbuild cannot lower that to
// CommonJS: it fails the build outright with "Top-level await is not available
// in the configured target environment". But ESM breaks the *other* half of what
// an earlier note here tried to solve. One of ink's CommonJS dependencies,
// `signal-exit`, does a dynamic `require("assert")` of a Node builtin. esbuild
// cannot see that at build time, so in ESM output the call is left pointing at
// esbuild's `__require` shim — which throws `Dynamic require of "assert" is not
// supported` the moment the bundle loads. The old note reached for CJS to dodge
// this; that is no longer an available move, so the shim is disarmed instead. A
// real `require` in the bundle scope routes the call to the genuine builtin.
// Applied to both outputs, since signal-exit lives in tui.mjs.
const banner = {
  js: 'import { createRequire as __actor0CreateRequire } from "module";\nconst require = __actor0CreateRequire(import.meta.url);',
};

// Force production. react-reconciler ships dev (750KB, with checks) and production
// (407KB) builds and picks on `process.env.NODE_ENV`; without this the bundle
// carries *both* and runs the dev one — a third of tui.mjs and the slower path.
// Defining it at build time dead-code-eliminates the dev branch everywhere (react
// too), so only the production build is bundled and run.
const define = { "process.env.NODE_ENV": '"production"' };

rmSync("dist/tui.mjs", { force: true });
rmSync("dist/turn.mjs", { force: true });

// Two rewrite plugins. esbuild's `alias` only takes package names, not
// relative paths, so a dynamic `import("./ui/x.js")` is rewritten to a runtime
// `import("./y.mjs")` and left out of the bundle by these. Each applies to the
// one build whose entry imports that module — never to the module's own build.
const externalize = (from, to) => ({
  name: `externalize-${to}`,
  setup(build) {
    build.onResolve({ filter: from }, () => ({ path: to, external: true }));
  },
});

// 1) the TUI, as one file. Its App dynamic-imports the turn machinery, which is
//    externalised out of it, so the boot never loads tools.ts and its
//    module-level shell spawn. (tui-bootstrap is this bundle's entry, so it is
//    never externalised here.)
await build({
  entryPoints: ["dist/ui/tui-bootstrap.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/tui.mjs",
  banner,
  define,
  plugins: [stubDevtools, externalize(/turn-entry\.js$/, "./turn.mjs")],
});

// 2) the turn machinery (turn.ts + tools.ts + subagent.ts), as one file, loaded
//    on the first turn. Its module-load shell spawn happens there, not at boot.
await build({
  entryPoints: ["dist/ui/turn-entry.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/turn.mjs",
  banner,
  define,
  plugins: [stubDevtools],
});

// 3) the environment worker. Spawned by the TUI at startup to measure the
//    machine off the main thread, so the first turn's system prompt never waits
//    on the shell spawns.
await build({
  entryPoints: ["dist/ui/env-worker.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/env-worker.mjs",
  banner,
  define,
  plugins: [stubDevtools],
});

// 4) the entry. Its TUI import is rewritten to `./tui.mjs` and marked external,
//    so it is a runtime `import("./tui.mjs")` the entry hits only on the
//    interactive path.
await build({
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/cli.mjs",
  banner,
  define,
  plugins: [stubDevtools, externalize(/tui-bootstrap\.js$/, "./tui.mjs")],
});
