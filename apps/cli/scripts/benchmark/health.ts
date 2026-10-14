import { createModel } from "@actor0/providers";
import { loadConfig, resolveProvider } from "../../src/config.js";

/**
 * A gateway health probe.
 *
 * Measured against this endpoint: reliability swings wildly between patches —
 * the same task takes ~6s in a good patch and ~69s in a bad one, and in a bad
 * patch the model flails (claims it has no tools, retries, burns 4-16 calls on
 * a one-call task). A loop that runs a measured turn blind spends that turn
 * discovering the patch is bad, then throws the data away.
 *
 * So: probe first. One trivial turn — \"reply with ok\" — costs ~5k tokens and
 * tells us whether the gateway is in a state where a measurement means
 * anything. A slow or failed probe means the patch is bad and the loop waits
 * rather than burning a turn.
 */

export type Health = "ok" | "slow" | "down";

export type HealthCheck = {
  health: Health;
  /** Wall time of the probe turn, ms. */
  latencyMs: number;
  /** Why it was not `ok`, for the log. */
  reason?: string;
};

/** Above this, a trivial reply means the gateway is degraded. */
export const SLOW_PROBE_MS = 20_000;

/** Drive one trivial turn through the real provider and time it. */
export async function probeGateway(options: { timeoutMs?: number; providerName?: string } = {}): Promise<HealthCheck> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 45_000;
  try {
    const config = loadConfig();
    // Probe the provider the caller will measure on, not just the active one: a
    // loop that overrides providers must not gate on a gateway it is not using.
    const provider = resolveProvider(
      options.providerName ? { ...config, activeProvider: options.providerName } : config,
    );
    const client = createModel(provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const iterator = client.stream(
        [{ role: "user", content: "Reply with exactly: ok" }],
        [],
        controller.signal,
      )[Symbol.asyncIterator]();
      let sawText = false;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.type === "token") sawText = true;
      }
      const latencyMs = Date.now() - started;
      if (!sawText) return { health: "down", latencyMs, reason: "the probe produced no text" };
      if (latencyMs > SLOW_PROBE_MS) return { health: "slow", latencyMs, reason: `took ${latencyMs}ms` };
      return { health: "ok", latencyMs };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const latencyMs = Date.now() - started;
    return { health: "down", latencyMs, reason: error instanceof Error ? error.message : String(error) };
  }
}
