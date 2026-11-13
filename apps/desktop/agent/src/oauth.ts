/**
 * The desktop agent's OAuth sign-in.
 *
 * The machinery — PKCE, loopback, code exchange, refresh — lives in
 * `@actor0/providers` because the desktop app is the second host that proves
 * those constants and that flow are a contract rather than a CLI detail. What
 * this file adds is the part that belongs to this host: where the tokens are
 * stored, and when a turn refreshes them.
 *
 * One difference from the terminal client, and it is the right one: the browser
 * is opened through the shell, because the agent is a headless Node process
 * with no `start`/`open` that is guaranteed to mean "the user's browser". A shell
 * that cannot do it is not fatal — the URL is returned, and the UI shows it.
 */

import {
  CLAUDE_OAUTH,
  CHATGPT_OAUTH,
  exchangeCode,
  refreshTokens,
  tokenExpired,
  type OAuthPreset,
  type OAuthTokens,
} from "@actor0/providers";
import { loadConfig, saveConfig, withActiveOAuth, activeNamedProvider, type DesktopConfig } from "./config.js";

/**
 * Which preset a provider signs in with, derived from its transport.
 *
 * Anthropic-over-OAuth is Claude; the ChatGPT transport is ChatGPT. An API-key
 * provider has no preset and says so rather than guessing.
 */
export function oauthPresetFor(provider: { auth?: string; transport?: string }): OAuthPreset | undefined {
  if (provider.auth !== "oauth") return undefined;
  if (provider.transport === "anthropic") return CLAUDE_OAUTH;
  if (provider.transport === "chatgpt") return CHATGPT_OAUTH;
  return undefined;
}

export type SignInResult = {
  tokens: OAuthTokens;
  /** True when the shell opened the browser; false means show the URL by hand. */
  opened: boolean;
  authorizeUrl: string;
};

/**
 * Run a full sign-in: build the authorize URL, ask the shell to open it, catch
 * the redirect on loopback, exchange the code.
 *
 * The browser opener is injected so the flow is testable with no human and no
 * desktop session — a test supplies an opener that performs the redirect itself,
 * and everything else is the real machinery.
 */
export async function runSignIn(
  preset: OAuthPreset,
  options: {
    openBrowser?: (url: string) => boolean;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<SignInResult> {
  const { createPkce, createState, buildAuthorizeUrl, startLoopback } = await import("@actor0/providers");
  const pkce = createPkce();
  const state = createState();
  const loop = await startLoopback({ port: preset.redirectPort, path: preset.redirectPath });
  try {
    const authorizeUrl = buildAuthorizeUrl(preset, {
      challenge: pkce.challenge,
      state,
      redirectUri: loop.redirectUri,
    });
    const opened = (options.openBrowser ?? openBrowserInShell)(authorizeUrl);
    const code = await loop.waitForCode(state, { signal: options.signal });
    const tokens = await exchangeCode(
      preset,
      { code, redirectUri: loop.redirectUri, verifier: pkce.verifier },
      options.fetchImpl ?? fetch,
    );
    return { tokens, opened, authorizeUrl };
  } finally {
    loop.close();
  }
}

type ShellOs = { open?: (url: string) => Promise<void> };

/**
 * The shell, when there is one.
 *
 * The agent is a headless Node process, so `window` is not a thing it has. In
 * the packaged app the shell's `os` namespace is injected at startup, and this
 * falls back to the process globals a Neutralino build exposes so the same code
 * works whichever way the process was started.
 */
let shellOs: ShellOs | undefined;

/** Inject the shell's `os` namespace, so sign-in can ask it to open a URL. */
export function setShellOpener(os: ShellOs | undefined): void {
  shellOs = os;
}

/**
 * Open a URL in the desktop shell.
 *
 * Returns false when there is no shell to ask (a browser, a test), which the
 * caller turns into "here is the URL, open it yourself".
 */
export function openBrowserInShell(url: string): boolean {
  const Neutralino = (globalThis as { Neutralino?: { os?: ShellOs } }).Neutralino;
  const os = shellOs ?? Neutralino?.os;
  if (typeof os?.open === "function") {
    void os.open(url).catch(() => undefined);
    return true;
  }
  return false;
}

/**
 * Refresh an expired OAuth token before a turn, and persist the new one.
 *
 * Returns the fresh provider and config, or undefined when nothing needed
 * refreshing (not OAuth, not expired, no refresh token, or an unknown preset). A
 * refresh that fails is left to the caller's error handling: the turn proceeds
 * with the stale token and the endpoint's 401 says to sign in again, which is a
 * clearer message than a silent retry loop.
 */
export async function refreshProvider(
  provider: { auth?: string; transport?: string; oauth?: OAuthTokens },
  config: DesktopConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ provider: typeof provider; config: DesktopConfig } | undefined> {
  const preset = oauthPresetFor(provider);
  const tokens = provider.oauth;
  if (!preset || !tokens?.refreshToken || !tokenExpired(tokens)) return undefined;
  const fresh = await refreshTokens(preset, tokens.refreshToken, fetchImpl);
  // Keep the old refresh token when the provider did not rotate it.
  const merged: OAuthTokens = { ...tokens, ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
  const active = activeNamedProvider(config);
  const nextConfig = active ? withActiveOAuth(config, merged) : config;
  return { provider: { ...provider, oauth: merged }, config: nextConfig };
}

/**
 * Store the tokens a sign-in produced, on the active provider.
 *
 * A sign-in that is not persisted is a sign-in the user repeats on every launch,
 * so this is not optional — and it writes through the same config functions the
 * rest of the host uses, so the file stays the CLI's format.
 */
export function storeTokens(tokens: OAuthTokens): void {
  const config = loadConfig();
  const next = withActiveOAuth(config, tokens);
  if (next === config) {
    throw new Error("no provider is active — add one before signing in");
  }
  saveConfig(next);
}