import assert from "node:assert/strict";
import { test } from "node:test";
import { get } from "node:http";
import {
  accountIdFromIdToken,
  buildAuthorizeUrl,
  createPkce,
  createState,
  decodeJwtPayload,
  exchangeCode,
  planFromIdToken,
  refreshTokens,
  startLoopback,
  tokenExpired,
  type OAuthPreset,
  type OAuthTokens,
} from "./oauth.js";

/**
 * The OAuth machinery. The pieces that can be checked without a browser are
 * checked here: PKCE is well-formed, the authorize URL carries every parameter
 * the flow depends on, the loopback captures a code and rejects a wrong state,
 * the token exchange parses a real response, and a JWT yields the account id
 * ChatGPT needs. The browser hop itself is the one part only a human exercises.
 */

const preset: OAuthPreset = {
  authorizeUrl: "https://auth.example.com/oauth/authorize",
  tokenUrl: "https://auth.example.com/oauth/token",
  clientId: "client-123",
  scopes: ["openid", "profile", "offline_access"],
  redirectPath: "/callback",
};

test("PKCE is a verifier, an S256 challenge of it, and never the same twice", () => {
  const a = createPkce();
  const b = createPkce();
  assert.equal(a.method, "S256");
  assert.ok(a.verifier.length >= 43, "verifier is long enough to be unguessable");
  assert.notEqual(a.verifier, a.challenge, "the challenge is not the verifier");
  assert.notEqual(a.verifier, b.verifier, "each call is fresh");
  // The challenge must be the SHA-256 of the verifier — that is what the server
  // recomputes. base64url of a 32-byte digest is 43 chars.
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
});

test("the authorize URL carries every parameter the flow depends on", () => {
  const url = new URL(
    buildAuthorizeUrl(preset, { challenge: "CHAL", state: "ST", redirectUri: "http://localhost:9999/callback" }),
  );
  assert.equal(url.origin + url.pathname, preset.authorizeUrl);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:9999/callback");
  assert.equal(url.searchParams.get("scope"), "openid profile offline_access");
  assert.equal(url.searchParams.get("state"), "ST");
  assert.equal(url.searchParams.get("code_challenge"), "CHAL");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("extra authorize params are appended", () => {
  const url = buildAuthorizeUrl(
    { ...preset, extraAuthorizeParams: { audience: "api", originator: "actor0" } },
    { challenge: "c", state: "s", redirectUri: "http://localhost:1/callback" },
  );
  assert.equal(new URL(url).searchParams.get("originator"), "actor0");
});

test("the loopback captures the code from the redirect", async () => {
  const loop = await startLoopback({ path: "/callback" });
  try {
    const port = new URL(loop.redirectUri).port;
    const waiting = loop.waitForCode("state-1");
    // Hit the loopback the way a browser would after the provider redirects.
    await new Promise<void>((resolve, reject) => {
      get(`http://localhost:${port}/callback?code=THE_CODE&state=state-1`, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });
    assert.equal(await waiting, "THE_CODE");
  } finally {
    loop.close();
  }
});

test("the loopback rejects a redirect whose state does not match", async () => {
  const loop = await startLoopback({ path: "/callback" });
  try {
    const port = new URL(loop.redirectUri).port;
    const waiting = loop.waitForCode("expected").then(
      () => "resolved",
      (error: Error) => `rejected: ${error.message}`,
    );
    await new Promise<void>((resolve, reject) => {
      get(`http://localhost:${port}/callback?code=X&state=attacker`, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });
    assert.match(await waiting, /rejected: .*state/i, "a mismatched state must not yield a code");
  } finally {
    loop.close();
  }
});

test("an aborted signal ends the wait instead of hanging", async () => {
  // A cancelled sign-in must end the wait so the loopback closes — otherwise a
  // fixed-port provider stays occupied for the next attempt.
  const loop = await startLoopback({ path: "/callback" });
  try {
    const controller = new AbortController();
    const waiting = loop.waitForCode("s", { signal: controller.signal }).then(
      () => "resolved",
      (error: Error) => `rejected: ${error.message}`,
    );
    controller.abort();
    assert.match(await waiting, /rejected: .*cancelled/i);
  } finally {
    loop.close();
  }
});

test("a short timeout ends the wait instead of hanging forever", async () => {
  const loop = await startLoopback({ path: "/callback" });
  try {
    const waiting = loop.waitForCode("s", { timeoutMs: 30 }).then(
      () => "resolved",
      (error: Error) => `rejected: ${error.message}`,
    );
    assert.match(await waiting, /rejected: .*timed out/i);
  } finally {
    loop.close();
  }
});

const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

test("exchanging a code parses tokens and computes expiry", async () => {
  const tokens = await exchangeCode(
    preset,
    { code: "CODE", redirectUri: "http://localhost:9/callback", verifier: "VER" },
    jsonFetch({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "openid profile", token_type: "Bearer" }),
  );
  assert.equal(tokens.accessToken, "AT");
  assert.equal(tokens.refreshToken, "RT");
  assert.equal(tokens.scope, "openid profile");
  assert.ok(tokens.expiresAt! > Date.now(), "expiresAt is in the future");
  assert.ok(tokens.expiresAt! <= Date.now() + 3600 * 1000 + 1000);
});

test("a refresh returns fresh tokens", async () => {
  const tokens = await refreshTokens(preset, "OLD_RT", jsonFetch({ access_token: "NEW_AT", expires_in: 60 }));
  assert.equal(tokens.accessToken, "NEW_AT");
});

test("a token endpoint error names the status", async () => {
  await assert.rejects(
    () => exchangeCode(preset, { code: "c", redirectUri: "http://localhost:9/callback", verifier: "v" }, jsonFetch({ error: "invalid_grant" }, 400)),
    /HTTP 400/,
  );
});

test("a token response with no access token is rejected", async () => {
  await assert.rejects(
    () => exchangeCode(preset, { code: "c", redirectUri: "http://localhost:9/callback", verifier: "v" }, jsonFetch({ token_type: "Bearer" })),
    /no access_token/,
  );
});

test("tokenExpired respects the skew window", () => {
  const fresh: OAuthTokens = { accessToken: "a", expiresAt: Date.now() + 10 * 60_000 };
  const nearly: OAuthTokens = { accessToken: "a", expiresAt: Date.now() + 10_000 };
  const none: OAuthTokens = { accessToken: "a" };
  assert.equal(tokenExpired(fresh), false);
  assert.equal(tokenExpired(nearly), true, "within the 60s skew it counts as expired");
  assert.equal(tokenExpired(none), false, "no expiry means it does not expire");
});

// A real-shaped ChatGPT id token: header.payload.signature, payload carrying the
// account id under the OpenAI auth claim.
const idToken = (() => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-abc" },
    email: "me@example.com",
  })}.sig`;
})();

test("the account id is read from the id token's OpenAI auth claim", () => {
  assert.equal(accountIdFromIdToken(idToken), "acct-abc");
  const claims = decodeJwtPayload(idToken);
  assert.equal(claims?.email, "me@example.com");
});

test("the plan is read from the id token's chatgpt_plan_type claim", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const withPlan = (plan: string) => `${b64({ alg: "RS256" })}.${b64({ "https://api.openai.com/auth": { chatgpt_plan_type: plan } })}.sig`;
  assert.equal(planFromIdToken(withPlan("plus")), "plus");
  assert.equal(planFromIdToken(withPlan("pro")), "pro");
  assert.equal(planFromIdToken(withPlan("free")), "free");
  assert.equal(planFromIdToken("garbage"), undefined);
});

test("a non-JWT decodes to undefined rather than throwing", () => {
  assert.equal(decodeJwtPayload("not-a-jwt"), undefined);
  assert.equal(decodeJwtPayload("a.b.c"), undefined);
  assert.equal(accountIdFromIdToken("garbage"), undefined);
});

test("state is random", () => {
  assert.notEqual(createState(), createState());
});
