import { OpenAiCompatibleModel, type ModelClient } from "@actor0/harness";
import { AnthropicModel } from "./anthropic-client.js";
import { ChatGptModel } from "./chatgpt-client.js";
import type { ResolvedProvider } from "./provider-types.js";

/**
 * Build the model client for a resolved provider.
 *
 * Dispatches on the provider's transport: the OpenAI-compatible client the
 * harness ships, the CLI's Anthropic Messages client, or the ChatGPT Responses
 * client. All three implement the same `ModelClient` port, so the turn loop is
 * identical whichever one runs. This is the one place a provider's *shape*
 * becomes a live transport, which is why it lives beside the transports rather
 * than in the harness (which must not know a provider exists) or in a host
 * (which would have to reimplement the dispatch).
 */
export function createModel(provider: ResolvedProvider, fetchImpl?: typeof fetch): ModelClient {
  const transport = provider.transport ?? "openai";
  const auth = provider.auth ?? "api-key";
  const effort = provider.reasoningEffort;

  if (transport === "anthropic") {
    const oauth = auth === "oauth" ? provider.oauth : undefined;
    return new AnthropicModel({
      baseUrl: provider.baseUrl,
      ...(provider.path ? { path: provider.path } : {}),
      model: provider.model,
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      auth: oauth
        ? { kind: "oauth", accessToken: oauth.accessToken }
        : { kind: "api-key", apiKey: provider.apiKey ?? "" },
    });
  }

  if (transport === "chatgpt") {
    const oauth = provider.oauth;
    if (!oauth) {
      throw new Error("The ChatGPT provider needs a sign-in — add it with /provider and authorize in the browser.");
    }
    return new ChatGptModel({
      baseUrl: provider.baseUrl,
      ...(provider.path ? { path: provider.path } : {}),
      model: provider.model,
      accessToken: oauth.accessToken,
      ...(oauth.accountId ? { accountId: oauth.accountId } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    });
  }

  return new OpenAiCompatibleModel({
    baseUrl: provider.baseUrl,
    // Omitted when the endpoint named no path, so the transport appends
    // `/chat/completions` to the base URL's own prefix rather than replacing
    // it. A gateway served from `/api/gateway/v1` needs that distinction.
    ...(provider.path ? { path: provider.path } : {}),
    model: provider.model,
    // Omitted rather than passed as undefined so the transport's own "no
    // credential" branch is the one that runs, which is what a local
    // endpoint with no key needs.
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  });
}

/**
 * Confirm a provider actually answers, end to end — credential *and* model.
 *
 * The model-list fetch during onboarding proves the credential, but not that
 * the chosen model responds (a hand-typed or stale name would still look set
 * up). This drives one trivial turn through the real client, so "ready" means
 * reachable, not merely configured. Best-effort: a transport error is returned
 * with its retriability, so the caller can tell an auth/config failure (surface
 * it) from a network blip (don't block setup on it).
 */
export async function verifyProvider(
  provider: ResolvedProvider,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; message?: string; retriable?: boolean }> {
  try {
    const client = createModel(provider, fetchImpl);
    // Driving the stream to completion is the check: it throws on a bad
    // credential, a missing model, or an unreachable host. The events themselves
    // are not needed, so the iterator is drained rather than bound to a name.
    const iterator = client.stream([{ role: "user", content: "hi" }], [], new AbortController().signal)[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    return { ok: true };
  } catch (error) {
    const transport = error as { message?: string; retriable?: boolean };
    return {
      ok: false,
      message: transport?.message ?? String(error),
      retriable: transport?.retriable === true,
    };
  }
}
