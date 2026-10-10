import type { OAuthPreset } from "./oauth.js";
import type { NamedProvider } from "./config.js";

/**
 * Provider presets — the per-provider data the generic OAuth and transport
 * layers are parameterised by.
 *
 * Every value here was read off the installed CLIs on 2026-10-09, not recalled:
 *   - Claude Code, from `~/Downloads/claude-code-main/.../src/constants/oauth.ts`
 *     and `src/services/oauth/`;
 *   - ChatGPT/Codex, from strings in the shipped `codex.exe`.
 *
 * That matters because a wrong `client_id` or authorize URL fails silently or
 * insecurely, and a value that looks right but is invented is worse than one
 * that is obviously missing. When a provider changes its flow, this file is the
 * one place to update.
 */

export type ProviderTransport = "openai" | "anthropic" | "chatgpt";

export type ProviderAuth = "api-key" | "oauth";

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
 * account-id header is later read from.
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

/**
 * A sign-in / add option the `/provider` menu offers.
 *
 * `oauth` present means "sign in in a browser"; otherwise it is "paste a key".
 * A kind can offer both (Claude is OAuth *or* an API key against the same
 * Messages API), which is why `auth` is a list.
 */
export type ProviderKind = {
  id: string;
  label: string;
  transport: ProviderTransport;
  baseUrl: string;
  /** Request path when the transport needs a non-default one. */
  path?: string;
  auth: ProviderAuth[];
  oauth?: OAuthPreset;
  /** Path appended to `baseUrl` to list models, for the fetch step. */
  modelsPath?: string;
};

/** What `/provider → add` offers. Order is the order shown. */
export const PROVIDER_KINDS: ProviderKind[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    transport: "anthropic",
    baseUrl: ENDPOINTS.anthropic.baseUrl,
    auth: ["oauth", "api-key"],
    oauth: CLAUDE_OAUTH,
    modelsPath: ENDPOINTS.anthropic.modelsPath,
  },
  {
    id: "chatgpt",
    label: "ChatGPT (OpenAI)",
    transport: "chatgpt",
    baseUrl: ENDPOINTS.chatgpt.baseUrl,
    auth: ["oauth"],
    oauth: CHATGPT_OAUTH,
    modelsPath: ENDPOINTS.chatgpt.modelsPath,
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible (API key)",
    transport: "openai",
    baseUrl: ENDPOINTS.openai.baseUrl,
    auth: ["api-key"],
    modelsPath: ENDPOINTS.openai.modelsPath,
  },
  {
    id: "anthropic-key",
    label: "Anthropic (API key)",
    transport: "anthropic",
    baseUrl: ENDPOINTS.anthropic.baseUrl,
    auth: ["api-key"],
    modelsPath: ENDPOINTS.anthropic.modelsPath,
  },
];

export const providerKind = (id: string): ProviderKind | undefined => PROVIDER_KINDS.find((kind) => kind.id === id);

/**
 * A readable label for a provider, instead of a URL.
 *
 * The point of BYOK with several providers is that the user recognises them by
 * what they are, not by host: "Claude Code - Pro subscription", "Codex - Plus
 * subscription", "Anthropic API - Direct", "Anthropic API - Amazon Bedrock".
 * The subscription plan is dynamic — it is read from the token/account at
 * sign-in and stored on the provider, so it is never hardcoded here.
 */
export function providerLabel(provider: NamedProvider): string {
  const transport = provider.transport ?? "openai";
  const auth = provider.auth ?? "api-key";
  if (transport === "anthropic") {
    if (auth === "oauth") return `Claude Code - ${planSuffix(provider.oauth?.plan)}subscription`;
    return anthropicApiLabel(provider.baseUrl);
  }
  if (transport === "chatgpt") {
    return `Codex - ${planSuffix(provider.oauth?.plan)}subscription`;
  }
  return openAiLabel(provider.baseUrl);
}

/** "Pro " when the plan is known, "" when it is not — so the label still reads. */
function planSuffix(plan: string | undefined): string {
  return plan ? `${titleCase(plan)} ` : "";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Anthropic by API key: Direct, a cloud, or the raw host. */
function anthropicApiLabel(baseUrl: string): string {
  const host = safeHost(baseUrl);
  if (host === "api.anthropic.com") return "Anthropic API - Direct";
  if (/vertex|googleapis/i.test(host)) return "Anthropic API - Vertex";
  if (/bedrock|amazonaws/i.test(host)) return "Anthropic API - Amazon Bedrock";
  return `Anthropic API - ${host}`;
}

/** OpenAI-compatible: the product when it is the well-known host, else the host. */
function openAiLabel(baseUrl: string): string {
  const host = safeHost(baseUrl);
  if (host === "api.openai.com") return "OpenAI API";
  return host;
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
