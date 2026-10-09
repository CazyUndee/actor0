import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeNamedProvider,
  addProvider,
  describeProvider,
  endpointUrl,
  loadConfig,
  namedProviders,
  providerName,
  readConfigFile,
  removeProvider,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  withModel,
  type CliConfig,
} from "./config.js";

/**
 * Configuration, BYOK.
 *
 * There is no built-in endpoint: a provider must be configured, and
 * `resolveProvider` says so rather than quietly talking to a host nobody chose.
 * What these tests pin is that the environment beats the file, that a stored
 * provider is honoured and visible, that migration never re-routes a request,
 * and that a half-configured or absent provider fails by name rather than at
 * the first request.
 */

function withConfigDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "actor0-config-"));
  const previous = process.env.ACTOR0_CONFIG_DIR;
  // Isolate the endpoint env vars too: a developer shell that exports
  // ACTOR0_BASE_URL (any BYOK user's) would otherwise decide the host for these
  // tests and skip the cases they assert.
  const envKeys = ["ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_API_KEY", "ACTOR0_PATH"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.ACTOR0_CONFIG_DIR = dir;
  try {
    return body(dir);
  } finally {
    if (previous === undefined) delete process.env.ACTOR0_CONFIG_DIR;
    else process.env.ACTOR0_CONFIG_DIR = previous;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const MODEL = "demo-model";

test("with nothing configured, resolveProvider says so instead of falling back", () => {
  withConfigDir(() => {
    assert.throws(() => resolveProvider(loadConfig()), /No provider is configured/, "BYOK: no silent host");
  });
});

test("a stored provider is honoured, and its transport is carried", () => {
  withConfigDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        providers: [{ name: "publicai.co", baseUrl: "https://publicai.co/v1", model: "swiss-ai/apertus-v1.5-70b" }],
        activeProvider: "publicai.co",
        models: [],
      }),
    );
    const provider = resolveProvider(readConfigFile());
    assert.equal(provider.baseUrl, "https://publicai.co/v1", "the host is honoured");
    assert.equal(provider.model, "swiss-ai/apertus-v1.5-70b");
    assert.equal(provider.transport, "openai", "a config that named no transport is OpenAI-compatible");
    assert.equal(provider.auth, "api-key");
  });
});

test("an anthropic provider composes the Messages URL from its base", () => {
  const provider = resolveProvider({
    model: "",
    models: [],
    providers: [{ name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "api-key", apiKey: "k", model: "claude-x" }],
    activeProvider: "claude",
  });
  assert.equal(provider.transport, "anthropic");
  assert.equal(provider.path, undefined, "no absolute path is invented");
  assert.equal(endpointUrl(provider), "https://api.anthropic.com/v1/messages", "the Messages path is appended to the base");
});

test("a chatgpt provider keeps its /backend-api/codex prefix in the composed URL", () => {
  // The bug this pins: a default path of `/responses` replaces the whole
  // pathname and drops the backend prefix, sending every request to
  // chatgpt.com/responses. The path must append, not replace.
  const provider = resolveProvider({
    model: "gpt-5",
    models: [],
    providers: [{ name: "chatgpt", baseUrl: "https://chatgpt.com/backend-api/codex", transport: "chatgpt", auth: "oauth", model: "gpt-5", oauth: { accessToken: "AT", accountId: "acct" } }],
    activeProvider: "chatgpt",
  });
  assert.equal(endpointUrl(provider), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(provider.oauth?.accountId, "acct");
});

test("an oauth provider with no token is refused by name, not degraded to an empty key", () => {
  assert.throws(
    () =>
      resolveProvider({
        model: "m",
        models: [],
        providers: [{ name: "c", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "oauth", model: "m" }],
        activeProvider: "c",
      }),
    /signs in with OAuth but has no token/,
  );
});

test("an empty ACTOR0_API_KEY does not delete the stored key", () => {
  withConfigDir(() => {
    process.env.ACTOR0_API_KEY = "";
    try {
      const provider = resolveProvider({
        model: "m",
        models: [],
        providers: [{ name: "p", baseUrl: "https://api.example.com/v1", apiKey: "sk-stored", model: "m" }],
        activeProvider: "p",
      });
      assert.equal(provider.apiKey, "sk-stored", "an exported-but-empty key is treated as unset");
    } finally {
      delete process.env.ACTOR0_API_KEY;
    }
  });
});

test("an endpoint with no credential says so, instead of looking configured", () => {
  // `describeProvider` is the one place that states the credential's actual
  // presence, so it is pinned — including that it never prints the credential,
  // which is what makes it safe to screenshot.
  const described = describeProvider({
    baseUrl: "https://api.example.com/v1",
    path: "/chat/completions",
    model: "some-model",
    transport: "openai",
    auth: "api-key",
  });
  assert.ok(
    described.some((line) => /credential not set/.test(line)),
    `a missing key must be visible, got: ${described.join(" | ")}`,
  );
  assert.ok(described.some((line) => /api\.example\.com/.test(line)), "the host in play must be visible");

  const withKey = describeProvider({
    baseUrl: "https://api.example.com/v1",
    path: "/chat/completions",
    model: "some-model",
    transport: "openai",
    auth: "api-key",
    apiKey: "sk-live-abcdefghijklmnop",
    apiKeySource: "config.json",
  });
  const line = withKey.find((entry) => entry.startsWith("credential"))!;
  assert.ok(!line.includes("abcdefghijklmnop"), "the key itself must never be printed");
  assert.ok(line.includes("sk-liv"), "but enough of it to tell two keys apart");
  assert.ok(withKey.some((entry) => entry.includes("config.json")), "and where it came from");
});

test("a model cannot be carried across from another endpoint", () => {
  // The silent-drift bug the flat `model` field would have had: a name that
  // exists on one gateway and not another, displayed as though it were fine.
  // `/model` writes to whichever field the active endpoint reads, so there is
  // only ever one place the model in play lives.
  const custom = withModel({ model: "", models: [], provider: { baseUrl: "https://api.example.com/v1" } }, "m-1");
  assert.equal(custom.provider?.model, "m-1", "a custom endpoint records the model on itself");
  assert.equal(custom.model, "", "and does not pretend another endpoint changed");

  const builtIn = withModel({ model: "", models: [] }, "m-2");
  assert.equal(builtIn.model, "m-2", "with no provider active the model is kept flat");
});

test("a key given as ${NAME} is read from the environment, and a missing one is named", () => {
  withConfigDir(() => {
    const previous = process.env.ACTOR0_TEST_KEY;
    process.env.ACTOR0_TEST_KEY = "sk-from-env";
    try {
      const provider = resolveProvider({
        model: "m",
        models: [],
        provider: { baseUrl: "https://api.example.com/v1", apiKey: "${ACTOR0_TEST_KEY}" },
      });
      assert.equal(provider.apiKey, "sk-from-env", "the placeholder must be substituted");
      assert.equal(provider.apiKeySource, "config.json", "and the source is the file, not the shell");

      // An unset variable must not become an empty credential: `Bearer ` is
      // authenticated as nobody and comes back as a 401 that reads like a
      // model problem.
      assert.throws(
        () =>
          resolveProvider({
            model: "m",
            models: [],
            provider: { baseUrl: "https://api.example.com/v1", apiKey: "${ACTOR0_DEFINITELY_UNSET}" },
          }),
        /ACTOR0_DEFINITELY_UNSET/,
        "the error has to name the variable that is not set",
      );
    } finally {
      if (previous === undefined) delete process.env.ACTOR0_TEST_KEY;
      else process.env.ACTOR0_TEST_KEY = previous;
    }
  });
});

test("ACTOR0_BASE_URL points a run at an endpoint with no config file at all", () => {
  // How a CI job or a benchmark run reaches a gateway: the environment, not a
  // file that may not exist and cannot be edited. A shell that cannot win is a
  // shell that cannot recover from a stale config.
  withConfigDir(() => {
    const previous = process.env.ACTOR0_BASE_URL;
    process.env.ACTOR0_BASE_URL = "https://gateway.test/v1";
    try {
      const provider = resolveProvider({ model: "m", models: [] });
      assert.equal(provider.baseUrl, "https://gateway.test/v1");
      assert.equal(
        endpointUrl(provider),
        "https://gateway.test/v1/chat/completions",
        "the OpenAI default, appended to whatever prefix the base URL carries",
      );
    } finally {
      if (previous === undefined) delete process.env.ACTOR0_BASE_URL;
      else process.env.ACTOR0_BASE_URL = previous;
    }
  });
});

test("a base URL that is not a URL is rejected before the first request", () => {
  withConfigDir(() => {
    assert.throws(
      () => resolveProvider({ model: "m", models: [], provider: { baseUrl: "not a url" } }),
      /not a URL/,
      "a typo must be a message, not a request to somewhere unexpected",
    );
    assert.throws(
      () => resolveProvider({ model: "m", models: [], provider: { baseUrl: "ftp://host/v1" } }),
      /http or https/,
    );
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
    saveConfig(withModel({ model: MODEL, models: [] }, "some/other-model"));
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

test("a gateway served from a path prefix keeps its prefix", () => {
  // Found by pointing this at the first real gateway it was given:
  // `https://api.kilo.ai/api/gateway/v1` produced a request to
  // `https://api.kilo.ai/chat/completions` — the prefix silently gone. The
  // cause was a default of `/chat/completions`, which the transport treats as
  // a *replacement* for the whole pathname rather than something to append.
  withConfigDir(() => {
    const previous = process.env.ACTOR0_BASE_URL;
    process.env.ACTOR0_BASE_URL = "https://api.kilo.ai/api/gateway/v1";
    try {
      const provider = resolveProvider({ model: "m", models: [] });
      assert.equal(provider.path, undefined, "no path may be invented for an OpenAI-compatible endpoint");
      assert.equal(endpointUrl(provider), "https://api.kilo.ai/api/gateway/v1/chat/completions", "the prefix must survive");

      process.env.ACTOR0_BASE_URL = "https://api.example.com/v1/";
      const trailing = resolveProvider({ model: "m", models: [] });
      assert.equal(endpointUrl(trailing), "https://api.example.com/v1/chat/completions");

      process.env.ACTOR0_PATH = "/v9/custom";
      const explicit = resolveProvider({ model: "m", models: [] });
      assert.equal(endpointUrl(explicit), "https://api.example.com/v9/custom");
    } finally {
      delete process.env.ACTOR0_PATH;
      if (previous === undefined) delete process.env.ACTOR0_BASE_URL;
      else process.env.ACTOR0_BASE_URL = previous;
    }
  });
});

// --- The provider registry `/provider` manages ---------------------------------
//
// A named list plus an active pointer. The properties these pin are the ones
// that would be silent drift if they broke: migration must not re-route an
// existing request, and a stale pointer must resolve to nothing configured
// rather than quietly to some other endpoint.

test("a name is derived from the host, not the whole URL", () => {
  assert.equal(providerName("https://api.example.com/v1"), "api.example.com");
  assert.equal(providerName("https://www.example.com"), "example.com", "www. is dropped");
  assert.equal(providerName("http://localhost:11434"), "localhost:11434", "the port is part of the name");
});

test("a legacy single provider migrates to a one-element list, in memory only", () => {
  // Reading must not rewrite the file — a config whose owner never opens the
  // menu has to keep behaving exactly as before. The list is a projection; the
  // file is only rewritten on the next save.
  withConfigDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ provider: { baseUrl: "https://publicai.co/v1", model: "m-1" }, models: [] }),
    );
    const before = readFileSync(join(dir, "config.json"), "utf8");
    const config = readConfigFile();
    assert.deepEqual(namedProviders(config).map((p) => p.name), ["publicai.co"]);
    assert.equal(config.activeProvider, "publicai.co");
    assert.equal(config.provider, undefined, "the legacy field is projected away, not carried alongside");
    assert.equal(readFileSync(join(dir, "config.json"), "utf8"), before, "reading must not touch the file");
  });
});

test("a migrated provider still resolves to the same endpoint", () => {
  // The whole point of migration: the request does not move. Same host, same
  // model, same transport.
  withConfigDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ provider: { baseUrl: "https://publicai.co/v1", model: "m-1" }, models: [] }),
    );
    const provider = resolveProvider(readConfigFile());
    assert.equal(provider.baseUrl, "https://publicai.co/v1");
    assert.equal(provider.model, "m-1");
    assert.equal(provider.transport, "openai");
  });
});

test("adding a provider registers it, makes it active, and de-duplicates the name", () => {
  let config: CliConfig = { model: MODEL, models: [] };
  config = addProvider(config, { baseUrl: "https://a.example.com/v1", model: "m-a" });
  assert.deepEqual(namedProviders(config).map((p) => p.name), ["a.example.com"]);
  assert.equal(config.activeProvider, "a.example.com");
  assert.equal(activeNamedProvider(config)?.model, "m-a");

  // Same host, different key: the name collides, so the second is suffixed
  // rather than silently replacing the first.
  config = addProvider(config, { baseUrl: "https://a.example.com/v1", apiKey: "sk-2" });
  assert.deepEqual(namedProviders(config).map((p) => p.name), ["a.example.com", "a.example.com-2"]);
});

test("switching providers moves the active pointer and changes what resolves", () => {
  let config = addProvider({ model: MODEL, models: [] }, { baseUrl: "https://a.example.com/v1", model: "m-a" });
  config = addProvider(config, { baseUrl: "https://b.example.com/v1", model: "m-b" });
  assert.equal(activeNamedProvider(config)?.model, "m-b", "the newest add is active");

  config = setActiveProvider(config, "a.example.com");
  assert.equal(config.activeProvider, "a.example.com");
  assert.equal(resolveProvider(config).baseUrl, "https://a.example.com/v1");

  // An unknown name is a no-op, not a switch to nothing.
  const unchanged = setActiveProvider(config, "nope.example.com");
  assert.equal(unchanged.activeProvider, "a.example.com");
});

test("removing the active provider re-points to a survivor, and the last leaves nothing configured", () => {
  let config = addProvider({ model: MODEL, models: [] }, { baseUrl: "https://a.example.com/v1", model: "m-a" });
  config = addProvider(config, { baseUrl: "https://b.example.com/v1", model: "m-b" });
  // b is active; remove it and a stands in.
  config = removeProvider(config, "b.example.com");
  assert.deepEqual(namedProviders(config).map((p) => p.name), ["a.example.com"]);
  assert.equal(config.activeProvider, "a.example.com", "a survivor takes over");

  // Remove the last one and there is nothing configured — BYOK, so no built-in.
  config = removeProvider(config, "a.example.com");
  assert.deepEqual(namedProviders(config), []);
  assert.throws(() => resolveProvider(config), /No provider is configured/);
});

test("a model set while a named provider is active is recorded on that provider", () => {
  // The drift guard: the model must live on the endpoint it was chosen for, so
  // switching endpoints cannot carry a name across that the new one lacks.
  let config = addProvider({ model: MODEL, models: [] }, { baseUrl: "https://a.example.com/v1" });
  config = withModel(config, "chosen-for-a");
  assert.equal(activeNamedProvider(config)?.model, "chosen-for-a");
  assert.equal(resolveProvider(config).model, "chosen-for-a");
});

test("a stale active pointer resolves to nothing, not to some other endpoint", () => {
  // A pointer naming a provider no longer in the list is only reachable by
  // hand-editing (`removeProvider` re-points). It must not silently route to a
  // different registered endpoint — guessing is the misroute this module exists
  // to prevent — so it resolves to nothing configured.
  const config: CliConfig = {
    model: "m",
    models: [],
    providers: [{ name: "only.example.com", baseUrl: "https://only.example.com/v1", model: "m-1" }],
    activeProvider: "deleted.example.com",
  };
  assert.equal(activeNamedProvider(config), undefined);
  assert.throws(() => resolveProvider(config), /No provider is configured/);
});

test("a registered list round-trips through disk and stays the only shape", () => {
  // Saving must never write both a legacy `provider` and a `providers` list —
  // two sources for one endpoint is the drift this module exists to prevent.
  withConfigDir((dir) => {
    let config = addProvider({ model: MODEL, models: [] }, { baseUrl: "https://a.example.com/v1", model: "m-a" });
    config = addProvider(config, { baseUrl: "https://b.example.com/v1", model: "m-b" });
    saveConfig(config);
    const raw = readFileSync(join(dir, "config.json"), "utf8");
    assert.ok(!raw.includes('"provider"'), `the legacy field must not be written alongside the list: ${raw}`);

    const reloaded = readConfigFile();
    assert.deepEqual(namedProviders(reloaded).map((p) => p.name), ["a.example.com", "b.example.com"]);
    assert.equal(reloaded.activeProvider, "b.example.com");
    assert.equal(resolveProvider(reloaded).baseUrl, "https://b.example.com/v1");
  });
});

test("oauth tokens round-trip on a provider", () => {
  withConfigDir(() => {
    const config = addProvider(
      { model: MODEL, models: [] },
      {
        name: "claude",
        baseUrl: "https://api.anthropic.com",
        transport: "anthropic",
        auth: "oauth",
        model: "claude-x",
        oauth: { accessToken: "AT", refreshToken: "RT", expiresAt: 123, accountId: "acct" },
      },
    );
    saveConfig(config);
    const reloaded = readConfigFile();
    const oauth = activeNamedProvider(reloaded)?.oauth;
    assert.equal(oauth?.accessToken, "AT", "the access token survives a save/load");
    assert.equal(oauth?.refreshToken, "RT");
    assert.equal(oauth?.accountId, "acct");
    assert.equal(resolveProvider(reloaded).transport, "anthropic");
    assert.equal(resolveProvider(reloaded).auth, "oauth");
  });
});

test("a stale activeProvider in the file resolves to nothing, not another endpoint", () => {
  // The reader must not guess `providers[0]` when the pointer names nothing —
  // that would silently re-route the session to a different host/credential.
  withConfigDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        model: "m",
        models: [],
        providers: [
          { name: "work", baseUrl: "https://work.example.com/v1", model: "mw" },
          { name: "personal", baseUrl: "https://personal.example.com/v1", model: "mp" },
        ],
        activeProvider: "deleted",
      }),
    );
    const config = readConfigFile();
    assert.equal(config.activeProvider, undefined, "a stale pointer is not guessed to another provider");
    assert.throws(() => resolveProvider(config), /No provider is configured/);
  });
});

test("duplicate provider names are de-duplicated on load", () => {
  // Two entries named the same collide on write, and withModel/withActiveOAuth
  // would map over both — copying one provider's model or tokens onto another.
  withConfigDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        model: "m",
        models: [],
        providers: [{ baseUrl: "https://x.example.com/v1" }, { baseUrl: "https://x.example.com/v1" }],
        activeProvider: "x.example.com",
      }),
    );
    assert.deepEqual(namedProviders(readConfigFile()).map((p) => p.name), ["x.example.com", "x.example.com-2"]);
  });
});

test("junk provider entries are dropped, not carried into the menu", () => {
  withConfigDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        model: "m",
        models: [],
        providers: [
          { baseUrl: "https://good.example.com/v1" },
          { name: "no-url" },
          "not an object",
          null,
          { baseUrl: "", name: "empty-url" },
        ],
        activeProvider: "good.example.com",
      }),
    );
    const config = readConfigFile();
    assert.deepEqual(namedProviders(config).map((p) => p.name), ["good.example.com"]);
  });
});
