import { ANTHROPIC_VERSION, OAUTH_BETA_HEADER } from "./anthropic-client.js";
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
