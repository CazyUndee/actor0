import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeProvider,
  endpointUrl,
  loadConfig,
  readConfigFile,
  resolveProvider,
  saveConfig,
  withModel,
} from "./config.js";
import { RESPITE } from "./providers.js";

/**
 * Configuration.
 *
 * The endpoint is configurable again, and these tests pin what replaced the
 * four-level precedence this file used to describe — namely, that the
 * environment beats the file, that a stored endpoint is honoured rather than
 * ignored, and that both of those are visible when asked about.
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

test("a stored baseUrl is honoured, and reported as custom", () => {
  // The file that used to be ignored. It is honoured now, because refusing to
  // let a user point the CLI at their own endpoint is not a safety property,
  // it is a limitation — and the failure it was introduced to prevent (traffic
  // going to a host we have no credential for while everything on screen said
  // otherwise) is prevented by reporting the endpoint, not by forbidding it.
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
    assert.equal(provider.baseUrl, "https://publicai.co/v1", "the host is configurable again");
    assert.equal(provider.model, "swiss-ai/apertus-v1.5-70b");
    assert.equal(provider.custom, true, "and it is marked as not the built-in one");
  });
});

test("an endpoint with no credential says so, instead of looking configured", () => {
  // This is the failure the single-endpoint design was built to prevent: a
  // request goes to a host that wants a key we do not have, and every visible
  // signal says the setup is fine. `describeProvider` is the one place that
  // states the credential's actual presence, so it is pinned — including that
  // it never prints the credential, which is what makes it safe to screenshot.
  const described = describeProvider({
    baseUrl: "https://api.example.com/v1",
    path: "/chat/completions",
    model: "some-model",
    custom: true,
  });
  assert.ok(
    described.some((line) => /credential not set/.test(line)),
    `a missing key must be visible, got: ${described.join(" | ")}`,
  );
  assert.ok(
    described.some((line) => /api\.example\.com/.test(line)),
    "the host in play must be visible",
  );

  const withKey = describeProvider({
    baseUrl: "https://api.example.com/v1",
    path: "/chat/completions",
    model: "some-model",
    apiKey: "sk-live-abcdefghijklmnop",
    apiKeySource: "config.json",
    custom: true,
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
  withConfigDir(() => {
    const custom = withModel({ model: "", models: [], provider: { baseUrl: "https://api.example.com/v1" } }, "m-1");
    assert.equal(custom.provider?.model, "m-1", "a custom endpoint records the model on itself");
    assert.equal(custom.model, "", "and does not pretend the built-in one changed");

    const builtIn = withModel({ model: "", models: [] }, "m-2");
    assert.equal(builtIn.model, "m-2", "the built-in endpoint keeps the flat field");
  });
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
      assert.equal(provider.custom, true);
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

test("a gateway served from a path prefix keeps its prefix", () => {
  // Found by pointing this at the first real gateway it was given:
  // `https://api.kilo.ai/api/gateway/v1` produced a request to
  // `https://api.kilo.ai/chat/completions` — the prefix silently gone. The
  // cause was a default of `/chat/completions`, which the transport treats as
  // a *replacement* for the whole pathname rather than something to append.
  //
  // It is worth a test because most gateways sit at a root (`/v1`), so this
  // looks fine everywhere it is tried, and LiteLLM, vLLM behind a proxy and
  // anything under a tenant path are exactly the ones that break.
  withConfigDir(() => {
    const previous = process.env.ACTOR0_BASE_URL;
    process.env.ACTOR0_BASE_URL = "https://api.kilo.ai/api/gateway/v1";
    try {
      const provider = resolveProvider({ model: "m", models: [] });
      assert.equal(provider.path, undefined, "no path may be invented for a custom endpoint");
      assert.equal(
        endpointUrl(provider),
        "https://api.kilo.ai/api/gateway/v1/chat/completions",
        "the prefix must survive",
      );

      // A trailing slash must not produce a double slash.
      process.env.ACTOR0_BASE_URL = "https://api.example.com/v1/";
      const trailing = resolveProvider({ model: "m", models: [] });
      assert.equal(endpointUrl(trailing), "https://api.example.com/v1/chat/completions");

      // An explicit path still wins, and still replaces — that is the
      // documented override and the only reason to set it.
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

test("the built-in endpoint still reports the path it actually uses", () => {
  const provider = resolveProvider({ model: "m", models: [] });
  assert.equal(provider.custom, undefined);
  assert.equal(provider.path, "/api/chat");
  assert.equal(endpointUrl(provider), "https://aestral-chat.vercel.app/api/chat");
});
