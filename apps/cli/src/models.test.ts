import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModels, fetchClaudePlan, fetchModelInfos, modelsHeaders, modelsUrl } from "./models.js";
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

test("Claude's plan is read from the OAuth profile's org type", async () => {
  const profile = (org?: string) =>
    (async () => new Response(JSON.stringify(org ? { organization: { organization_type: org } } : {}), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  assert.equal(await fetchClaudePlan("AT", profile("claude_max")), "max");
  assert.equal(await fetchClaudePlan("AT", profile("claude_pro")), "pro");
  assert.equal(await fetchClaudePlan("AT", profile("claude_team")), "team");
  assert.equal(await fetchClaudePlan("AT", profile("something_else")), undefined, "unknown org type is not guessed");
  assert.equal(await fetchClaudePlan("AT", profile()), undefined, "no org is not a plan");
});

test("a context window is read from whichever field the provider uses", async () => {
  const infos = await fetchModelInfos(openai, jsonFetch({ data: [
    { id: "a", context_length: 128000 },
    { id: "b", context_window: 200000 },
    { id: "c", max_context_tokens: 8192 },
    { id: "d" },
  ] }));
  assert.deepEqual(infos, [
    { id: "a", contextWindow: 128000 },
    { id: "b", contextWindow: 200000 },
    { id: "c", contextWindow: 8192 },
    { id: "d" },
  ], "a window is read under any spelling; an absent one is left undefined, not guessed");
});

test("a Claude plan fetch that fails is best-effort, not fatal", async () => {
  const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  assert.equal(await fetchClaudePlan("AT", failing), undefined);
  const thrown = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal(await fetchClaudePlan("AT", thrown), undefined);
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
