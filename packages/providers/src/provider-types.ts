/**
 * The provider vocabulary, shared by the runtime and any host.
 *
 * These types are the *contract* between a host that has configured an
 * endpoint (the CLI, a test, an embedding) and `@actor0/providers`, which turns
 * one into a live `ModelClient`. They live here rather than in the harness
 * because the harness is transport-neutral and must not know that a "provider"
 * or an "OAuth token" is a particular shape — and rather than in the CLI because
 * the CLI is only one host; a second host should be able to build a
 * `ResolvedProvider` without importing the terminal client.
 */

/** Which wire protocol a provider speaks. */
export type ProviderTransport = "openai" | "anthropic" | "chatgpt";

/** How the credential is presented to the endpoint. */
export type ProviderAuth = "api-key" | "oauth";

/**
 * OAuth tokens for a provider that authorizes in the browser.
 *
 * ChatGPT- and Claude-specific fields ride along because both flows produce
 * them and both transports read them; a host that only stores what it is given
 * cannot get the shape wrong.
 */
export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, when the provider said. */
  expiresAt?: number;
  scope?: string;
  idToken?: string;
  /** ChatGPT's account id, needed as a request header — decoded from the id token. */
  accountId?: string;
  /** Subscription plan, for a readable label — ChatGPT id-token claim or a Claude profile fetch. */
  plan?: string;
};

/**
 * The endpoint, resolved. Every field here is what the request will use.
 *
 * The first three are all that is required, and the rest is metadata about
 * where they came from — so a host that builds one by hand (a test, a
 * harness embedding actor0) does not have to invent a provenance it does not
 * have, and cannot get it wrong.
 */
export type ResolvedProvider = {
  baseUrl: string;
  /**
   * An *explicit* request path, which replaces the whole pathname.
   *
   * Absent for an OpenAI-compatible endpoint that named none, so the transport
   * appends `/chat/completions` to the base URL's own path — the only behaviour
   * that survives a gateway served from a prefix.
   */
  path?: string;
  model: string;
  /** Which wire protocol to speak. Absent means OpenAI-compatible, the historical default. */
  transport?: ProviderTransport;
  /** How the credential is presented. Absent means api-key. */
  auth?: ProviderAuth;
  apiKey?: string;
  /** OAuth tokens, when `auth` is "oauth". */
  oauth?: OAuthTokens;
  /** Reasoning effort, when the transport and model support it. */
  reasoningEffort?: "low" | "medium" | "high";
  headers?: Record<string, string>;
  /** Where the credential came from, for display. Never the credential. */
  apiKeySource?: string;
};
