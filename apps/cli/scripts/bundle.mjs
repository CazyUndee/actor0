import { build } from "esbuild";

/**
 * Bundle the CLI into a single file.
 *
 * `tsc` emits one module per source file, and the CLI's dependency tree (ink
 * pulls in es-toolkit, ws and ~20 more, each split across many small files) is
 * read from disk on every start. On a slow or antivirus-scanned disk that added
 * ~4s to every launch — the whole app felt frozen before its first frame.
 *
 * Bundling collapses the tree into one file, so startup pays a single read
 * instead of hundreds. Measured: ~5s → ~0.3s. Kept as a separate script rather
 * than inline flags because the shebang and the long flag list do not survive
 * shell quoting.
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

await build({
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  // ESM, and it has to be. The dependency tree is ESM now — `ink` 6 and
  // `yoga-layout` 3 both use top-level await — and esbuild cannot lower that to
  // CommonJS: it fails the build outright with "Top-level await is not
  // available in the configured target environment". So `format: "cjs"` here
  // does not produce a slower bundle, it produces no bundle at all.
  //
  // But ESM breaks the *other* half of what an earlier note here tried to
  // solve. One of ink's CommonJS dependencies, `signal-exit`, does a dynamic
  // `require("assert")` of a Node builtin. esbuild cannot see that at build
  // time, so in ESM output the call is left pointing at esbuild's `__require`
  // shim — which throws `Dynamic require of "assert" is not supported` the
  // moment the bundle loads. The old note reached for CJS to dodge this; that
  // is no longer an available move, so the shim is disarmed instead. Its own
  // first check is `typeof require !== "undefined"`, so a real `require` in the
  // bundle scope routes the call to the genuine builtin. This is esbuild's
  // documented remedy for exactly this error.
  format: "esm",
  target: "node20",
  outfile: "dist/cli.mjs",
  // Injected after the entry's `#!` shebang, which esbuild keeps at line 1 — it
  // hoists the hashbang above the banner rather than the other way round, so
  // adding a shebang here would only duplicate it.
  banner: {
    js: 'import { createRequire as __actor0CreateRequire } from "module";\nconst require = __actor0CreateRequire(import.meta.url);',
  },
  // No shebang banner: the entry (dist/index.js) already begins with
  // `#!/usr/bin/env node` and esbuild keeps it as line 1. Adding one here would
  // duplicate it onto line 2, which ESM rejects.
  plugins: [stubDevtools],
});
