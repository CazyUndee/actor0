import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./paths.js";
import type { OAuthTokens } from "./oauth.js";
import type { ProviderAuth, ProviderTransport } from "./provider-presets.js";
import type { ResolvedProvider } from "@actor0/providers";

/**
 * Configuration.
 *
 * The endpoint is configurable again, and the reason it used not to be is the
 * reason it is now. A single built-in endpoint could not drift. The preset
 * table that preceded it could: a stored `baseUrl` outlived the reason for
 * it, and a request went to a host that wanted a credential we did not have
 * while every visible signal — the status bar, `/help`, the config file — said
 * the right provider was in use. Nothing failed. The request just went
 * somewhere else.
 *
 * So the fix for that is not prohibition, it is that the endpoint in play is
 * always visible and always testable:
 *
 *   - the status bar shows the resolved host, never a built-in constant
 *   - `/provider` prints the endpoint, the path, the model, and where the
 *     credential came from — masked, never the credential
 *   - `/provider test` makes one real request and reports what happened
 *
 * A feature that cannot be seen is a feature that cannot be debugged, and the
 * one thing this CLI must never do is send a request somewhere the user
 * cannot account for.
 *
 * Precedence is environment, then file, then the built-in endpoint. The
 * environment is first deliberately: it is how a CI job or a benchmark points
 * at an endpoint without editing a file, and a shell that cannot win is a
 * shell that cannot recover from a stale config.
 */

export type ProviderConfig = {
  /** Root of an OpenAI-compatible API, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Defaults to the transport's own convention when unset. */
  path?: string;
  /**
   * The model to ask of *this* endpoint.
   *
   * Held here rather than in one flat field so that switching endpoints cannot
   * carry a model name across with it.
   */
  model?: string;
  /** Which wire protocol. Defaults to "openai" for configs written before this existed. */
  transport?: ProviderTransport;
  /** How the credential is presented. Defaults to "api-key". */
  auth?: ProviderAuth;
  /** The credential, when `auth` is "api-key". `${NAME}` reads from the environment. */
  apiKey?: string;
  /** OAuth tokens, when `auth` is "oauth". */
  oauth?: OAuthTokens;
  /** Reasoning effort for models that support it — low / medium / high. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Extra request headers, for gateways that need them. Values take `${NAME}`. */
  headers?: Record<string, string>;
};

/**
 * A registered endpoint, with a name the user picks or that is derived from
 * its host. This is what `/provider` lists and switches between. The built-in
 * endpoint is deliberately *not* one of these — it is the fallback used when no
 * provider is registered or active, so it can never be deleted or drift.
 */
export type NamedProvider = ProviderConfig & {
  /** Stable identifier within `providers`; also what the menu shows. */
  name: string;
};

export type CliConfig = {
  /** Model asked of the built-in endpoint. */
  model: string;
  /** Models offered by `/model`, most recent first. */
  models: string[];
  /** Replaces the built-in system prompt when set. */
  systemPrompt?: string;
  /** Absent means the built-in endpoint. Legacy single-endpoint field; superseded by `providers`. */
  provider?: ProviderConfig;
  /** Registered endpoints, selectable from `/provider`. */
  providers?: NamedProvider[];
  /** Name of the entry in `providers` that is currently in use. */
  activeProvider?: string;
  /**
   * Context windows learned per model, from `/models` or an overflow error.
   * Never a hand-maintained table — it fills in as providers report it, and the
   * UI degrades to absolute tokens for a model that is not here yet.
   */
  contextWindows?: Record<string, number>;
};

export type { ResolvedProvider };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).map(([key, entry]) => [key, nonEmptyString(entry) ?? ""] as const);
  const kept = entries.filter(([, entry]) => entry.length > 0);
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/**
 * A display/storage name for an endpoint, derived from its host.
 *
 * The host rather than the full URL: it is the part a user recognises and the
 * part that stays put when the path or model changes. `www.` is dropped because
 * nobody names a provider that. Not guaranteed unique — `uniqueProviderName`
 * de-duplicates against the names already in play.
 */
export function providerName(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl;
  }
  return host.replace(/^www\./, "") || "provider";
}

/** `name`, or `name-2`, `name-3`… until it does not collide with `taken`. */
function uniqueProviderName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name}-${n}`)) n += 1;
  return `${name}-${n}`;
}

/**
 * Read a `providers` array from raw JSON, keeping only well-formed entries.
 *
 * An entry without a `baseUrl` is dropped rather than defaulted — a provider
 * with nowhere to send a request is not a provider, and carrying it into the
 * menu as a selectable row would be a switch to a broken endpoint. A missing
 * `name` is filled from the host, so a hand-written list need not name itself.
 */
function parseProviders(value: unknown): NamedProvider[] {
  if (!Array.isArray(value)) return [];
  const out: NamedProvider[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const baseUrl = nonEmptyString(entry.baseUrl);
    if (!baseUrl) continue;
    const oauth = parseOAuth(entry.oauth);
    // De-duplicate the name against the ones already kept: two entries named the
    // same collide on write, and `withModel`/`withActiveOAuth` would map over
    // both — copying one provider's model or tokens onto another.
    const name = uniqueProviderName(nonEmptyString(entry.name) ?? providerName(baseUrl), out.map((p) => p.name));
    out.push({
      name,
      baseUrl,
      ...(nonEmptyString(entry.path) ? { path: nonEmptyString(entry.path)! } : {}),
      ...(nonEmptyString(entry.model) ? { model: nonEmptyString(entry.model)! } : {}),
      ...(isTransport(entry.transport) ? { transport: entry.transport } : {}),
      ...(isAuth(entry.auth) ? { auth: entry.auth } : {}),
      ...(nonEmptyString(entry.apiKey) ? { apiKey: nonEmptyString(entry.apiKey)! } : {}),
      ...(oauth ? { oauth } : {}),
      ...(isEffort(entry.reasoningEffort) ? { reasoningEffort: entry.reasoningEffort } : {}),
      ...(stringMap(entry.headers) ? { headers: stringMap(entry.headers)! } : {}),
    });
  }
  return out;
}

const TRANSPORTS = new Set(["openai", "anthropic", "chatgpt"]);
const AUTHS = new Set(["api-key", "oauth"]);
const EFFORTS = new Set(["low", "medium", "high"]);
function isTransport(value: unknown): value is ProviderTransport {
  return typeof value === "string" && TRANSPORTS.has(value);
}
function isAuth(value: unknown): value is ProviderAuth {
  return typeof value === "string" && AUTHS.has(value);
}
function isEffort(value: unknown): value is "low" | "medium" | "high" {
  return typeof value === "string" && EFFORTS.has(value);
}

/** Read stored OAuth tokens; an entry with no access token is dropped. */
function parseOAuth(value: unknown): OAuthTokens | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = nonEmptyString(value.accessToken);
  if (!accessToken) return undefined;
  return {
    accessToken,
    ...(nonEmptyString(value.refreshToken) ? { refreshToken: nonEmptyString(value.refreshToken)! } : {}),
    ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
    ...(nonEmptyString(value.scope) ? { scope: nonEmptyString(value.scope)! } : {}),
    ...(nonEmptyString(value.idToken) ? { idToken: nonEmptyString(value.idToken)! } : {}),
    ...(nonEmptyString(value.accountId) ? { accountId: nonEmptyString(value.accountId)! } : {}),
  };
}

/** Read the learned context-window map; non-positive or non-number entries drop. */
function contextWindowsOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [model, window] of Object.entries(value)) {
    if (typeof window === "number" && window > 0) out[model] = window;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Replace `${NAME}` with the value of that environment variable.
 *
 * An unset variable is an error naming the variable. The alternative — leaving
 * the placeholder in place, or substituting an empty string — produces a
 * request that is authenticated as nobody and a 401 that reads like a wrong
 * model, which is a genuinely hard thing to diagnose from the outside.
 */
function expandEnv(value: string, field: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = process.env[name];
    if (!found) {
      throw new ConfigError(
        `${field} refers to \${${name}}, and that environment variable is not set. ` +
          `Set it, or put the value in config.json directly.`,
      );
    }
    return found;
  });
}

/** Read `config.json`, tolerating absence but not corruption. */
export function readConfigFile(): CliConfig {
  let raw: string;
  try {
    raw = readFileSync(configFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { model: "", models: [] };
    throw error;
  }
  if (!raw.trim()) return { model: "", models: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${configFile()} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new ConfigError(`${configFile()} must contain a JSON object`);

  const stored = parsed as Partial<CliConfig> & { provider?: Record<string, unknown> };
  const models = Array.isArray(stored.models)
    ? stored.models.filter((entry): entry is string => typeof entry === "string")
    : [];

  // Old files carried `baseUrl`, `apiKey` and `path` under `provider` and the
  // CLI ignored all three. They are honoured again, which is what a user who
  // has one on disk expects; what is *not* restored is the old precedence that
  // let a stored endpoint outrank the one in effect.
  const baseUrl = nonEmptyString(stored.provider?.baseUrl);
  const legacyOauth = parseOAuth(stored.provider?.oauth);
  const legacyProvider: ProviderConfig | undefined = baseUrl
    ? {
        baseUrl,
        ...(nonEmptyString(stored.provider?.path) ? { path: nonEmptyString(stored.provider?.path)! } : {}),
        ...(nonEmptyString(stored.provider?.model) ? { model: nonEmptyString(stored.provider?.model)! } : {}),
        ...(isTransport(stored.provider?.transport) ? { transport: stored.provider.transport } : {}),
        ...(isAuth(stored.provider?.auth) ? { auth: stored.provider.auth } : {}),
        ...(nonEmptyString(stored.provider?.apiKey) ? { apiKey: nonEmptyString(stored.provider?.apiKey)! } : {}),
        ...(legacyOauth ? { oauth: legacyOauth } : {}),
        ...(stringMap(stored.provider?.headers) ? { headers: stringMap(stored.provider?.headers)! } : {}),
      }
    : undefined;

  // Migration. A file that predates the provider list carries a single
  // `provider` and no `providers`. Project it into a one-element list so the
  // whole app speaks one shape. The file itself is untouched here — it is
  // rewritten in the new shape only on the next save — so *reading* never
  // mutates disk, and a config whose owner never opens the menu behaves
  // exactly as it did before this list existed.
  const providers = parseProviders(stored.providers);
  const activeProvider = nonEmptyString(stored.activeProvider);
  let effectiveProviders = providers;
  let effectiveActive: string | undefined;
  if (providers.length === 0 && legacyProvider) {
    // Migration: a lone legacy `provider` becomes the one active endpoint.
    const name = providerName(legacyProvider.baseUrl);
    effectiveProviders = [{ ...legacyProvider, name }];
    effectiveActive = name;
  } else if (activeProvider && providers.some((entry) => entry.name === activeProvider)) {
    // Honour a pointer that names a real provider. A pointer that names nothing
    // (hand-edited, or an entry that was dropped) stays *unset* rather than
    // guessing `providers[0]` — guessing is the silent misroute this module
    // exists to prevent, and `resolveProvider` then reports nothing configured.
    effectiveActive = activeProvider;
  }
  const activeModel = effectiveProviders.find((entry) => entry.name === effectiveActive)?.model;

  return {
    // The flat model is the active provider's own model, so the status bar and
    // `/model` show what is in play. It is never the legacy `provider.model`,
    // which would carry one endpoint's model onto another.
    model: (typeof stored.model === "string" ? stored.model.trim() : "") || activeModel || "",
    models,
    ...(effectiveProviders.length ? { providers: effectiveProviders } : {}),
    ...(effectiveActive ? { activeProvider: effectiveActive } : {}),
    ...(contextWindowsOf(stored.contextWindows) ? { contextWindows: contextWindowsOf(stored.contextWindows) } : {}),
    ...(typeof stored.systemPrompt === "string" && stored.systemPrompt.trim()
      ? { systemPrompt: stored.systemPrompt }
      : {}),
  };
}

/** Resolve config: the environment wins, then the file, then the built-in model. */
export function loadConfig(): CliConfig {
  const file = readConfigFile();
  const envModel = process.env.ACTOR0_MODEL?.trim();
  return {
    model: envModel || file.model,
    models: file.models,
    ...(file.provider ? { provider: file.provider } : {}),
    ...(file.providers ? { providers: file.providers } : {}),
    ...(file.activeProvider ? { activeProvider: file.activeProvider } : {}),
    ...(file.systemPrompt ? { systemPrompt: file.systemPrompt } : {}),
  };
}

/**
 * The endpoint plus the chosen model, with nothing left to guess.
 *
 * BYOK: there is no built-in endpoint. A provider must be configured — via the
 * `/provider` registry, or `ACTOR0_BASE_URL` for one run — and a half-configured
 * one fails here with a message naming what is missing, rather than at the
 * first request with an opaque error. The App treats the "nothing configured"
 * throw as the signal to open onboarding.
 */
export function resolveProvider(config: CliConfig): ResolvedProvider {
  const envBase = process.env.ACTOR0_BASE_URL?.trim();
  const stored = activeNamedProvider(config);
  const baseUrl = envBase || stored?.baseUrl;
  if (!baseUrl) {
    throw new ConfigError(
      "No provider is configured. Run /provider to add one, or set ACTOR0_BASE_URL.",
    );
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`"${baseUrl}" is not a URL. Set a full base URL, for example https://api.example.com/v1.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`The base URL must use http or https, not ${url.protocol.replace(":", "")}.`);
  }

  const transport: ProviderTransport = stored?.transport ?? "openai";
  // An explicit path replaces the whole pathname; otherwise it is left unset and
  // the transport appends its own default (`/chat/completions`, `/v1/messages`,
  // `/responses`) to whatever prefix the base URL carries. Inventing an absolute
  // path here is what silently dropped a gateway's prefix — the ChatGPT backend
  // lives under `/backend-api/codex`, and a default of `/responses` would send
  // every request to `chatgpt.com/responses`.
  const explicitPath = process.env.ACTOR0_PATH?.trim() || stored?.path;
  const path = explicitPath;
  const model = (stored?.model || config.model || "").trim();
  if (!model) {
    throw new ConfigError("No model is set. Run /model <name>, or set ACTOR0_MODEL.");
  }

  const auth: ProviderAuth = stored?.auth ?? "api-key";
  // An exported-but-empty `ACTOR0_API_KEY=` is treated as unset, like every other
  // env override — otherwise it would delete a stored key and send the request
  // with no credential at all.
  const envKey = process.env.ACTOR0_API_KEY?.trim();
  const rawKey = envKey || stored?.apiKey;
  const apiKey = rawKey ? expandEnv(rawKey, "apiKey") : undefined;
  const oauth = stored?.oauth;
  // A provider that says it authenticates with OAuth but carries no tokens is
  // half-configured: fail here by name rather than degrading to an empty api key
  // and a bare 401 with no mention of the missing sign-in.
  if (auth === "oauth" && !oauth?.accessToken) {
    throw new ConfigError("This provider signs in with OAuth but has no token — add it again with /provider and authorize.");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored?.headers ?? {})) {
    headers[name] = expandEnv(value, `headers.${name}`);
  }

  return {
    baseUrl,
    ...(path ? { path } : {}),
    model,
    transport,
    auth,
    ...(apiKey ? { apiKey, apiKeySource: envKey ? "ACTOR0_API_KEY" : "config.json" } : {}),
    ...(oauth ? { oauth } : {}),
    ...(stored?.reasoningEffort ? { reasoningEffort: stored.reasoningEffort } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/**
 * A credential, shown well enough to be recognisable and never well enough to
 * be usable. Six characters is enough to tell two keys apart and short enough
 * that a screenshot of `/provider` is not a leak.
 */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return "none";
  if (secret.length <= 8) return `${secret.slice(0, 2)}… (${secret.length} chars)`;
  return `${secret.slice(0, 6)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/**
 * The URL the request will actually go to.
 *
 * Mirrors the transport's composition rather than guessing at it: an explicit
 * path replaces the whole pathname, and otherwise `/chat/completions` is
 * appended to whatever the base URL already carries. Showing the base URL on
 * its own would send the user looking for an endpoint that is not the one
 * being called, which is the confusion the composed form exists to remove.
 */
export function endpointUrl(provider: ResolvedProvider): string {
  if (provider.path) return new URL(provider.path, provider.baseUrl).toString();
  const base = provider.baseUrl.replace(/\/+$/, "");
  // Append the transport's own default, so the composed URL matches what the
  // client will actually request — including a base URL served from a prefix.
  const transport = provider.transport ?? "openai";
  const suffix =
    transport === "anthropic" ? "/v1/messages" : transport === "chatgpt" ? "/responses" : "/chat/completions";
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/** `/provider`, as lines. Everything here is safe to screenshot. */
export function describeProvider(provider: ResolvedProvider): string[] {
  return [
    `endpoint   ${endpointUrl(provider)}`,
    `model      ${provider.model}`,
    `credential ${provider.apiKey ? `set — ${maskSecret(provider.apiKey)}` : "not set"}`,
    ...(provider.apiKeySource ? [`from       ${provider.apiKeySource}`] : []),
    ...(Object.keys(provider.headers ?? {}).length
      ? [`headers    ${Object.keys(provider.headers!).join(", ")}`]
      : []),
  ];
}

/** Persist config, creating the directory and locking the file to the owner. */
export function saveConfig(config: CliConfig): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  // A legacy single `provider` and a `providers` list are two sources of truth
  // for one endpoint; persisting both is exactly the drift this module exists
  // to prevent. When the list is present it is the only shape written —
  // `JSON.stringify` drops the `undefined`, so the legacy field disappears.
  const toWrite = config.providers ? { ...config, provider: undefined } : config;
  writeFileSync(file, `${JSON.stringify(toWrite, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // `mode` is ignored when the file already exists, so set it explicitly.
  chmodSync(file, 0o600);
}

/**
 * Set the active model, adding it to the remembered list if it is new.
 *
 * Written to whichever field the *current* endpoint reads, so that switching
 * endpoints afterwards cannot leave a model behind that the new one does not
 * have, and cannot silently ignore the model the user just chose.
 */
export function withModel(config: CliConfig, model: string): CliConfig {
  const models = config.models.includes(model) ? config.models : [model, ...config.models];
  const trimmed = { ...config, models: models.slice(0, 20) };

  // A named provider is active: record the model on it, so switching endpoints
  // afterwards cannot carry a name across that the new one does not have.
  const active = activeNamedProvider(config);
  if (active && config.providers) {
    return {
      ...trimmed,
      providers: config.providers.map((entry) => (entry.name === active.name ? { ...entry, model } : entry)),
    };
  }

  // Legacy single-endpoint config, custom: the same rule, on the old field.
  const custom = process.env.ACTOR0_BASE_URL?.trim() || config.provider?.baseUrl;
  if (custom && config.provider) {
    return { ...trimmed, provider: { ...config.provider, model } };
  }

  // Built-in endpoint in play: the flat field.
  return { ...trimmed, model };
}

/**
 * Add models to the flat list the `/model` picker shows, keeping the newest and
 * capping at 20 like `withModel`. Records any known context windows. Used to
 * grow an already-configured provider's model set without re-adding it.
 */
export function addModels(config: CliConfig, models: string[], windows: Record<string, number> = {}): CliConfig {
  const merged = [...new Set([...models, ...config.models])].slice(0, 20);
  let next: CliConfig = { ...config, models: merged };
  for (const [model, win] of Object.entries(windows)) next = withContextWindow(next, model, win);
  return next;
}

/**
 * The provider registry `/provider` manages.
 *
 * Each function is pure: it returns a new `CliConfig` and never touches disk.
 * The caller persists with `saveConfig`. That split is what makes the menu
 * testable without a filesystem, and keeps "what changed" separate from "where
 * it is stored".
 */

/**
 * Every registered endpoint as one list, projecting a legacy single `provider`
 * in memory when that is all the config carries.
 *
 * The menu needs one shape to render whether the config predates the list or
 * not, and reading must not rewrite the file — so the legacy endpoint is
 * projected here, and only a real change persists the new shape.
 */
export function namedProviders(config: CliConfig): NamedProvider[] {
  if (config.providers) return config.providers;
  if (config.provider?.baseUrl) {
    return [{ ...config.provider, name: providerName(config.provider.baseUrl) }];
  }
  return [];
}

/**
 * The active registered endpoint, or undefined when the built-in is in use.
 *
 * Two shapes, because a config written before the list still resolves through
 * here:
 *
 *   - New shape (`providers` present): `activeProvider` is the single source of
 *     truth. It names the provider in use, and its absence *means the built-in
 *     endpoint* — which is what makes "use built-in" a real choice rather than
 *     something a fallback would undo. A pointer naming a provider no longer in
 *     the list (only reachable by hand-editing, since `removeProvider`
 *     re-points) also resolves to the built-in: guessing some other registered
 *     endpoint is the silent misroute this module exists to prevent, and the
 *     built-in host is what the status bar then shows, so it is visible.
 *   - Legacy shape (a lone `provider`, no list): that provider *is* the active
 *     endpoint by definition. This is what a hand-built config, or a file not
 *     yet re-saved in the new shape, resolves through — including the URL
 *     validation `resolveProvider` performs on it.
 */
export function activeNamedProvider(config: CliConfig): NamedProvider | undefined {
  if (config.providers) {
    if (!config.activeProvider) return undefined;
    return config.providers.find((entry) => entry.name === config.activeProvider);
  }
  if (config.provider?.baseUrl) {
    return { ...config.provider, name: providerName(config.provider.baseUrl) };
  }
  return undefined;
}

/** Register an endpoint and make it active. Additive; re-adding a name updates it. */
export function addProvider(
  config: CliConfig,
  entry: Omit<NamedProvider, "name"> & { name?: string },
): CliConfig {
  const list = namedProviders(config);
  const base = entry.name?.trim() || providerName(entry.baseUrl);
  const name = uniqueProviderName(base, list.map((p) => p.name));
  const named: NamedProvider = { ...entry, name };
  return { ...config, providers: [...list.filter((p) => p.name !== name), named], activeProvider: name };
}

/** Switch the active endpoint by name; a no-op when the name is unknown. */
export function setActiveProvider(config: CliConfig, name: string): CliConfig {
  const list = namedProviders(config);
  if (!list.some((entry) => entry.name === name)) return config;
  return { ...config, providers: list, activeProvider: name };
}

/**
 * Replace the active provider's stored OAuth tokens.
 *
 * Used after a refresh so the new access token is persisted rather than
 * re-fetched every turn. A no-op when nothing is active, so a caller cannot
 * accidentally write tokens onto a provider that is not in play.
 */
export function withActiveOAuth(config: CliConfig, tokens: OAuthTokens): CliConfig {
  const active = activeNamedProvider(config);
  if (!active || !config.providers) return config;
  return {
    ...config,
    providers: config.providers.map((entry) => (entry.name === active.name ? { ...entry, oauth: tokens } : entry)),
  };
}

/** Record a model's context window (from `/models` or an overflow error). */
export function withContextWindow(config: CliConfig, model: string, window: number): CliConfig {
  const existing = config.contextWindows ?? {};
  if (existing[model] === window) return config;
  return { ...config, contextWindows: { ...existing, [model]: window } };
}

/** Set (or clear) the reasoning effort on the active provider; no-op with none. */
export function withActiveReasoningEffort(
  config: CliConfig,
  effort: "low" | "medium" | "high" | undefined,
): CliConfig {
  const active = activeNamedProvider(config);
  if (!active || !config.providers) return config;
  return {
    ...config,
    providers: config.providers.map((entry) =>
      entry.name === active.name ? { ...entry, ...(effort ? { reasoningEffort: effort } : { reasoningEffort: undefined }) } : entry,
    ),
  };
}

/** Remove a registered endpoint. If it was active, the first survivor stands in. */
export function removeProvider(config: CliConfig, name: string): CliConfig {
  const list = namedProviders(config).filter((entry) => entry.name !== name);
  const next = { ...config, providers: list };
  if (list.length === 0) return { ...next, activeProvider: undefined };
  return { ...next, activeProvider: config.activeProvider === name ? list[0]!.name : config.activeProvider };
}
