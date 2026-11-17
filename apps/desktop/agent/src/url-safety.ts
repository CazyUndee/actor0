import { isIP } from "node:net";

/**
 * SSRF guard for URLs the user (or a config file) hands the agent.
 *
 * `model.discoverFor`, `listModels`, `provider.test` and `openUrl` all fetch an
 * endpoint the caller names. Without a check, a token holder can aim them at
 * 127.0.0.1, RFC1918 ranges or link-local addresses and read the responses
 * through the model's transcript. This is the shared gate.
 */

const PRIVATE_HOSTS = new Set(["localhost", "0.0.0.0", "::", "::1"]);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  // IPv4-mapped
  const v4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return isPrivateIpv4(v4[1]!);
  return false;
}

export function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (PRIVATE_HOSTS.has(host.toLowerCase())) return false;
  const kind = isIP(host);
  if (kind === 4) return !isPrivateIpv4(host);
  if (kind === 6) return !isPrivateIpv6(host);
  // A bare name: block obvious local-ish suffixes.
  if (host.toLowerCase().endsWith(".localhost") || host.toLowerCase().endsWith(".local")) return false;
  return true;
}

export function assertPublicHttpUrl(value: string): void {
  if (!isPublicHttpUrl(value)) {
    throw new Error("that URL points at a private or local address, which is not allowed");
  }
}