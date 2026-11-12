/**
 * Bundles the agent core for shipping inside resources.neu.
 */

import { build } from "esbuild";

const outDir = "resources/neu";

await build({
  entryPoints: ["agent.entry.mjs"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: `${outDir}/agent.bundle.mjs`,
  minify: true,
  sourcemap: false,
  write: true,
  external: ["ws"],
});
