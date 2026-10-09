import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  openBrowser,
  refreshTokens,
  startLoopback,
  tokenExpired,
  type OAuthPreset,
  type OAuthTokens,
} from "./oauth.js";
import { CHATGPT_OAUTH, CLAUDE_OAUTH } from "./provider-presets.js";
import { activeNamedProvider, withActiveOAuth, type CliConfig, type ResolvedProvider } from "./config.js";

/**
 * Run a full OAuth sign-in: open the browser, catch the redirect on loopback,
 * exchange the code for tokens.
 *
 * The browser is injectable so the whole flow is testable without a human — a
 * test supplies an `openBrowser` that fires the redirect itself. Everything else
 * is the real machinery: PKCE, the loopback server, state validation, and the
 * token exchange.
 */
export async function runOAuthSignIn(
  preset: OAuthPreset,
  options: { openBrowser?: (url: string) => void; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<OAuthTokens> {
  const pkce = createPkce();
  const state = createState();
  const loop = await startLoopback({ port: preset.redirectPort, path: preset.redirectPath });
  try {
    const authorizeUrl = buildAuthorizeUrl(preset, {
      challenge: pkce.challenge,
      state,
      redirectUri: loop.redirectUri,
    });
    (options.openBrowser ?? openBrowser)(authorizeUrl);
    // The signal ends the wait on cancel; the `finally` then closes the loopback
    // so a fixed-port provider (ChatGPT :1455) is not left occupied.
    const code = await loop.waitForCode(state, { signal: options.signal });
    return await exchangeCode(
      preset,
      { code, redirectUri: loop.redirectUri, verifier: pkce.verifier },
      options.fetchImpl,
    );
  } finally {
    loop.close();
  }
}

/**
 * The OAuth preset a resolved provider signs in / refreshes against, derived
 * from its transport. Anthropic-over-OAuth is Claude; the ChatGPT transport is
 * ChatGPT. An API-key provider has no preset.
 */
export function oauthPresetFor(provider: ResolvedProvider): OAuthPreset | undefined {
  if (provider.auth !== "oauth") return undefined;
  const transport = provider.transport ?? "openai";
  if (transport === "anthropic") return CLAUDE_OAUTH;
  if (transport === "chatgpt") return CHATGPT_OAUTH;
  return undefined;
}

/**
 * Refresh an expired OAuth access token before a turn, persisting the new one.
 *
 * Returns the fresh provider and config, or undefined when nothing needed
 * refreshing (not OAuth, not expired, no refresh token, or an unknown preset).
 * A refresh that fails is left to the caller's error handling — the turn then
 * proceeds with the stale token and the endpoint's 401 says to sign in again,
 * which is a clearer message than a silent retry loop.
 */
export async function refreshProvider(
  provider: ResolvedProvider,
  config: CliConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ provider: ResolvedProvider; config: CliConfig } | undefined> {
  const preset = oauthPresetFor(provider);
  const tokens = provider.oauth;
  if (!preset || !tokens?.refreshToken || !tokenExpired(tokens)) return undefined;
  const fresh = await refreshTokens(preset, tokens.refreshToken, fetchImpl);
  // Keep the old refresh token if the provider did not rotate it.
  const merged: OAuthTokens = { ...tokens, ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
  const active = activeNamedProvider(config);
  const nextConfig = active ? withActiveOAuth(config, merged) : config;
  return { provider: { ...provider, oauth: merged }, config: nextConfig };
}
