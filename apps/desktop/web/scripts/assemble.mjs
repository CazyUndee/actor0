#!/usr/bin/env node
/**
 * Assembles the two halves into the layout the shell serves.
 *
 * `resources/app` is the UI bundle (built by vite), and `resources/agent` is the
 * agent bundle (built by `@actor0/desktop-agent`). Keeping the copy in one small
 * script — rather than two `cp` calls in a package.json string — is what makes
 * the layout a single readable fact, since the shell's config, the spawn command
 * and `neu build` all depend on it being exactly this.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const agentDist = join(webRoot, "..", "agent", "dist", "agent.mjs");
const agentTarget = join(webRoot, "resources", "agent");

if (!existsSync(agentDist)) {
  console.error(`missing ${agentDist} — run: npm --workspace @actor0/desktop-agent run build`);
  process.exit(1);
}

rmSync(agentTarget, { recursive: true, force: true });
mkdirSync(agentTarget, { recursive: true });
cpSync(agentDist, join(agentTarget, "agent.mjs"));

// The Neutralino client library, served beside the page so the same bundle
// works when the shell does not inject it (dev mode through the static server).
const clientLib = join(webRoot, "..", "..", "..", "node_modules", "@neutralinojs", "lib", "dist", "neutralino.js");
if (existsSync(clientLib)) {
  cpSync(clientLib, join(webRoot, "resources", "app", "neutralino.js"));
}

const ui = join(webRoot, "resources", "app", "index.html");
if (!existsSync(ui)) {
  console.error(`missing ${ui} — run: npm --workspace @actor0/desktop-web run build`);
  process.exit(1);
}

console.log("resources/ ready: app/ (UI) + agent/agent.mjs (agent core)");
