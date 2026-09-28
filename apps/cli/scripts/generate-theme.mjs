#!/usr/bin/env node
// Derives the CLI's terminal palette from the *installed* CronixUI package.
//
// CronixUI is a React/CSS toolkit: it publishes no terminal primitives, and its
// `cronixui/react` + `cronixui/tokens` subpath exports point at build output
// that is not present in the published tarball. What it does publish is its
// design-token stylesheet, so that is what we read. This script is the only
// place that knows how a CSS custom property becomes a terminal colour.
//
// Two transformations happen here, and both are the terminal's fault, not ours:
//
//   1. Alpha compositing. Tokens like `--cn-border: rgba(255,255,255,0.08)`
//      are translucent by design because a browser stacks them over `--cn-bg`.
//      A terminal cell is a single opaque colour, so every alpha token is
//      composited over the app background to reproduce what the web UI shows.
//
//   2. Unit stripping. `16px` -> 16, `0.15s` -> 150.
//
// Run with `npm run gen:theme -w @actor0/cli`. `npm test` fails if the committed
// output no longer matches, so bumping CronixUI surfaces as a red build that
// tells you the palette moved, rather than as a silent visual regression.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "src", "theme.generated.ts");

const RELATIVE_CSS = join("packages", "web", "dist", "variables.css");

/**
 * Locate the published CronixUI token stylesheet by walking up to the nearest
 * node_modules. `require.resolve("cronixui/package.json")` is not an option:
 * CronixUI's `exports` map declares only ".", "./react", "./typescript",
 * "./tokens" and a few CSS/JS paths, so Node refuses to expose its own
 * package.json. Resolving by directory walk sidesteps that entirely, and also
 * works whether npm hoisted the package or nested it under this workspace.
 */
function resolveVariablesCss() {
  let dir = here;
  for (;;) {
    const candidate = join(dir, "node_modules", "cronixui", RELATIVE_CSS);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not find node_modules/cronixui/${RELATIVE_CSS} above ${here}. ` +
          "Is cronixui installed? Try: npm install",
      );
    }
    dir = parent;
  }
}

function parseHex(value) {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function parseColor(value) {
  const text = value.trim();
  const rgba = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgba) {
    return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  if (text.startsWith("#")) return { rgb: parseHex(text), alpha: 1 };
  throw new Error(`unsupported colour syntax: ${value}`);
}

const toHex = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/** Flatten a translucent token onto an opaque backdrop. */
function composite(value, backdrop) {
  const { rgb, alpha } = parseColor(value);
  if (alpha >= 1) return `#${rgb.map(toHex).join("")}`;
  const mixed = rgb.map((channel, i) => channel * alpha + backdrop[i] * (1 - alpha));
  return `#${mixed.map(toHex).join("")}`;
}

/** Pull `--cn-*` declarations out of the dark `:root` block only. */
function readRootTokens(css) {
  const start = css.indexOf(":root");
  if (start === -1) throw new Error("no :root block found in CronixUI variables.css");
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const tokens = new Map();
  for (const line of css.slice(open + 1, close).split("\n")) {
    const match = line.match(/^\s*(--cn-[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (match) tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

const px = (value) => {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`not a pixel value: ${value}`);
  return n;
};

const ms = (value) => {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`not a duration: ${value}`);
  return Math.round(n * 1000);
};

/** Group `--cn-<group>-<name>` into a nested object, keeping only accepted values. */
function group(tokens, prefix, project, accept = () => true) {
  const stem = `--cn-${prefix}-`;
  const out = {};
  for (const [key, raw] of tokens) {
    if (!key.startsWith(stem)) continue;
    const name = key.slice(stem.length);
    if (!name) continue;
    if (!accept(raw)) continue;
    out[name] = project(raw, name);
  }
  return out;
}

const isLength = (value) => /^-?[\d.]+px$/.test(value.trim());

function build() {
  const css = readFileSync(resolveVariablesCss(), "utf8");
  const tokens = readRootTokens(css);
  if (!tokens.has("--cn-bg")) throw new Error("CronixUI token set is missing --cn-bg; refusing to guess");

  const backdrop = parseColor(tokens.get("--cn-bg")).rgb;

  // Only true colours survive as colours. `border`/`borderHover`/`borderFocus`
  // and the four `*Border` status tokens are translucent and are projected
  // onto the background so a terminal shows the same colour the browser does.
  const colorNames = [
    "bg", "surface", "surface-2", "surface-3", "surface-4",
    "border", "border-hover", "border-focus",
    "text", "text-muted", "text-dim",
    "accent", "accent-hover", "accent-light", "accent-glow", "accent-text",
    "success", "success-border", "success-text",
    "warning", "warning-border", "warning-text",
    "error", "error-border", "error-text",
    "info", "info-border", "info-text",
  ];

  const color = {};
  for (const name of colorNames) {
    const raw = tokens.get(`--cn-${name}`);
    if (!raw) throw new Error(`CronixUI token --cn-${name} is missing; the CLI palette would be incomplete`);
    color[name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())] = composite(raw, backdrop);
  }

  const space = group(tokens, "space", px, isLength);
  // `--cn-text-*` is overloaded: `text-muted`/`text-dim` are colours (already
  // projected above), while `text-xs`..`text-3xl` are sizes. Keep the lengths.
  const fontSize = group(tokens, "text", px, isLength);
  const transition = {
    fast: ms(tokens.get("--cn-transition-fast")),
    base: ms(tokens.get("--cn-transition")),
    slow: ms(tokens.get("--cn-transition-slow")),
  };

  const body = { color, space, fontSize, transition };
  const text = `// GENERATED FILE - DO NOT EDIT.
// Source: cronixui/${RELATIVE_CSS.replace(/\\/g, "/")} (:root block)
// Regenerate: npm run gen:theme -w @actor0/cli
// Verified by: src/theme.test.ts
//
// CronixUI is the design system of record for this CLI. These are its dark
// theme tokens, with translucent values composited onto --cn-bg because a
// terminal cell cannot be translucent. Nothing here is chosen by hand.

export const cronix = ${JSON.stringify(body, null, 2)} as const;

export type CronixTheme = typeof cronix;
`;

  const summary = Object.entries(body)
    .map(([group, values]) => `${group}(${Object.keys(values).length})`)
    .join(" ");

  return { text, summary };
}

const { text: next, summary } = build();
const current = (() => {
  try {
    return readFileSync(outFile, "utf8");
  } catch {
    return "";
  }
})();

if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error("theme.generated.ts is stale — CronixUI's tokens changed. Run: npm run gen:theme -w @actor0/cli");
    process.exit(1);
  }
  console.log("theme.generated.ts is in sync with the installed CronixUI");
} else {
  writeFileSync(outFile, next);
  console.log(`wrote ${outFile} [${summary}]`);
}
