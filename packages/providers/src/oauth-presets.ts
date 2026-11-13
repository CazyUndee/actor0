/**
 * The OAuth presets, and the endpoints they authenticate against.
 *
 * These live here, not in a host, because they are *provider data*: the values a
 * request needs in order to be addressed to a particular service. A second host
 * must be able to build a `ResolvedProvider` without importing the terminal
 * client, and it must not be able to invent its own `client_id` while doing it —
 * a wrong one fails silently or insecurely, and one that merely looks plausible
 * is the most dangerous thing in this file.
 *
 * **Provenance.** Every value below was read off the installed CLIs on
 * 2026-10-09, not recalled:
 *   - Claude Code, from `~/Downloads/claude-code-main/.../src/constants/oauth.ts`
 *     and `src/services/oauth/`;
 *   - ChatGPT/Codex, from strings in the shipped `codex.exe`.
 *
 * These are **evidence, not configuration.** They are not derived from any URL
 * in this repository, and a fresh checkout cannot re-derive a single one of
 * them. When a provider changes its flow, the fix is to obtain the source or
 * the binary again and read the constants off it — this file is the one place to
 * update, and `apps/cli/src/ui/App.test.ts` pins the values so a change is
 * deliberate rather than incidental.
 */

import type { ProviderTransport } from "./provider-types.js";

/** Everything an OAuth preset must name. Deliberately data, so a provider is a literal. */
export type OAuthPreset = {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Fixed port the provider registered the redirect on, or omit for an OS-assigned one. */
  redirectPort?: number;
  /** Path of the registered redirect, e.g. `/callback` or `/auth/callback`. */
  redirectPath: string;
  /** Extra authorize/token params a provider wants (audience, resource, originator...). */
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
};

/**
 * Claude Code OAuth → the Anthropic Messages API.
 *
 * Authorize bounces through `claude.com/cai/*` for attribution and 307s to
 * `claude.ai/oauth/authorize`; the token lives on `platform.claude.com`. The
 * redirect is a loopback on an OS-assigned port (the source binds port 0).
 */
export const CLAUDE_OAUTH: OAuthPreset = {
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scopes: ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"],
  redirectPath: "/callback",
};

/**
 * ChatGPT OAuth → the OpenAI Responses API behind `chatgpt.com/backend-api/codex`.
 *
 * A fixed loopback port (1455) and the Codex authorize flags. The extra params
 * are the ones the shipped CLI sends; `originator` is attribution and
 * `id_token_add_organizations` is what puts the account id in the id token the
 * `chatgpt-account-id` header is later read from.
 */
export const CHATGPT_OAUTH: OAuthPreset = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access", "api.connectors.read", "api.connectors.invoke"],
  redirectPort: 1455,
  redirectPath: "/auth/callback",
  extraAuthorizeParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  },
};

/** Base URLs the transports talk to, and where models are listed. */
export const ENDPOINTS = {
  anthropic: { baseUrl: "https://api.anthropic.com", messagesPath: "/v1/messages", modelsPath: "/v1/models" },
  chatgpt: { baseUrl: "https://chatgpt.com/backend-api/codex", responsesPath: "/responses", modelsPath: "/models" },
  openai: { baseUrl: "https://api.openai.com/v1", modelsPath: "/models" },
} as const;

/** The OAuth preset a transport signs in with, when it has one. */
export function oauthPresetForTransport(transport: ProviderTransport): OAuthPreset | undefined {
  if (transport === "anthropic") return CLAUDE_OAUTH;
  if (transport === "chatgpt") return CHATGPT_OAUTH;
  return undefined;
}
