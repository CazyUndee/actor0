#!/usr/bin/env node
/**
 * Bundles the desktop agent core into one ESM file that ships inside
 * `resources.neu` and is spawned by the Neutralino shell.
 *
 * Everything is inlined, including `ws`: the app has to be one file the shell
 * can copy beside the framework, and a bundle that still needed a
 * `node_modules` tree at runtime would defeat that. `ws`'s two optional native
 * accelerators (`bufferutil`, `utf-8-validate`) are loaded in `try`/`catch` by
 * the package itself, so a bundle without them works and simply uses the
 * JavaScript path.
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = `${here}/../dist/agent.mjs`;

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [`${here}/../src/index.ts`],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile,
  sourcemap: false,
  minify: false,
  banner: {
    // Node 22 has no `require` in ESM, and bundled CJS dependencies still call
    // it; this is the shim esbuild documents for exactly that case.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

console.log(`wrote ${outfile}`);
