import { ANTHROPIC_VERSION, OAUTH_BETA_HEADER } from "@actor0/providers";
import type { ResolvedProvider } from "./config.js";

/**
 * List the models a provider offers, for the "add all / pick / none" step after
 * a sign-in or a key is entered.
 *
 * OpenAI and Anthropic both answer `GET {base}/models` with `{ data: [{ id }] }`,
 * so the shape is shared; only the auth header differs. ChatGPT's models live
 * behind the Responses backend and are not wired yet, so asking it throws rather
 * than guessing a path.
 */

/** The fields a model listing needs — satisfied by both a stored and a resolved provider. */
export type ModelSource = Pick<ResolvedProvider, "baseUrl" | "path" | "transport" | "auth" | "apiKey" | "oauth">;
/** The URL that lists a provider's models. */
export function modelsUrl(provider: ModelSource): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const transport = provider.transport ?? "openai";
  if (transport === "anthropic") return `${base}/v1/models`;
  if (transport === "chatgpt") return `${base}/models`;
  // OpenAI-compatible: append to whatever prefix the base URL carries.
  return base.endsWith("/models") ? base : `${base}/models`;
}

/** The auth headers a models request needs, mirroring each transport. */
export function modelsHeaders(provider: ModelSource): Record<string, string> {
  const transport = provider.transport ?? "openai";
  const auth = provider.auth ?? "api-key";
  if (transport === "anthropic") {
    if (auth === "oauth" && provider.oauth) {
      return {
        Authorization: `Bearer ${provider.oauth.accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "anthropic-version": ANTHROPIC_VERSION,
      };
    }
    return { "x-api-key": provider.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION };
  }
  return provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
}

/**
 * The model ids a provider offers, most useful first.
 *
 * Both APIs return `{ data: [{ id }] }`. A provider that answers without that
 * shape is an empty list rather than a throw: "I could not read the models" is
 * something the caller shows and the user works around by typing a name, which
 * is better than a sign-in that dead-ends on a listing error.
 */
export async function fetchModels(provider: ModelSource, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const response = await fetchImpl(modelsUrl(provider), { headers: modelsHeaders(provider) });
  if (!response.ok) {
    throw new Error(`could not list models from ${modelsUrl(provider)} (HTTP ${response.status})`);
  }
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  // Newest-first is the common convention and the most useful order; the APIs
  // do not guarantee it, so this is a stable sort that keeps duplicates out.
  return [...new Set(ids)];
}

/** A model id with its context window, when the provider publishes one. */
export type ModelInfo = { id: string; contextWindow?: number };

/**
 * List a provider's models with any context window each advertises.
 *
 * The window is not universal — OpenAI and Anthropic omit it from `/models`,
 * while gateways (OpenRouter, vLLM, LiteLLM, Together…) publish it — so every
 * spelling is tried and an absent one is left undefined rather than guessed.
 * That keeps the window provider-loaded, never a hand-maintained table.
 */
export async function fetchModelInfos(provider: ModelSource, fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  const response = await fetchImpl(modelsUrl(provider), { headers: modelsHeaders(provider) });
  if (!response.ok) {
    throw new Error(`could not list models from ${modelsUrl(provider)} (HTTP ${response.status})`);
  }
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = contextWindowOf(record);
    out.push(contextWindow !== undefined ? { id, contextWindow } : { id });
  }
  return out;
}

/** The context window a `/models` entry publishes, under any of its spellings. */
function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  for (const key of ["context_window", "context_length", "max_context_tokens", "max_input_tokens", "context"]) {
    const value = entry[key];
    if (typeof value === "number" && value > 0) return value;
  }
  return undefined;
}

/**
 * Claude's subscription plan, for a readable label.
 *
 * Fetched from the OAuth profile with the access token; the organisation type
 * maps to the plan the way Claude Code reads it (`claude_max` → max, etc.).
 * Best-effort: an unknown or unreachable profile yields undefined, and the
 * label falls back to "Claude Code - subscription".
 */
export async function fetchClaudePlan(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "anthropic-version": ANTHROPIC_VERSION,
      },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const value = (await response.json().catch(() => undefined)) as { organization?: { organization_type?: unknown } } | undefined;
  const orgType = value?.organization?.organization_type;
  if (typeof orgType !== "string") return undefined;
  switch (orgType) {
    case "claude_max":
      return "max";
    case "claude_pro":
      return "pro";
    case "claude_team":
      return "team";
    case "claude_enterprise":
      return "enterprise";
    default:
      return undefined;
  }
}
