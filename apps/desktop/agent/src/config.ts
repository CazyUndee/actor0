import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthTokens, ProviderAuth, ProviderTransport, ResolvedProvider } from "@actor0/providers";
import { configFile } from "./paths.js";

/**
 * Configuration, in the CLI's own on-disk format.
 *
 * The desktop app is the second host, and the second host is what proves the
 * provider vocabulary in `@actor0/providers` is a real contract rather than a
 * private convention. So this file reads and writes the same `config.json` the
 * CLI does, resolves an endpoint the same way (environment, then file, then the
 * built-in default), and exposes the same registry operations the provider menu
 * drives — but none of it is imported from `apps/cli`. Two implementations of
 * one format is the point; a shared implementation would hide whether the
 * format is actually specifiable.
 *
 * The precedence rule is the load-bearing part and it is the CLI's: environment
 * first, deliberately, so a shell job can point at an endpoint without editing
 * a file, and a stale config cannot win against an explicitly exported value.
 */

export type ProviderConfig = {
  /** Root of an OpenAI-compatible API, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Explicit request path; absent means the transport's own default. */
  path?: string;
  /** The model to ask of *this* endpoint. */
  model?: string;
  /** Which wire protocol. Absent means OpenAI-compatible. */
  transport?: ProviderTransport;
  /** How the credential is presented. Absent means api-key. */
  auth?: ProviderAuth;
  /** The credential; `${NAME}` reads from the environment. */
  apiKey?: string;
  /** OAuth tokens, when `auth` is "oauth". */
  oauth?: OAuthTokens;
  /** Reasoning effort for models that support it. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Extra request headers, for gateways that need them. */
  headers?: Record<string, string>;
};

/** A registered endpoint with a name the provider menu shows. */
export type NamedProvider = ProviderConfig & {
  name: string;
  /** Models this endpoint offers, most recent first. */
  models?: string[];
};

export type DesktopConfig = {
  /** Model asked of the built-in endpoint. */
  model: string;
  /** Models offered by the model picker. */
  models: string[];
  /** Replaces the built-in system prompt when set. */
  systemPrompt?: string;
  /** Legacy single-endpoint field; superseded by `providers`. */
  provider?: ProviderConfig;
  /** Registered endpoints. */
  providers?: NamedProvider[];
  /** Name of the entry in `providers` currently in use. */
  activeProvider?: string;
  /** Context windows learned per model, from a picker fetch or an overflow error. */
  contextWindows?: Record<string, number>;
  /** Cap a turn's tool rounds. Unset means unbounded. */
  maxToolRounds?: number;
};

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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim()),
    ),
  ];
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const kept = Object.entries(value)
    .map(([key, entry]) => [key, nonEmptyString(entry) ?? ""] as const)
    .filter(([, entry]) => entry.length > 0);
  return kept.length ? Object.fromEntries(kept) : undefined;
}

const TRANSPORTS = new Set<ProviderTransport>(["openai", "anthropic", "chatgpt"]);
const AUTHS = new Set<ProviderAuth>(["api-key", "oauth"]);
const EFFORTS = new Set(["low", "medium", "high"]);

const isTransport = (value: unknown): value is ProviderTransport =>
  typeof value === "string" && TRANSPORTS.has(value as ProviderTransport);
const isAuth = (value: unknown): value is ProviderAuth =>
  typeof value === "string" && AUTHS.has(value as ProviderAuth);
const isEffort = (value: unknown): value is "low" | "medium" | "high" =>
  typeof value === "string" && EFFORTS.has(value);

/** A display name for an endpoint, derived from its host (CLI-compatible). */
export function providerName(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl;
  }
  return host.replace(/^www\./, "") || "provider";
}

/** `name`, or `name-2`, `name-3`... until it does not collide with `taken`. */
function uniqueProviderName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name}-${n}`)) n += 1;
  return `${name}-${n}`;
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
    ...(nonEmptyString(value.plan) ? { plan: nonEmptyString(value.plan)! } : {}),
  };
}

/** Read a `providers` array, keeping only well-formed entries. */
function parseProviders(value: unknown): NamedProvider[] {
  if (!Array.isArray(value)) return [];
  const out: NamedProvider[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const baseUrl = nonEmptyString(entry.baseUrl);
    if (!baseUrl) continue;
    const oauth = parseOAuth(entry.oauth);
    const name = uniqueProviderName(
      nonEmptyString(entry.name) ?? providerName(baseUrl),
      out.map((p) => p.name),
    );
    const models = stringList(entry.models);
    const model = nonEmptyString(entry.model);
    out.push({
      name,
      baseUrl,
      ...(nonEmptyString(entry.path) ? { path: nonEmptyString(entry.path)! } : {}),
      ...(model ? { model } : {}),
      ...(models.length ? { models } : model ? { models: [model] } : {}),
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

function contextWindowsOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [model, window] of Object.entries(value)) {
    if (typeof window === "number" && window > 0) out[model] = window;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseProvider(value: unknown): ProviderConfig | undefined {
  if (!isRecord(value)) return undefined;
  const baseUrl = nonEmptyString(value.baseUrl);
  if (!baseUrl) return undefined;
  const oauth = parseOAuth(value.oauth);
  return {
    baseUrl,
    ...(nonEmptyString(value.path) ? { path: nonEmptyString(value.path)! } : {}),
    ...(nonEmptyString(value.model) ? { model: nonEmptyString(value.model)! } : {}),
    ...(isTransport(value.transport) ? { transport: value.transport } : {}),
    ...(isAuth(value.auth) ? { auth: value.auth } : {}),
    ...(nonEmptyString(value.apiKey) ? { apiKey: nonEmptyString(value.apiKey)! } : {}),
    ...(oauth ? { oauth } : {}),
    ...(isEffort(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(stringMap(value.headers) ? { headers: stringMap(value.headers)! } : {}),
  };
}

export function parseConfig(raw: unknown): DesktopConfig {
  if (!isRecord(raw)) return { model: "", models: [] };
  const providers = parseProviders(raw.providers);
  return {
    model: nonEmptyString(raw.model) ?? "",
    models: stringList(raw.models),
    ...(nonEmptyString(raw.systemPrompt) ? { systemPrompt: nonEmptyString(raw.systemPrompt)! } : {}),
    ...(parseProvider(raw.provider) ? { provider: parseProvider(raw.provider)! } : {}),
    ...(providers.length ? { providers } : {}),
    ...(nonEmptyString(raw.activeProvider) ? { activeProvider: nonEmptyString(raw.activeProvider)! } : {}),
    ...(contextWindowsOf(raw.contextWindows) ? { contextWindows: contextWindowsOf(raw.contextWindows)! } : {}),
    ...(typeof raw.maxToolRounds === "number" && raw.maxToolRounds > 0 ? { maxToolRounds: raw.maxToolRounds } : {}),
  };
}

/**
 * Read `config.json`, or an empty config when it is missing or unreadable.
 *
 * `ACTOR0_MODEL` is applied here rather than at resolution time, and it wins:
 * a shell that cannot override the model cannot point a CI job at a different
 * one without editing a file. The endpoint override is applied at resolution
 * time (see `resolveProvider`) because it also suppresses the stored provider
 * entirely, which is a decision about *which* credential to use.
 */
export function loadConfig(): DesktopConfig {
  let raw: string;
  try {
    raw = readFileSync(configFile(), "utf8");
  } catch {
    raw = "{}";
  }
  let parsed: DesktopConfig;
  try {
    parsed = parseConfig(JSON.parse(raw));
  } catch {
    parsed = { model: "", models: [] };
  }
  const envModel = process.env.ACTOR0_MODEL?.trim();
  return envModel ? { ...parsed, model: envModel } : parsed;
}

/** Persist config, creating the directory and locking the file to the owner. */
export function saveConfig(config: DesktopConfig): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  // When the registry exists it is the only shape written: a legacy single
  // `provider` alongside it would be two sources of truth for one endpoint,
  // and `JSON.stringify` drops the `undefined`, so the stale field disappears.
  const toWrite = config.providers ? { ...config, provider: undefined } : config;
  writeFileSync(file, `${JSON.stringify(toWrite, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Replace `${NAME}` with the value of that environment variable.
 *
 * An unset variable is an error naming the variable. Substituting an empty
 * string would authenticate as nobody and surface as a 401 that reads like a
 * wrong model — a genuinely hard thing to diagnose from the outside.
 */
function expandEnv(value: string, field: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = process.env[name];
    if (found === undefined) {
      throw new ConfigError(
        `${field} refers to \${${name}}, but ${name} is not set in the environment.`,
      );
    }
    return found;
  });
}

/**
 * The endpoint in play, resolved to what a request will actually use.
 *
 * Mirrors `resolveProvider` in the CLI, including the environment precedence,
 * so a config written by either host resolves identically in both.
 */
export function resolveProvider(config: DesktopConfig): ResolvedProvider {
  const envBaseUrl = process.env.ACTOR0_BASE_URL?.trim();
  const stored = envBaseUrl ? undefined : activeNamedProvider(config) ?? config.provider;
  const baseUrl = envBaseUrl || stored?.baseUrl;
  if (!baseUrl) {
    throw new ConfigError(
      "No provider is configured. Add one with /provider, or set ACTOR0_BASE_URL.",
    );
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigError(`The base URL must use http or https, not ${url.protocol.replace(":", "")}.`);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `"${baseUrl}" is not a URL. Set a full base URL, for example https://api.example.com/v1.`,
    );
  }

  const transport: ProviderTransport = stored?.transport ?? "openai";
  // An explicit path replaces the whole pathname; otherwise the transport
  // appends its own default to whatever prefix the base URL carries.
  const explicitPath = process.env.ACTOR0_PATH?.trim() || stored?.path;
  const model = (stored?.model || config.model || "").trim();
  if (!model) {
    throw new ConfigError("No model is set. Run /model <name>, or set ACTOR0_MODEL.");
  }

  const auth: ProviderAuth = stored?.auth ?? "api-key";
  const envKey = process.env.ACTOR0_API_KEY?.trim();
  const rawKey = envKey || stored?.apiKey;
  const apiKey = rawKey ? expandEnv(rawKey, "apiKey") : undefined;
  const oauth = stored?.oauth;
  if (auth === "oauth" && !oauth?.accessToken) {
    throw new ConfigError(
      "This provider signs in with OAuth but has no token — add it again with /provider and authorize.",
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored?.headers ?? {})) {
    headers[name] = expandEnv(value, `headers.${name}`);
  }

  return {
    baseUrl,
    ...(explicitPath ? { path: explicitPath } : {}),
    model,
    transport,
    auth,
    ...(apiKey ? { apiKey, apiKeySource: envKey ? "ACTOR0_API_KEY" : "config.json" } : {}),
    ...(oauth ? { oauth } : {}),
    ...(stored?.reasoningEffort ? { reasoningEffort: stored.reasoningEffort } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/** A credential, shown well enough to be recognisable and never to be usable. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return "none";
  if (secret.length <= 8) return `${secret.slice(0, 2)}... (${secret.length} chars)`;
  return `${secret.slice(0, 6)}...${secret.slice(-2)} (${secret.length} chars)`;
}

/**
 * The endpoint as the status line and the provider panel show it.
 *
 * Everything here is safe to screenshot: the credential is masked, and the
 * `from` field names *where* it came from rather than repeating it. A feature
 * that cannot be inspected is a feature that cannot be debugged, and a request
 * that goes somewhere the user cannot account for is the one thing this app
 * must never do.
 */
export function describeProviderInfo(provider: ResolvedProvider): {
  endpoint: string;
  model: string;
  transport: string;
  credential: string;
  credentialSource?: string;
  headers?: string[];
  reasoningEffort?: string;
} {
  const headers = Object.keys(provider.headers ?? {});
  return {
    endpoint: endpointUrl(provider),
    model: provider.model,
    transport: provider.transport ?? "openai",
    credential: provider.apiKey ? `set — ${maskSecret(provider.apiKey)}` : "not set",
    ...(provider.apiKeySource ? { credentialSource: `from ${provider.apiKeySource}` } : {}),
    ...(headers.length ? { headers } : {}),
    ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
  };
}

/** The URL the request will actually go to. */
export function endpointUrl(provider: ResolvedProvider): string {
  if (provider.path) return new URL(provider.path, provider.baseUrl).toString();
  const base = provider.baseUrl.replace(/\/+$/, "");
  const transport = provider.transport ?? "openai";
  const suffix =
    transport === "anthropic" ? "/v1/messages" : transport === "chatgpt" ? "/responses" : "/chat/completions";
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

// --- the registry the provider menu drives ----------------------------------

/**
 * Every registered endpoint as one list, projecting a legacy single `provider`
 * in memory when that is all the config carries. Reading never rewrites the
 * file; only a real change persists the new shape.
 */
export function namedProviders(config: DesktopConfig): NamedProvider[] {
  if (config.providers) return config.providers;
  if (config.provider?.baseUrl) {
    return [{ ...config.provider, name: providerName(config.provider.baseUrl) }];
  }
  return [];
}

/**
 * The active registered endpoint, or undefined when the built-in is in use.
 *
 * With a `providers` list, `activeProvider` is the single source of truth and
 * its absence *means the built-in* — which is what makes "use built-in" a real
 * choice rather than something a fallback would undo.
 */
export function activeNamedProvider(config: DesktopConfig): NamedProvider | undefined {
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
export function addProvider(config: DesktopConfig, entry: Omit<NamedProvider, "name"> & { name?: string }): DesktopConfig {
  const list = namedProviders(config);
  const base = entry.name?.trim() || providerName(entry.baseUrl);
  const name = uniqueProviderName(base, list.map((p) => p.name));
  const named: NamedProvider = {
    ...entry,
    name,
    ...(entry.models?.length ? { models: entry.models } : entry.model ? { models: [entry.model] } : {}),
  };
  return { ...config, providers: [...list.filter((p) => p.name !== name), named], activeProvider: name };
}

/** Switch the active endpoint by name; a no-op when the name is unknown. */
export function setActiveProvider(config: DesktopConfig, name: string): DesktopConfig {
  const list = namedProviders(config);
  if (!list.some((entry) => entry.name === name)) return config;
  return { ...config, providers: list, activeProvider: name };
}

/** Remove a registered endpoint. If it was active, the first survivor stands in. */
export function removeProvider(config: DesktopConfig, name: string): DesktopConfig {
  const list = namedProviders(config).filter((entry) => entry.name !== name);
  const next = { ...config, providers: list };
  if (list.length === 0) return { ...next, activeProvider: undefined };
  return { ...next, activeProvider: config.activeProvider === name ? list[0]!.name : config.activeProvider };
}

/**
 * Set the active model, adding it to the remembered list when new.
 *
 * Written to whichever field the *current* endpoint reads, so switching
 * endpoints cannot leave behind a model the new one does not have.
 */
export function withModel(config: DesktopConfig, model: string): DesktopConfig {
  const active = activeNamedProvider(config);
  if (active && config.providers) {
    return {
      ...config,
      model,
      providers: config.providers.map((entry) =>
        entry.name === active.name
          ? {
              ...entry,
              model,
              models: [model, ...(entry.models ?? (entry.model ? [entry.model] : [])).filter((m) => m !== model)].slice(0, 20),
            }
          : entry,
      ),
    };
  }
  const models = config.models.includes(model) ? config.models : [model, ...config.models];
  const trimmed = { ...config, models: models.slice(0, 20) };
  const custom = process.env.ACTOR0_BASE_URL?.trim() || config.provider?.baseUrl;
  if (custom && config.provider) {
    return { ...trimmed, provider: { ...config.provider, model } };
  }
  return { ...trimmed, model };
}

/** Add models to the picker's list, keeping the newest and capping at 20. */
export function addModels(
  config: DesktopConfig,
  models: string[],
  windows: Record<string, number> = {},
  provider?: string,
): DesktopConfig {
  const target = provider ?? activeNamedProvider(config)?.name;
  const entry = target && config.providers ? config.providers.find((p) => p.name === target) : undefined;
  let next: DesktopConfig;
  if (entry && config.providers) {
    next = {
      ...config,
      providers: config.providers.map((p) =>
        p.name === entry.name
          ? { ...p, models: [...new Set([...models, ...(p.models ?? (p.model ? [p.model] : []))])].slice(0, 20) }
          : p,
      ),
    };
  } else {
    next = { ...config, models: [...new Set([...models, ...config.models])].slice(0, 20) };
  }
  for (const [model, win] of Object.entries(windows)) next = withContextWindow(next, model, win);
  return next;
}

/** Record a model's context window (from a picker fetch or an overflow error). */
export function withContextWindow(config: DesktopConfig, model: string, window: number): DesktopConfig {
  const existing = config.contextWindows ?? {};
  if (existing[model] === window) return config;
  return { ...config, contextWindows: { ...existing, [model]: window } };
}

/** Set (or clear) the reasoning effort on the active provider; no-op with none. */
export function withActiveReasoningEffort(
  config: DesktopConfig,
  effort: "low" | "medium" | "high" | undefined,
): DesktopConfig {
  const active = activeNamedProvider(config);
  if (!active || !config.providers) return config;
  return {
    ...config,
    providers: config.providers.map((entry) =>
      entry.name === active.name
        ? { ...entry, ...(effort ? { reasoningEffort: effort } : { reasoningEffort: undefined }) }
        : entry,
    ),
  };
}

/** Replace the active provider's stored OAuth tokens. */
export function withActiveOAuth(config: DesktopConfig, tokens: OAuthTokens): DesktopConfig {
  const active = activeNamedProvider(config);
  if (!active || !config.providers) return config;
  return {
    ...config,
    providers: config.providers.map((entry) => (entry.name === active.name ? { ...entry, oauth: tokens } : entry)),
  };
}
