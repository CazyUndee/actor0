import {
  CHATGPT_OAUTH,
  CLAUDE_OAUTH,
  ENDPOINTS,
  type OAuthPreset,
  type ProviderAuth,
  type ProviderTransport,
} from "@actor0/providers";
import type { NamedProvider } from "./config.js";

/**
 * Provider presets — the per-provider data the generic OAuth and transport
 * layers are parameterised by.
 *
 * The values themselves now live in `@actor0/providers`, because they are
 * provider data rather than CLI policy and the desktop app is a second host
 * that must not invent its own `client_id`. They are **evidence, not
 * configuration** — read off the installed `claude` and `codex` CLIs on
 * 2026-10-09 — and that package's `oauth-presets.ts` carries the provenance and
 * is the one place to update them. What stays here is the part that is CLI
 * policy: which kinds `/provider → add` offers, in what order, and how a
 * provider is labelled.
 */

export { CHATGPT_OAUTH, CLAUDE_OAUTH, ENDPOINTS };
export type { OAuthPreset, ProviderAuth, ProviderTransport };

/** `/provider` labels a kind by what it is, not by host. */

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
  return plan ? `${titlePlan(plan)} ` : "";
}

/**
 * A subscription plan as a readable name.
 *
 * Covers the values both providers actually report — Claude's max/pro/team/
 * enterprise and ChatGPT's free/go/plus/pro/prolite/team/business/enterprise.
 * Note: ChatGPT's Pro price tiers ($100/$200/$500) all report as plain `pro`
 * in the OAuth token; the multiplier is not in the token, so it is not guessed
 * here — every Pro reads "Pro".
 */
function titlePlan(plan: string): string {
  switch (plan) {
    case "pro":
      return "Pro";
    case "prolite":
      return "Pro Lite";
    case "plus":
      return "Plus";
    case "go":
      return "Go";
    case "free":
      return "Free";
    case "max":
      return "Max";
    case "team":
      return "Team";
    case "enterprise":
      return "Enterprise";
    case "business":
      return "Business";
    case "self_serve_business_prolite":
      return "Business Pro Lite";
    case "self_serve_business_usage_based":
      return "Business (usage-based)";
    default:
      return plan.charAt(0).toUpperCase() + plan.slice(1);
  }
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
