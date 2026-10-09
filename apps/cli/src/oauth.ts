import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { execFile } from "node:child_process";

/**
 * Generic OAuth 2.0 + PKCE, for CLI sign-in.
 *
 * Nothing here knows about Claude or ChatGPT — those are presets (see
 * `provider-presets.ts`). This file is the machinery both need: a PKCE pair, an
 * authorize URL, a loopback server that catches the redirect, a code→token
 * exchange, a refresh, and the token shape stored on a provider.
 *
 * The loopback is the whole reason this is more than an HTTP call: a desktop
 * CLI cannot hold a client secret, so it authorizes in the user's browser and
 * catches the redirect on localhost. PKCE (S256) is what makes that safe
 * without a secret — the verifier never leaves the machine, and the challenge
 * in the authorize request is bound to it.
 *
 * The values that differ per provider (authorize URL, token URL, client id,
 * scopes, redirect port/path) were read off the installed `claude` and `codex`
 * CLIs, not invented; see `provider-presets.ts`.
 */

/** Everything a preset must name. Deliberately data, so a new provider is a literal. */
export type OAuthPreset = {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Fixed port the provider registered the redirect on, or omit for an OS-assigned one. */
  redirectPort?: number;
  /** Path of the registered redirect, e.g. `/callback` or `/auth/callback`. */
  redirectPath: string;
  /** Extra authorize/token params a provider wants (audience, resource, originator…). */
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
};

/** The tokens a sign-in produces, stored on the provider (0600 config). */
export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, when the provider said. */
  expiresAt?: number;
  scope?: string;
  idToken?: string;
  /** ChatGPT's account id, needed as a request header — decoded from the id token. */
  accountId?: string;
};

export type Pkce = { verifier: string; challenge: string; method: "S256" };

const base64url = (input: Buffer): string => input.toString("base64url");

/** A PKCE verifier/challenge pair (RFC 7636, S256). */
export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** A CSRF token to echo back through the redirect. */
export function createState(): string {
  return base64url(randomBytes(16));
}

/** The browser URL that starts the flow. */
export function buildAuthorizeUrl(
  preset: OAuthPreset,
  input: { challenge: string; state: string; redirectUri: string },
): string {
  const url = new URL(preset.authorizeUrl);
  // Extras first, security params last: a preset that accidentally names
  // `state`, `redirect_uri`, `client_id` or `code_challenge` must not be able to
  // disable CSRF or PKCE. The security params always win.
  for (const [key, value] of Object.entries(preset.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", preset.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", preset.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type LoopbackWait = { signal?: AbortSignal; timeoutMs?: number };

export type Loopback = {
  /** The exact redirect URI to register in the authorize request. */
  redirectUri: string;
  /** Resolves with the authorization code once a redirect with matching `state` lands. */
  waitForCode: (expectedState: string, options?: LoopbackWait) => Promise<string>;
  close: () => void;
};

/** How long a sign-in waits for the browser redirect before giving up. */
const LOOPBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Start a loopback server and wait for the provider's redirect.
 *
 * `state` is validated on arrival: a redirect whose state does not match the
 * one sent is rejected rather than exchanged, which is the CSRF protection the
 * `state` parameter exists for. The browser is answered with a page telling the
 * user they can close it, so a successful sign-in does not end on a dead tab.
 *
 * `waitForCode` takes a timeout and an abort signal, so a redirect that never
 * arrives — or a sign-in the user cancelled — ends the wait instead of hanging
 * with the port held open. Only the registered callback path is answered.
 */
export async function startLoopback(options: { port?: number; path?: string } = {}): Promise<Loopback> {
  const path = options.path ?? "/callback";
  let captured: { code: string; state: string | null } | null = null;
  let failed: string | undefined;
  let deferred: { resolve: (code: string) => void; reject: (error: Error) => void } | null = null;
  let expectedState: string | null = null;
  let settled = false;

  const settle = (): void => {
    if (settled || !deferred) return;
    if (failed) {
      settled = true;
      deferred.reject(new Error(failed));
      return;
    }
    if (!captured || expectedState === null) return;
    if (captured.state !== expectedState) {
      settled = true;
      deferred.reject(new Error("OAuth state did not match — the redirect was not the one this CLI started."));
      return;
    }
    settled = true;
    deferred.resolve(captured.code);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // Only the registered callback path is answered; anything else is a 404, so
    // an unrelated local probe is not told "signed in".
    if (url.pathname !== path) {
      res.writeHead(404);
      res.end();
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(successPage(Boolean(error) || !code));
    // A decline is remembered even if no one is waiting yet, so the later
    // `waitForCode` rejects with it rather than hanging on a `settled` flag that
    // was set with nothing to reject.
    if (error) {
      failed = `the provider declined the sign-in: ${error}`;
      settle();
      return;
    }
    if (!code) return;
    captured = { code, state };
    settle();
  });

  const port = await listenLoopback(server, options.port);
  const redirectUri = `http://localhost:${port}${path}`;

  return {
    redirectUri,
    waitForCode: (state, waitOptions = {}) => {
      expectedState = state;
      const code = new Promise<string>((resolve, reject) => {
        deferred = { resolve, reject };
        settle();
      });
      const guards: Promise<never>[] = [];
      const timer = setTimeout(() => {
        settled = true;
        deferred?.reject(new Error("the sign-in timed out — no redirect arrived"));
      }, waitOptions.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
      // Do not hold the process open for the timeout after a successful sign-in.
      timer.unref?.();
      guards.push(
        new Promise<never>((_resolve, reject) => {
          const signal = waitOptions.signal;
          if (!signal) return;
          const onAbort = () => {
            settled = true;
            reject(new Error("the sign-in was cancelled"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
      return Promise.race([code, ...guards]);
    },
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/**
 * Listen on loopback, preferring `localhost` and falling back to `127.0.0.1`.
 *
 * Binding a hostname resolves it once and binds a single address family, while
 * the browser resolves `localhost` independently and may pick the other — so a
 * server on IPv4 can miss a browser that connected over IPv6. Trying both
 * families covers that without binding off-loopback.
 */
async function listenLoopback(server: Server, port?: number): Promise<number> {
  let lastError: unknown;
  for (const host of ["localhost", "127.0.0.1"]) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown) => reject(error);
        server.once("error", onError);
        server.listen(port ?? 0, host, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      return (server.address() as AddressInfo).port;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not start the OAuth callback server on loopback: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function successPage(failed: boolean): string {
  const line = failed ? "Sign-in did not complete." : "Signed in. You can close this window.";
  return `<!doctype html><meta charset="utf-8"><title>actor0</title><body style="font-family:system-ui;padding:2rem">${line}</body>`;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(
  preset: OAuthPreset,
  input: { code: string; redirectUri: string; verifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    // Extras first so the grant params below always win — same rule as the
    // authorize URL.
    ...preset.extraTokenParams,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: preset.clientId,
    code_verifier: input.verifier,
  });
  return tokenRequest(preset.tokenUrl, form, fetchImpl);
}

/** Trade a refresh token for a fresh access token. */
export async function refreshTokens(
  preset: OAuthPreset,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    ...preset.extraTokenParams,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: preset.clientId,
  });
  return tokenRequest(preset.tokenUrl, form, fetchImpl);
}

async function tokenRequest(url: string, form: URLSearchParams, fetchImpl: typeof fetch): Promise<OAuthTokens> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    // Only the provider's own error field is surfaced, never the raw body: a
    // proxy that reflects the request in a 4xx would otherwise put the refresh
    // token on screen.
    const detail = tokenErrorDetail(text);
    throw new Error(`token request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`token endpoint returned a non-JSON body: ${summarize(text)}`);
  }
  const accessToken = typeof value.access_token === "string" ? value.access_token : undefined;
  if (!accessToken) throw new Error("token endpoint returned no access_token");
  const idToken = typeof value.id_token === "string" ? value.id_token : undefined;
  const expiresIn = typeof value.expires_in === "number" ? value.expires_in : undefined;
  return {
    accessToken,
    ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1_000 } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(idToken ? { idToken } : {}),
    // ChatGPT needs the account id as a request header; it rides in the id token.
    ...(idToken ? { accountId: accountIdFromIdToken(idToken) } : {}),
  };
}

function summarize(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed || "(empty body)";
}

/** The provider's own error text from a token response, and nothing else. */
function tokenErrorDetail(body: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  const record = value as { error?: unknown; error_description?: unknown };
  const error = record.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof record.error_description === "string" && record.error_description) return record.error_description;
  return undefined;
}

/** True when the stored access token is missing or within `skewMs` of expiring. */
export function tokenExpired(tokens: OAuthTokens, skewMs = 60_000): boolean {
  if (tokens.expiresAt === undefined) return false;
  return Date.now() + skewMs >= tokens.expiresAt;
}

/**
 * Decode a JWT payload without verifying it.
 *
 * Used only to read a non-secret claim the provider volunteers (ChatGPT's
 * account id). It is *not* authentication — the token was already obtained from
 * the token endpoint over TLS; this just avoids a second round trip to learn the
 * account id, and returns undefined for anything that is not a well-formed JWT.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const value = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** ChatGPT's account id from an id token, under either claim spelling. */
export function accountIdFromIdToken(idToken: string): string | undefined {
  const claims = decodeJwtPayload(idToken);
  const auth = claims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const accountId = auth?.chatgpt_account_id ?? claims?.chatgpt_account_id;
  return typeof accountId === "string" ? accountId : undefined;
}

/** Open a URL in the user's default browser, best-effort per platform. */
export function openBrowser(url: string): void {
  // An argv array, never a shell string: the URL is a distinct argument, so a
  // `"` or `&` in it cannot become shell syntax. On Windows `start` is a cmd
  // builtin, so it runs through `cmd /c` with the URL still a separate argv (the
  // empty string is `start`'s window-title slot).
  const swallow = (): void => {};
  if (process.platform === "win32") execFile("cmd", ["/c", "start", "", url], swallow);
  else if (process.platform === "darwin") execFile("open", [url], swallow);
  else execFile("xdg-open", [url], swallow);
  // A machine with no browser, or a headless one, must not crash the sign-in:
  // the caller prints the URL, so the flow still completes by hand.
}
