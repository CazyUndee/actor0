import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./paths.js";
import { RESPITE } from "./providers.js";

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
  /** Defaults to `/chat/completions` appended to `baseUrl`. */
  path?: string;
  /**
   * The model to ask of *this* endpoint.
   *
   * Held here rather than in one flat field so that switching endpoints cannot
   * carry a model name across with it — a model that exists on one gateway and
   * not another is the same class of silent drift as a stale base URL, and it
   * is the one the user cannot see at all, because the model *is* displayed.
   * `/model` writes to whichever of the two applies, so this is never
   * something a user has to think about.
   */
  model?: string;
  /**
   * The credential, if the endpoint wants one.
   *
   * `${NAME}` is replaced with that environment variable, so a key can be
   * supplied without ever being written to disk. An unset variable is an error
   * rather than an empty string: sending `Bearer ` and reading a 401 as a
   * model problem is a worse afternoon than being told which variable is unset.
   */
  apiKey?: string;
  /** Extra request headers, for gateways that need them. Values take `${NAME}`. */
  headers?: Record<string, string>;
};

export type CliConfig = {
  /** Model asked of the built-in endpoint. */
  model: string;
  /** Models offered by `/model`, most recent first. */
  models: string[];
  /** Replaces the built-in system prompt when set. */
  systemPrompt?: string;
  /** Absent means the built-in endpoint. */
  provider?: ProviderConfig;
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
  path: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Where the credential came from, for display. Never the credential. */
  apiKeySource?: string;
  /** Absent or false means the built-in endpoint. */
  custom?: boolean;
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

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).map(([key, entry]) => [key, nonEmptyString(entry) ?? ""] as const);
  const kept = entries.filter(([, entry]) => entry.length > 0);
  return kept.length ? Object.fromEntries(kept) : undefined;
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
  const provider: ProviderConfig | undefined = baseUrl
    ? {
        baseUrl,
        ...(nonEmptyString(stored.provider?.path) ? { path: nonEmptyString(stored.provider?.path)! } : {}),
        ...(nonEmptyString(stored.provider?.model) ? { model: nonEmptyString(stored.provider?.model)! } : {}),
        ...(nonEmptyString(stored.provider?.apiKey) ? { apiKey: nonEmptyString(stored.provider?.apiKey)! } : {}),
        ...(stringMap(stored.provider?.headers) ? { headers: stringMap(stored.provider?.headers)! } : {}),
      }
    : undefined;

  return {
    // Old files kept the model under `provider.model`; new ones keep it flat.
    model:
      (typeof stored.model === "string" ? stored.model.trim() : "") ||
      (typeof stored.provider?.model === "string" ? stored.provider.model.trim() : ""),
    models,
    ...(provider ? { provider } : {}),
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
    model: envModel || file.model || RESPITE.model,
    models: file.models,
    ...(file.provider ? { provider: file.provider } : {}),
    ...(file.systemPrompt ? { systemPrompt: file.systemPrompt } : {}),
  };
}

/**
 * The endpoint plus the chosen model, with nothing left to guess.
 *
 * A custom endpoint is resolved field by field, so a half-configured one fails
 * here with a message naming the field rather than at the first request with
 * an opaque 404. The built-in endpoint is not a special case in the code, only
 * in the default values: one path, so a custom endpoint cannot behave
 * differently from a built-in one in some way nobody thought about.
 */
export function resolveProvider(config: CliConfig): ResolvedProvider {
  const envBase = process.env.ACTOR0_BASE_URL?.trim();
  const stored = config.provider;
  const baseUrl = envBase || stored?.baseUrl || RESPITE.baseUrl;
  const custom = baseUrl !== RESPITE.baseUrl;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(
      `"${baseUrl}" is not a URL. Set a full base URL, for example https://api.example.com/v1.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`The base URL must use http or https, not ${url.protocol.replace(":", "")}.`);
  }

  // A custom endpoint gets the OpenAI convention, not the built-in one.
  // `/api/chat` is the single path in this program that is not part of the
  // OpenAI shape, and carrying it to somebody else's gateway is a 404 on the
  // very first request — a failure that looks like a bad key, because the
  // credential is the thing people go and check first.
  const path = process.env.ACTOR0_PATH?.trim() || stored?.path || (custom ? "/chat/completions" : RESPITE.path);
  const model = (custom ? stored?.model : config.model) || config.model || RESPITE.model;
  if (!model.trim()) {
    throw new ConfigError("No model is set. Run /model <name>, or set ACTOR0_MODEL.");
  }

  const rawKey = process.env.ACTOR0_API_KEY ?? stored?.apiKey;
  const apiKey = rawKey ? expandEnv(rawKey, "apiKey") : undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored?.headers ?? {})) {
    headers[name] = expandEnv(value, `headers.${name}`);
  }

  return {
    baseUrl,
    path,
    model: model.trim(),
    ...(apiKey ? { apiKey, apiKeySource: process.env.ACTOR0_API_KEY ? "ACTOR0_API_KEY" : "config.json" } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(custom ? { custom: true } : {}),
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

/** `/provider`, as lines. Everything here is safe to screenshot. */
export function describeProvider(provider: ResolvedProvider): string[] {
  return [
    `endpoint   ${provider.baseUrl}${provider.path}`,
    `model      ${provider.model}`,
    `credential ${provider.apiKey ? `set — ${maskSecret(provider.apiKey)}` : "not set"}`,
    ...(provider.apiKeySource ? [`from       ${provider.apiKeySource}`] : []),
    ...(provider.custom && Object.keys(provider.headers ?? {}).length
      ? [`headers    ${Object.keys(provider.headers!).join(", ")}`]
      : []),
  ];
}

/** Persist config, creating the directory and locking the file to the owner. */
export function saveConfig(config: CliConfig): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
  const custom = process.env.ACTOR0_BASE_URL?.trim() || config.provider?.baseUrl;
  if (custom && custom !== RESPITE.baseUrl) {
    return { ...trimmed, provider: { ...config.provider!, model } };
  }
  return { ...trimmed, model };
}
