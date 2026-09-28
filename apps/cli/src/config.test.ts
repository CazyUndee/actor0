import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readConfigFile, resolveProvider, saveConfig, withModel } from "./config.js";
import { RESPITE } from "./providers.js";

/**
 * Configuration, now that there is only one endpoint.
 *
 * This file used to pin a four-level precedence between environment, command
 * line, the stored file and presets. All of that decided *which host to talk
 * to*, and it went wrong in the worst possible way: a stored `baseUrl` for a
 * host that needs a credential outlived the reason it was written, a request
 * went there anyway, and every visible signal still named the right provider.
 *
 * So the precedence is gone rather than fixed. What is left to get right is
 * narrower, and these tests hold exactly that.
 */

function withConfigDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "actor0-config-"));
  const previous = process.env.ACTOR0_CONFIG_DIR;
  process.env.ACTOR0_CONFIG_DIR = dir;
  try {
    return body(dir);
  } finally {
    if (previous === undefined) delete process.env.ACTOR0_CONFIG_DIR;
    else process.env.ACTOR0_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("there is no config file and the CLI still works", () => {
  withConfigDir(() => {
    const config = loadConfig();
    assert.equal(config.model, RESPITE.model, "falls back to the built-in model");
  });
});

test("the endpoint is fixed and cannot be pointed elsewhere", () => {
  withConfigDir(() => {
    const provider = resolveProvider(loadConfig());
    assert.equal(provider.baseUrl, RESPITE.baseUrl);
    assert.equal(provider.path, RESPITE.path);
    assert.equal(provider.model, RESPITE.model);
  });
});

test("a stored baseUrl is ignored, not honoured", () => {
  // The exact file that caused the reported failure. It is still valid JSON
  // and still has a model in it, so it keeps working — but its baseUrl, its
  // request path and its absent key can no longer send traffic anywhere.
  withConfigDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: { baseUrl: "https://publicai.co/v1", model: "swiss-ai/apertus-v1.5-70b" },
        models: [],
      }),
    );
    const config = loadConfig();
    assert.equal(config.model, "swiss-ai/apertus-v1.5-70b", "the model is still honoured");
    const provider = resolveProvider(config);
    assert.equal(provider.baseUrl, RESPITE.baseUrl, "the host is not configurable");
    assert.notEqual(provider.baseUrl, "https://publicai.co/v1");
  });
});

test("ACTOR0_MODEL wins over the file, for one run", () => {
  withConfigDir((dir) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ model: "from-file" }));
    const previous = process.env.ACTOR0_MODEL;
    process.env.ACTOR0_MODEL = "from-env";
    try {
      assert.equal(loadConfig().model, "from-env");
    } finally {
      if (previous === undefined) delete process.env.ACTOR0_MODEL;
      else process.env.ACTOR0_MODEL = previous;
    }
  });
});

test("a corrupt config file fails loudly rather than silently defaulting", () => {
  withConfigDir((dir) => {
    writeFileSync(join(dir, "config.json"), "{not json");
    assert.throws(() => readConfigFile(), /not valid JSON/);
  });
});

test("a non-object config file fails loudly", () => {
  withConfigDir((dir) => {
    writeFileSync(join(dir, "config.json"), "[1,2,3]");
    assert.throws(() => readConfigFile(), /must contain a JSON object/);
  });
});

test("junk entries in the model list are dropped, not carried", () => {
  withConfigDir((dir) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ model: "m", models: ["a", 3, null, "b"] }));
    assert.deepEqual(readConfigFile().models, ["a", "b"]);
  });
});

test("saving keeps the file to the owner", { skip: process.platform === "win32" }, () => {
  withConfigDir((dir) => {
    saveConfig({ model: "m", models: [] });
    const file = join(dir, "config.json");
    assert.equal(statSync(file).mode & 0o777, 0o600, "config holds no credential, but it is still private");
  });
});

test("a saved config round-trips", () => {
  withConfigDir((dir) => {
    saveConfig(withModel({ model: RESPITE.model, models: [] }, "some/other-model"));
    const stored = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { model: string; models: string[] };
    assert.equal(stored.model, "some/other-model");
    assert.deepEqual(stored.models, ["some/other-model"]);
  });
});

test("setting a model remembers it, most recent first", () => {
  const first = withModel({ model: "a", models: [] }, "b");
  const second = withModel(first, "c");
  assert.equal(second.model, "c");
  assert.deepEqual(second.models, ["c", "b"]);
});

test("setting the same model twice does not duplicate it", () => {
  const once = withModel({ model: "a", models: [] }, "b");
  assert.deepEqual(withModel(once, "b").models, ["b"]);
});

test("the saved config holds no endpoint, because there is nothing to configure", () => {
  withConfigDir((dir) => {
    saveConfig({ model: "m", models: [] });
    const raw = readFileSync(join(dir, "config.json"), "utf8");
    assert.ok(!raw.includes("baseUrl"), `the config still carries a host: ${raw}`);
    assert.ok(!raw.includes("apiKey"), `the config still carries a key field: ${raw}`);
  });
});
