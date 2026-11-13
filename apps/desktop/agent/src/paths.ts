import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where actor0 keeps its files — the same locations the CLI uses.
 *
 * Shared *by format*, not by code: the desktop app writes the same
 * `config.json`, the same `sessions/*.json` and the same `usage.jsonl` under
 * the same roots, so a session started in one is resumable in the other. The
 * two hosts never import each other, which is the boundary the whole project
 * exists to demonstrate; they agree on a file format instead.
 *
 * Every root has an environment override so a test never touches a real home
 * directory, and each override names the same variable the CLI reads.
 */

function base(envVar: string, xdg: string, fallback: readonly string[]): string {
  const override = process.env[envVar]?.trim();
  if (override) return override;
  const xdgValue = process.env[xdg]?.trim();
  if (xdgValue) return join(xdgValue, "actor0");
  return join(homedir(), ...fallback, "actor0");
}

/** Directory holding `config.json`. */
export const configDir = (): string => base("ACTOR0_CONFIG_DIR", "XDG_CONFIG_HOME", [".config"]);

/** Directory holding saved sessions and the usage log. */
export const dataDir = (): string => base("ACTOR0_DATA_DIR", "XDG_DATA_HOME", [".local", "share"]);

export const configFile = (): string => join(configDir(), "config.json");
export const sessionsDir = (): string => join(dataDir(), "sessions");
