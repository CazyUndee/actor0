import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeNamedProvider,
  addProvider,
  addModels,
  endpointUrl,
  loadConfig,
  maskSecret,
  namedProviders,
  providerName,
  removeProvider,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  withActiveReasoningEffort,
  withModel,
  type DesktopConfig,
} from "./config.js";

/**
 * The config layer, exercised as a format rather than as a class.
 *
 * The desktop app and the CLI share `config.json` *by format*, so the tests
 * that matter are the ones about the format: what a hand-written file resolves
 * to, what survives a round trip, and what the environment is allowed to
 * override. A bug here sends a request somewhere the user cannot account for,
 * which is the failure this file exists to prevent.
 */

let dir: string;
const envKeys = ["ACTOR0_CONFIG_DIR", "ACTOR0_DATA_DIR", "ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_API_KEY", "ACTOR0_PATH"] as const;
const saved: Record<string, string | undefined> = {};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-desktop-config-"));
  for (const key of envKeys) saved[key] = process.env[key];
  process.env.ACTOR0_CONFIG_DIR = join(dir, "config");
  process.env.ACTOR0_DATA_DIR = join(dir, "data");
});

after(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ["ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_API_KEY", "ACTOR0_PATH"] as const) delete process.env[key];
});

describe("provider names", () => {
  it("derives a name from the host, without the www prefix", () => {
    assert.equal(providerName("https://www.example.com/v1"), "example.com");
    assert.equal(providerName("http://127.0.0.1:9655/v1"), "127.0.0.1:9655");
  });
});

describe("the config file", () => {
  it("round-trips a registered provider list, and writes the new shape only", () => {
    const config: DesktopConfig = {
      model: "m-a",
      models: ["m-a"],
      provider: { baseUrl: "https://legacy.example.com/v1", model: "old" },
      providers: [{ name: "claude", baseUrl: "https://api.anthropic.com", model: "claude-opus-4-6", models: ["claude-opus-4-6"] }],
      activeProvider: "claude",
    };
    saveConfig(config);
    const written = JSON.parse(readFileSync(join(dir, "config", "config.json"), "utf8")) as Record<string, unknown>;
    // Two sources of truth for one endpoint is exactly the drift this module
    // exists to prevent, so the legacy field must not be persisted alongside.
    assert.equal(written.provider, undefined);
    const loaded = loadConfig();
    assert.equal(loaded.activeProvider, "claude");
    assert.equal(loaded.providers?.[0]?.name, "claude");
    assert.equal(loaded.providers?.[0]?.baseUrl, "https://api.anthropic.com");
  });

  it("projects a legacy single provider into the list without rewriting the file", () => {
    saveConfig({ model: "m", models: [], provider: { baseUrl: "https://api.example.com/v1" } });
    const config = loadConfig();
    assert.equal(config.providers, undefined);
    const list = namedProviders(config);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "api.example.com");
  });

  it("ignores a provider entry with no base URL rather than carrying a broken endpoint", () => {
    writeFileSync(
      join(dir, "config", "config.json"),
      JSON.stringify({ model: "m", models: [], providers: [{ name: "ok", baseUrl: "https://a.example.com" }, { name: "bad" }] }),
    );
    const config = loadConfig();
    assert.deepEqual(config.providers?.map((p) => p.name), ["ok"]);
  });

  it("de-duplicates colliding provider names so writes cannot collide", () => {
    writeFileSync(
      join(dir, "config", "config.json"),
      JSON.stringify({
        model: "m",
        models: [],
        providers: [
          { name: "dup", baseUrl: "https://a.example.com" },
          { name: "dup", baseUrl: "https://b.example.com" },
        ],
      }),
    );
    const config = loadConfig();
    assert.deepEqual(config.providers?.map((p) => p.name), ["dup", "dup-2"]);
  });
});

describe("resolving the endpoint", () => {
  it("prefers the environment over the file", () => {
    saveConfig({
      model: "file-model",
      models: [],
      providers: [{ name: "file", baseUrl: "https://file.example.com/v1", model: "file-model" }],
      activeProvider: "file",
    });
    process.env.ACTOR0_BASE_URL = "https://env.example.com/v1";
    process.env.ACTOR0_MODEL = "env-model";
    const resolved = resolveProvider(loadConfig());
    assert.equal(resolved.baseUrl, "https://env.example.com/v1");
    assert.equal(resolved.model, "env-model");
    assert.equal(endpointUrl(resolved), "https://env.example.com/v1/chat/completions");
  });

  it("refuses a config with no provider at all, and names the fix", () => {
    saveConfig({ model: "m", models: [] });
    // BYOK: there is no built-in endpoint to fall back to, deliberately — a
    // request that goes to a host nobody chose is the one thing this app must
    // never do.
    assert.throws(() => resolveProvider(loadConfig()), /No provider is configured/);
  });

  it("names the missing model rather than sending a request with an empty one", () => {
    saveConfig({ model: "", models: [], providers: [{ name: "p", baseUrl: "https://api.example.com/v1" }], activeProvider: "p" });
    assert.throws(() => resolveProvider(loadConfig()), /No model is set/);
  });

  it("refuses an OAuth provider that carries no token", () => {
    saveConfig({
      model: "m",
      models: [],
      providers: [{ name: "o", baseUrl: "https://api.example.com", auth: "oauth", model: "m" }],
      activeProvider: "o",
    });
    assert.throws(() => resolveProvider(loadConfig()), /OAuth but has no token/);
  });

  it("expands ${NAME} in a credential and fails by name when it is unset", () => {
    saveConfig({
      model: "m",
      models: [],
      providers: [{ name: "o", baseUrl: "https://api.example.com", apiKey: "${ACTOR0_TEST_KEY}", model: "m" }],
      activeProvider: "o",
    });
    assert.throws(() => resolveProvider(loadConfig()), /ACTOR0_TEST_KEY is not set/);
    process.env.ACTOR0_TEST_KEY = "sk-secret";
    try {
      assert.equal(resolveProvider(loadConfig()).apiKey, "sk-secret");
    } finally {
      delete process.env.ACTOR0_TEST_KEY;
    }
  });
});

describe("the provider registry", () => {
  const empty: DesktopConfig = { model: "", models: [] };

  it("adds, activates, and removes an endpoint", () => {
    let config = addProvider(empty, { baseUrl: "https://api.example.com/v1", model: "m" });
    assert.equal(config.activeProvider, "api.example.com");
    config = addProvider(config, { name: "second", baseUrl: "https://other.example.com/v1" });
    config = setActiveProvider(config, "api.example.com");
    assert.equal(activeNamedProvider(config)?.name, "api.example.com");
    config = removeProvider(config, "api.example.com");
    // Removing the active endpoint hands over to the first survivor.
    assert.equal(activeNamedProvider(config)?.name, "second");
    config = removeProvider(config, "second");
    assert.equal(config.activeProvider, undefined);
    assert.equal(activeNamedProvider(config), undefined);
  });

  it("records a model on the active provider, not on the flat list", () => {
    let config = addProvider(empty, { name: "a", baseUrl: "https://a.example.com", model: "m1" });
    config = addProvider(config, { name: "b", baseUrl: "https://b.example.com", model: "m2" });
    config = setActiveProvider(config, "b");
    config = withModel(config, "m3");
    assert.deepEqual(config.providers?.find((p) => p.name === "a")?.models, ["m1"]);
    assert.deepEqual(config.providers?.find((p) => p.name === "b")?.models, ["m3", "m2"]);
    assert.deepEqual(config.models, []);
  });

  it("caps a provider's remembered models at twenty", () => {
    let config = addProvider(empty, { name: "a", baseUrl: "https://a.example.com", model: "m0" });
    config = addModels(config, Array.from({ length: 30 }, (_, i) => `m${i + 1}`));
    assert.equal(config.providers?.[0]?.models?.length, 20);
    assert.equal(config.providers?.[0]?.models?.[0], "m1");
  });

  it("sets and clears the reasoning effort on the active provider", () => {
    let config = addProvider(empty, { name: "a", baseUrl: "https://a.example.com", model: "m" });
    config = withActiveReasoningEffort(config, "high");
    assert.equal(config.providers?.[0]?.reasoningEffort, "high");
    config = withActiveReasoningEffort(config, undefined);
    assert.equal(config.providers?.[0]?.reasoningEffort, undefined);
  });
});

describe("credential masking", () => {
  it("shows enough to recognise a key and not enough to use one", () => {
    assert.equal(maskSecret(undefined), "none");
    assert.equal(maskSecret("short"), "sh... (5 chars)");
    assert.equal(maskSecret("sk-abcdef1234567890"), "sk-abc...90 (19 chars)");
  });
});

describe("the config file location", () => {
  it("honours ACTOR0_CONFIG_DIR, so a test never touches a real home", () => {
    saveConfig({ model: "m", models: [] });
    assert.ok(existsSync(join(dir, "config", "config.json")));
  });
});
