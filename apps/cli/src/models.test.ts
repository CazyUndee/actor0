import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModels, modelsHeaders, modelsUrl } from "./models.js";
import type { ResolvedProvider } from "./config.js";

/** Model discovery, tested with a mock fetch. OpenAI and Anthropic share a shape. */

const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

const openai: ResolvedProvider = { baseUrl: "https://api.openai.com/v1", model: "m", transport: "openai", auth: "api-key", apiKey: "sk" };
const anthropicKey: ResolvedProvider = { baseUrl: "https://api.anthropic.com", model: "m", transport: "anthropic", auth: "api-key", apiKey: "sk-ant" };

test("OpenAI models come back as ids from the data array", async () => {
  const models = await fetchModels(openai, jsonFetch({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }));
  assert.deepEqual(models, ["gpt-4o", "gpt-4o-mini"]);
});

test("Anthropic models share the same data[].id shape", async () => {
  const models = await fetchModels(anthropicKey, jsonFetch({ data: [{ id: "claude-3-5-sonnet" }, { id: "claude-3-opus" }] }));
  assert.deepEqual(models, ["claude-3-5-sonnet", "claude-3-opus"]);
});

test("duplicates are dropped and order is preserved", async () => {
  const models = await fetchModels(openai, jsonFetch({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] }));
  assert.deepEqual(models, ["a", "b"]);
});

test("a non-OK listing throws naming the URL", async () => {
  await assert.rejects(() => fetchModels(openai, jsonFetch({ error: "nope" }, 403)), /could not list models.*403/);
});

test("an unreadable body is an empty list, not a dead-end", async () => {
  const models = await fetchModels(openai, jsonFetch({ unexpected: true }));
  assert.deepEqual(models, []);
});

test("the models URL appends to the base for each transport", () => {
  assert.equal(modelsUrl(openai), "https://api.openai.com/v1/models");
  assert.equal(modelsUrl(anthropicKey), "https://api.anthropic.com/v1/models");
  // A gateway on a prefix keeps it.
  assert.equal(modelsUrl({ ...openai, baseUrl: "https://gw.example.com/api/v1" }), "https://gw.example.com/api/v1/models");
});

test("auth headers match the transport and auth kind", () => {
  assert.equal(modelsHeaders(openai).Authorization, "Bearer sk");
  assert.equal(modelsHeaders(anthropicKey)["x-api-key"], "sk-ant");
  assert.equal(modelsHeaders(anthropicKey)["anthropic-version"].length > 0, true);
  const oauth: ResolvedProvider = {
    baseUrl: "https://api.anthropic.com",
    model: "m",
    transport: "anthropic",
    auth: "oauth",
    oauth: { accessToken: "AT" },
  };
  assert.equal(modelsHeaders(oauth).Authorization, "Bearer AT");
  assert.equal(modelsHeaders(oauth)["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(modelsHeaders(oauth)["x-api-key"], undefined, "OAuth must not also send an api key");
});
