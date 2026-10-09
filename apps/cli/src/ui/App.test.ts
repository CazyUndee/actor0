import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, resolveProvider } from "../config.js";
import { CLAUDE_OAUTH, CHATGPT_OAUTH, ENDPOINTS } from "../providers.js";

/**
 * There is no built-in endpoint any more — the CLI is BYOK.
 *
 * What replaced the fixed-endpoint tests is the property that matters now:
 * nothing is configured until the user configures it, and `resolveProvider`
 * says so rather than quietly talking to a host nobody chose. The presets are
 * pinned too, because a wrong OAuth value fails silently and the whole point of
 * reading them off the installed CLIs was to not ship an invented one.
 */

function withCleanEnv<T>(body: () => T): T {
  const keys = ["ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_API_KEY", "ACTOR0_PATH", "ACTOR0_CONFIG_DIR"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  // Point the config at a fresh empty dir, so a config left on the real machine
  // (or by another test in the same process) cannot make "nothing configured"
  // resolve to something.
  const dir = mkdtempSync(join(tmpdir(), "actor0-app-"));
  process.env.ACTOR0_CONFIG_DIR = dir;
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with nothing configured, resolveProvider says so instead of falling back", () => {
  withCleanEnv(() => {
    assert.throws(() => resolveProvider(loadConfig()), /No provider is configured/, "BYOK: no silent built-in host");
  });
});

test("ACTOR0_BASE_URL points a run at an endpoint with no config file", () => {
  withCleanEnv(() => {
    process.env.ACTOR0_BASE_URL = "https://gateway.test/v1";
    process.env.ACTOR0_MODEL = "m";
    const provider = resolveProvider(loadConfig());
    assert.equal(provider.baseUrl, "https://gateway.test/v1");
    assert.equal(provider.transport, "openai", "an env endpoint defaults to the OpenAI wire");
  });
});

test("the Claude OAuth preset carries the values read off the installed CLI", () => {
  assert.equal(CLAUDE_OAUTH.clientId, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(CLAUDE_OAUTH.tokenUrl, "https://platform.claude.com/v1/oauth/token");
  assert.ok(CLAUDE_OAUTH.scopes.includes("user:inference"));
});

test("the ChatGPT OAuth preset carries the values read off the installed CLI", () => {
  assert.equal(CHATGPT_OAUTH.clientId, "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(CHATGPT_OAUTH.redirectPort, 1455);
  assert.equal(CHATGPT_OAUTH.redirectPath, "/auth/callback");
  assert.ok(CHATGPT_OAUTH.scopes.includes("offline_access"));
});

test("endpoints name where each transport actually lives", () => {
  assert.equal(ENDPOINTS.anthropic.baseUrl, "https://api.anthropic.com");
  assert.equal(ENDPOINTS.chatgpt.baseUrl, "https://chatgpt.com/backend-api/codex");
});

// A half-configured provider must fail here, naming what is missing, not at the
// first request with an opaque error.
test("a configured provider with no model is refused by name", () => {
  withCleanEnv(() => {
    assert.throws(
      () =>
        resolveProvider({
          model: "",
          models: [],
          providers: [{ name: "p", baseUrl: "https://api.example.com/v1" }],
          activeProvider: "p",
        }),
      (error: unknown) => error instanceof ConfigError && /No model is set/.test(error.message),
    );
  });
});
