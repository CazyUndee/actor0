import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

/**
 * Version strings must stay in sync across all locations.
 *
 * Versions live in three package.json files plus hardcoded fallbacks in
 * mcp.ts and parts.test.ts. All must move together on every version bump.
 * This test catches drift before it ships.
 */
const ROOT = resolve(import.meta.dirname, "..", "..", "..");

function readPackageVersion(path: string): string {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
  return pkg.version;
}

function readHardcodedVersion(path: string, pattern: RegExp): string {
  const content = readFileSync(resolve(ROOT, "apps", "cli", path), "utf8");
  const match = content.match(pattern);
  if (!match) throw new Error(`Could not find version in ${path}`);
  return match[1]!;
}

test("all package.json versions are in sync", () => {
  const harness = readPackageVersion("packages/harness/package.json");
  const providers = readPackageVersion("packages/providers/package.json");
  const cli = readPackageVersion("apps/cli/package.json");

  assert.equal(harness, providers, "harness and providers versions must match");
  assert.equal(harness, cli, "harness and cli versions must match");
});

test("hardcoded fallback versions match package.json", () => {
  const cliVersion = readPackageVersion("apps/cli/package.json");

  const mcpVersion = readHardcodedVersion("src/mcp.ts", /version:\s*"([^"]+)"/);
  assert.equal(mcpVersion, cliVersion, "mcp.ts fallback version must match package.json");

  const partsVersion = readHardcodedVersion("src/ui/parts.test.ts", /version:\s*"([^"]+)"/);
  assert.equal(partsVersion, cliVersion, "parts.test.ts fallback version must match package.json");
});
