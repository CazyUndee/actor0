import { homedir } from "node:os";
import { join } from "node:path";

/**
 * XDG-compliant locations, with environment overrides so tests never touch a
 * real user's home directory.
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

/** Directory holding saved sessions. */
export const dataDir = (): string => base("ACTOR0_DATA_DIR", "XDG_DATA_HOME", [".local", "share"]);

export const configFile = (): string => join(configDir(), "config.json");
export const sessionsDir = (): string => join(dataDir(), "sessions");
