import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHATGPT_OAUTH, accountIdFromIdToken, planFromIdToken } from "@actor0/providers";
import { Agent } from "./agent.js";
import { loadConfig, saveConfig } from "./config.js";
import { nodeBridge } from "./native/bridge.js";
import { oauthPresetFor, runSignIn, storeTokens } from "./oauth.js";
import { get } from "node:http";

/**
 * Sign-in, without a browser and without a network.
 *
 * The loopback redirect is the part that normally needs a human, so the opener is
 * injected and *performs the redirect itself* — and the token endpoint is a local
 * stub. Everything else is the real machinery: PKCE, the loopback server, state
 * validation, the code exchange, and the persistence.
 *
 * Two things are worth asserting beyond "it works":
 *
 *  - **The preset comes from `@actor0/providers`.** Those constants are evidence
 *    read off the installed CLIs, not configuration anyone can invent, and a host
 *    that kept its own copy is how they drift.
 *  - **The tokens land in the CLI's config format**, in the same file the terminal
 *    client reads, so a session signed in here works there.
 */

let dir: string;
let tokenServerUrl = "";
const envKeys = ["ACTOR0_CONFIG_DIR", "ACTOR0_DATA_DIR", "ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const tokenBodies: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "actor0-desktop-signin-"));
  for (const key of envKeys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ACTOR0_CONFIG_DIR = join(dir, "config");
  process.env.ACTOR0_DATA_DIR = join(dir, "data");

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      tokenBodies.push(body);
      const form = new URLSearchParams(body);
      // A refresh is answered with a new access token and no new refresh token,
      // which is the case the merge has to get right.
      const refresh = form.get("grant_type") === "refresh_token";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: refresh ? "access-fresh" : "access-1",
          ...(refresh ? { expires_in: 3_600 } : { refresh_token: "refresh-1", expires_in: 3_600 }),
          scope: "openid profile",
          id_token: `h.${Buffer.from(
            JSON.stringify({
              sub: "user-1",
              "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "plus" },
            }),
          ).toString("base64url")}.s`,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  tokenServerUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/oauth/token`;
  closeTokenServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The stub token server has to be closed or the test process never exits. */
let closeTokenServer: () => Promise<void> = async () => {};

after(async () => {
  await closeTokenServer();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Perform the redirect the flow registered, with a code and the state it sent. */
function redirectingOpener(hit: string[]): (url: string) => boolean {
  return (url) => {
    hit.push(url);
    const parsed = new URL(url);
    // The security params must be what the flow sent: a preset that could set
    // them itself is the reason the authorize URL builds extras first.
    const redirect = parsed.searchParams.get("redirect_uri")!;
    const state = parsed.searchParams.get("state")!;
    const callback = new URL(redirect);
    callback.searchParams.set("code", "code-from-provider");
    callback.searchParams.set("state", state);
    setImmediate(() => {
      void get(`http://${callback.host}${callback.pathname}${callback.search}`).on("error", () => undefined);
    });
    return true;
  };
}

describe("the preset this host uses", () => {
  it("signs in against the ChatGPT preset from @actor0/providers, not a local copy", () => {
    assert.equal(oauthPresetFor({ auth: "oauth", transport: "chatgpt" }), CHATGPT_OAUTH);
    assert.equal(CHATGPT_OAUTH.clientId, "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(oauthPresetFor({ auth: "oauth", transport: "anthropic" })?.clientId, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    assert.equal(oauthPresetFor({ auth: "api-key", transport: "openai" }), undefined);
  });
});

describe("the authorize request", () => {
  it("carries PKCE, the preset's scopes and extras, and lets the security params win", async () => {
    const opened: string[] = [];
    const result = await runSignIn(
      // The authorize URL stays the real one — asserting it is the point of this
      // test — while the *token* endpoint is the local stub, so the exchange
      // never leaves the machine.
      { ...CHATGPT_OAUTH, tokenUrl: tokenServerUrl },
      { openBrowser: redirectingOpener(opened) },
    );

    // The redirect was caught and the code exchanged.
    assert.equal(result.tokens.accessToken, "access-1");
    assert.equal(result.opened, true);

    const authorize = new URL(opened[0]!);
    assert.equal(authorize.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorize.searchParams.get("code_challenge"));
    assert.ok(authorize.searchParams.get("state"));
    assert.equal(authorize.searchParams.get("originator"), "codex_cli_rs");
    assert.equal(authorize.searchParams.get("id_token_add_organizations"), "true");
    assert.ok(authorize.searchParams.get("scope")!.includes("offline_access"));

    // The redirect URI is a loopback, on the port the preset registered.
    const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
    assert.equal(redirect.hostname, "localhost");
    assert.equal(redirect.port, "1455");
    assert.equal(redirect.pathname, "/auth/callback");

    // The exchange used the same redirect URI and a verifier, and only the
    // provider's own error would be surfaced on failure.
    const exchange = new URLSearchParams(tokenBodies[tokenBodies.length - 1]!);
    assert.equal(exchange.get("grant_type"), "authorization_code");
    assert.equal(exchange.get("code"), "code-from-provider");
    assert.ok(exchange.get("code_verifier"));
    assert.equal(exchange.get("redirect_uri"), redirect.toString());

    // The account id and plan were read out of the id token, because the ChatGPT
    // transport needs the account id as a header.
    assert.equal(result.tokens.accountId, "acct-123");
    assert.equal(result.tokens.plan, "plus");
  });
});

describe("storing the tokens", () => {
  it("writes them into the CLI's config format, on the active provider", () => {
    saveConfig({
      model: "",
      models: [],
      providers: [
        { name: "chatgpt", baseUrl: "https://chatgpt.com/backend-api/codex", transport: "chatgpt", auth: "oauth" },
      ],
      activeProvider: "chatgpt",
    });
    storeTokens({ accessToken: "at-1", refreshToken: "rt-1", accountId: "acct-123", plan: "plus" });

    const config = loadConfig();
    assert.equal(config.activeProvider, "chatgpt");
    const provider = config.providers?.[0];
    assert.equal(provider?.auth, "oauth");
    assert.equal(provider?.transport, "chatgpt");
    assert.equal(provider?.oauth?.accessToken, "at-1");
    assert.equal(provider?.oauth?.refreshToken, "rt-1");
    assert.equal(provider?.oauth?.accountId, "acct-123");
    assert.equal(provider?.oauth?.plan, "plus");
  });

  it("refuses to store tokens when no provider is active, rather than losing them", () => {
    saveConfig({ model: "", models: [] });
    assert.throws(() => storeTokens({ accessToken: "at-2" }), /no provider is active/);
  });
});

describe("the agent's sign-in method", () => {
  it("registers, stores and activates the ChatGPT provider in one step", async () => {
    saveConfig({ model: "", models: [] });
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0" });
    // The real preset's authorize URL is unreachable from a test, so the flow is
    // pointed at the stub: everything after the redirect is the real machinery.
    (agent as unknown as { browserOpener: (url: string) => boolean }).browserOpener = redirectingOpener([]);

    const kinds = await agent["provider.kinds"]();
    assert.deepEqual(kinds.map((kind) => kind.kind), ["chatgpt", "claude"]);
    assert.equal(kinds[0]!.auth[0], "oauth");

    // A kind that does not exist is refused by name, not defaulted.
    const missing = await agent["provider.signIn"]({ kind: "nope" });
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.message : "", /no sign-in flow named "nope"/);

    agent.dispose();
  });
});

describe("reading the id token", () => {
  it("returns undefined for anything that is not a JWT rather than throwing", () => {
    assert.equal(accountIdFromIdToken("not-a-jwt"), undefined);
    assert.equal(planFromIdToken("a.b"), undefined);
  });
});