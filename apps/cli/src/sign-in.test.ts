import assert from "node:assert/strict";
import { test } from "node:test";
import { get } from "node:http";
import { oauthPresetFor, refreshProvider, runOAuthSignIn } from "./sign-in.js";
import { CLAUDE_OAUTH, CHATGPT_OAUTH } from "./provider-presets.js";
import { addProvider, type CliConfig, type ResolvedProvider } from "./config.js";
import type { OAuthTokens } from "./oauth.js";

/**
 * The sign-in orchestration, driven without a browser: the injected
 * `openBrowser` reads the redirect URI and state out of the authorize URL and
 * fires the redirect itself, so the loopback, state check, and token exchange
 * all run for real.
 */

const jsonFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
/** Simulate the browser following the redirect the provider would send. */
function simulateBrowser(): (url: string) => void {
  return (authorizeUrl: string) => {
    const url = new URL(authorizeUrl);
    const redirect = url.searchParams.get("redirect_uri")!;
    const state = url.searchParams.get("state")!;
    setTimeout(() => {
      get(`${redirect}?code=THE_CODE&state=${state}`, (res) => {
        res.resume();
      });
    }, 10);
  };
}

test("a Claude sign-in exchanges the code for tokens end to end", async () => {
  const tokens = await runOAuthSignIn(CLAUDE_OAUTH, {
    openBrowser: simulateBrowser(),
    fetchImpl: jsonFetch({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "user:inference" }),
  });
  assert.equal(tokens.accessToken, "AT");
  assert.equal(tokens.refreshToken, "RT");
  assert.equal(tokens.scope, "user:inference");
});

test("a ChatGPT sign-in uses the fixed loopback port and captures the account id", async () => {
  const idToken = (() => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "RS256" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })}.sig`;
  })();
  const tokens: OAuthTokens = await runOAuthSignIn(CHATGPT_OAUTH, {
    openBrowser: simulateBrowser(),
    fetchImpl: jsonFetch({ access_token: "AT", id_token: idToken, expires_in: 3600 }),
  });
  assert.equal(tokens.accessToken, "AT");
  assert.equal(tokens.accountId, "acct-1", "the account id is lifted from the id token for the request header");
});

// --- Token refresh ------------------------------------------------------------

const expiredClaude = (): { provider: ResolvedProvider; config: CliConfig } => {
  const oauth: OAuthTokens = { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 60_000 };
  const config = addProvider(
    { model: "", models: [] },
    { name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "oauth", model: "claude-x", oauth },
  );
  const provider: ResolvedProvider = { baseUrl: "https://api.anthropic.com", model: "claude-x", transport: "anthropic", auth: "oauth", oauth };
  return { provider, config };
};

test("an expired OAuth token is refreshed and persisted on the active provider", async () => {
  const { provider, config } = expiredClaude();
  const result = await refreshProvider(provider, config, jsonFetch({ access_token: "NEW", refresh_token: "RT2", expires_in: 3600 }));
  assert.equal(result?.provider.oauth?.accessToken, "NEW", "the fresh token is returned for this turn");
  // And it is written back to the active provider so the next turn does not refetch.
  const stored = result?.config.providers?.find((p) => p.name === "claude")?.oauth;
  assert.equal(stored?.accessToken, "NEW");
  assert.equal(stored?.refreshToken, "RT2");
});

test("a refresh that does not rotate the token keeps the old refresh token", async () => {
  const { provider, config } = expiredClaude();
  const result = await refreshProvider(provider, config, jsonFetch({ access_token: "NEW", expires_in: 3600 }));
  assert.equal(result?.provider.oauth?.refreshToken, "RT", "the original refresh token survives");
});

test("a token that is not expired is not refreshed", async () => {
  const oauth: OAuthTokens = { accessToken: "OK", refreshToken: "RT", expiresAt: Date.now() + 3_600_000 };
  const provider: ResolvedProvider = { baseUrl: "https://api.anthropic.com", model: "m", transport: "anthropic", auth: "oauth", oauth };
  const config = addProvider({ model: "", models: [] }, { name: "claude", baseUrl: "https://api.anthropic.com", transport: "anthropic", auth: "oauth", oauth });
  assert.equal(await refreshProvider(provider, config, jsonFetch({ access_token: "NEW" })), undefined);
});

test("an api-key provider has no preset and is never refreshed", async () => {
  const provider: ResolvedProvider = { baseUrl: "https://api.example.com/v1", model: "m", transport: "openai", auth: "api-key", apiKey: "k" };
  assert.equal(oauthPresetFor(provider), undefined);
});

test("the preset is derived from the transport", () => {
  const claude: ResolvedProvider = { baseUrl: "x", model: "m", transport: "anthropic", auth: "oauth", oauth: { accessToken: "a" } };
  const chatgpt: ResolvedProvider = { baseUrl: "x", model: "m", transport: "chatgpt", auth: "oauth", oauth: { accessToken: "a" } };
  assert.equal(oauthPresetFor(claude), CLAUDE_OAUTH);
  assert.equal(oauthPresetFor(chatgpt), CHATGPT_OAUTH);
});
