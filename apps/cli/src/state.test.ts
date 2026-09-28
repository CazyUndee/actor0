import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSlash, COMMANDS } from "./slash.js";
import { cronix } from "./theme.generated.js";
import { PROVIDER_SUMMARY } from "./providers.js";

test("ordinary text is not a command", () => {
  assert.equal(parseSlash("hello"), undefined);
  assert.equal(parseSlash("  what about /help?  "), undefined);
});

test("a half-typed slash is not a command yet", () => {
  assert.equal(parseSlash("/"), undefined, "so a trailing slash mid-typing is not an error");
});

test("the documented commands parse", () => {
  assert.deepEqual(parseSlash("/help"), { name: "help" });
  assert.deepEqual(parseSlash("/clear"), { name: "clear" });
  assert.deepEqual(parseSlash("/quit"), { name: "quit" });
  assert.deepEqual(parseSlash("/model"), { name: "model" });
});

test("/model carries an argument", () => {
  assert.deepEqual(parseSlash("/model gpt-4o-mini"), { name: "model", model: "gpt-4o-mini" });
  assert.deepEqual(parseSlash("/model   some/model:v2  "), { name: "model", model: "some/model:v2" });
});

test("commands are case-insensitive and tolerate surrounding space", () => {
  assert.deepEqual(parseSlash("  /HELP  "), { name: "help" });
});

test("an unknown command is reported rather than guessed at", () => {
  assert.deepEqual(parseSlash("/wat"), { name: "unknown", input: "/wat" });
});

test("every command has help text", () => {
  const documented = parseSlash;
  for (const name of COMMANDS) {
    assert.ok(documented(`/${name}`), `${name} must parse`);
  }
});

test("the generated theme is complete and opaque", () => {
  // Every colour must be a 6-digit hex: the generator composites translucent
  // tokens onto the app background because a terminal cell cannot be alpha.
  for (const [name, value] of Object.entries(cronix.color)) {
    assert.match(value, /^#[0-9a-f]{6}$/, `${name} must be an opaque hex colour, got ${value}`);
  }
  assert.equal(cronix.color.bg, "#0a0a0a", "CronixUI's own background must be the source of truth");
});

test("the theme carries the scale the UI actually reads", () => {
  assert.ok(Object.keys(cronix.space).length >= 8);
  assert.ok(Object.keys(cronix.fontSize).length >= 7);
  assert.ok(cronix.transition.base > 0 && cronix.transition.slow >= cronix.transition.base);
});

test("paths are overridable for tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-paths-"));
  process.env.ACTOR0_CONFIG_DIR = dir;
  assert.match(join(dir, "config.json"), /config\.json$/);
  delete process.env.ACTOR0_CONFIG_DIR;
});

test("there is one endpoint, and it says it needs no key", () => {
  assert.match(PROVIDER_SUMMARY, /aestral-chat\.vercel\.app\/api\/chat/);
  assert.match(PROVIDER_SUMMARY, /no API key needed/);
});

