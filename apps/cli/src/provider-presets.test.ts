import assert from "node:assert/strict";
import { test } from "node:test";
import { providerLabel } from "./provider-presets.js";
import { addProvider } from "./config.js";
import type { NamedProvider } from "./config.js";

/**
 * Readable provider labels — the whole point of recognising several BYOK
 * providers at a glance instead of reading URLs. The subscription plan is
 * dynamic (stored on the provider from the token/profile), never hardcoded here.
 */

const MODEL = "m";

const with_ = (entry: Parameters<typeof addProvider>[1]): NamedProvider => {
  const config = addProvider({ model: MODEL, models: [] }, entry);
  return config.providers![0]!;
};

test("Claude OAuth reads as a subscription, with the plan when known", () => {
  const base = { name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic" as const, auth: "oauth" as const, model: "claude-opus-4-6", oauth: { accessToken: "AT" } };
  assert.equal(providerLabel(with_(base)), "Claude Code - subscription", "no plan yet still reads");
  assert.equal(providerLabel(with_({ ...base, oauth: { accessToken: "AT", plan: "max" } })), "Claude Code - Max subscription");
  assert.equal(providerLabel(with_({ ...base, oauth: { accessToken: "AT", plan: "pro" } })), "Claude Code - Pro subscription");
});

test("Codex OAuth reads as a subscription with its plan", () => {
  const base = { name: "codex", baseUrl: "https://chatgpt.com/backend-api/codex", transport: "chatgpt" as const, auth: "oauth" as const, model: "gpt-5", oauth: { accessToken: "AT" } };
  assert.equal(providerLabel(with_(base)), "Codex - subscription");
  assert.equal(providerLabel(with_({ ...base, oauth: { accessToken: "AT", plan: "plus" } })), "Codex - Plus subscription");
  assert.equal(providerLabel(with_({ ...base, oauth: { accessToken: "AT", plan: "pro" } })), "Codex - Pro subscription");
});

test("Anthropic by API key reads as Direct, a cloud, or the host", () => {
  const key = { auth: "api-key" as const, apiKey: "k", model: "m" };
  assert.equal(providerLabel(with_({ name: "d", baseUrl: "https://api.anthropic.com", transport: "anthropic", ...key })), "Anthropic API - Direct");
  assert.equal(providerLabel(with_({ name: "v", baseUrl: "https://us-east5-aiplatform.googleapis.com/v1", transport: "anthropic", ...key })), "Anthropic API - Vertex");
  assert.equal(providerLabel(with_({ name: "b", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", transport: "anthropic", ...key })), "Anthropic API - Amazon Bedrock");
  assert.equal(providerLabel(with_({ name: "x", baseUrl: "https://proxy.example.com/anthropic", transport: "anthropic", ...key })), "Anthropic API - proxy.example.com");
});

test("OpenAI-compatible reads as the product when well-known, else the host", () => {
  assert.equal(providerLabel(with_({ name: "oai", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" })), "OpenAI API");
  assert.equal(providerLabel(with_({ name: "gw", baseUrl: "https://gateway.example.com/v1", apiKey: "k", model: "m" })), "gateway.example.com");
});
