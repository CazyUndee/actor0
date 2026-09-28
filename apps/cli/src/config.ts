import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./paths.js";
import { RESPITE } from "./providers.js";

/**
 * Configuration.
 *
 * There is no provider to configure. The CLI talks to one endpoint, which
 * holds its own credential and needs no key from us, so the only thing left to
 * remember is which model to ask it for. Everything that used to live here —
 * base URL, API key, request path, preset name, and the four-level precedence
 * that let a stored `baseUrl` silently outrank the endpoint you meant — is
 * gone, because with one endpoint there is nothing for any of it to decide.
 *
 * A `config.json` written by an older build is still read: its `provider.model`
 * is honoured, and everything else in it is ignored. That keeps an existing
 * session working without telling anyone to go edit a file by hand, and it means
 * a stale `baseUrl` can no longer send traffic anywhere.
 */

export type CliConfig = {
  /** Model asked of the endpoint. */
  model: string;
  /** Models offered by `/model`, most recent first. */
  models: string[];
  /** Replaces the built-in system prompt when set. */
  systemPrompt?: string;
};

/** The endpoint, resolved. Not configurable — see the note above. */
export type ResolvedProvider = {
  baseUrl: string;
  path: string;
  model: string;
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

  const stored = parsed as Partial<CliConfig> & {
    provider?: { model?: unknown; baseUrl?: unknown; apiKey?: unknown };
  };
  const models = Array.isArray(stored.models)
    ? stored.models.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    // Old files kept the model under `provider.model`; new ones keep it flat.
    model:
      (typeof stored.model === "string" ? stored.model.trim() : "") ||
      (typeof stored.provider?.model === "string" ? stored.provider.model.trim() : ""),
    models,
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
    ...(file.systemPrompt ? { systemPrompt: file.systemPrompt } : {}),
  };
}

/** The endpoint plus the chosen model. There is nothing to validate. */
export function resolveProvider(config: CliConfig): ResolvedProvider {
  return { baseUrl: RESPITE.baseUrl, path: RESPITE.path, model: config.model || RESPITE.model };
}

/** Persist config, creating the directory and locking the file to the owner. */
export function saveConfig(config: CliConfig): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // `mode` is ignored when the file already exists, so set it explicitly.
  chmodSync(file, 0o600);
}

/** Set the active model, adding it to the remembered list if it is new. */
export function withModel(config: CliConfig, model: string): CliConfig {
  const models = config.models.includes(model) ? config.models : [model, ...config.models];
  return { ...config, model, models: models.slice(0, 20) };
}
