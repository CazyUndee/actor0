/**
 * The endpoint.
 *
 * There is exactly one, and it is not configurable. It holds its own
 * credential and expects no API key from us, so the CLI has nothing to prompt
 * for and nothing to store.
 *
 * This replaces a preset table that let the user point the CLI anywhere. The
 * cost of that flexibility was not the code — it was that a stored `baseUrl`
 * outlived the reason for it, and a request went to a host that needed a
 * credential we did not have while every visible signal said the right
 * provider was in use. A single endpoint cannot drift.
 */

export const RESPITE = {
  name: "respite",
  label: "Respite development endpoint",
  baseUrl: "https://aestral-chat.vercel.app",
  path: "/api/chat",
  model: "swiss-ai/apertus-v1.5-70b",
} as const;

/** The host, for the footer. */
export const RESPITE_HOST = new URL(RESPITE.baseUrl).host;

/** One-line summary for `--help` and `/help`. */
export const PROVIDER_SUMMARY = `${RESPITE.baseUrl}${RESPITE.path} (no API key needed)`;
