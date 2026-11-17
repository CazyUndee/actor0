import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { setDiscoveredEndpoint } from "./client";
import { available, generateAgentToken, startAgent } from "./shell";
import { mayConnect } from "./neutralino-loader";


/**
 * Connect the Neutralino client when native APIs are needed.
 *
 * With tokenSecurity "none" the served globals carry the real session token,
 * so the library (loaded by index.html) just needs init() + ready. This is
 * what makes window controls and dragging work in the borderless window.
 */
async function ensureNeutralinoClient(): Promise<void> {
  const w = window as unknown as {
    NL_TOKEN?: string;
    Neutralino?: {
      init?: () => void;
      events?: { on?: (name: string, handler: () => void) => Promise<void> };
    };
  };
  const api = w.Neutralino;
  if (!api) return;
  // mayConnect (neutralino-loader.ts, tested) is the NE_CL_IVCTOKN guard: an
  // empty token must never reach init(), because the library treats a failed
  // auth handshake by replacing the entire page.
  if (!mayConnect({ get NL_TOKEN() { return w.NL_TOKEN; }, Neutralino: api })) {
    await NeutralinoLog("refusing to connect the Neutralino client without a token (NE_CL_IVCTOKN guard)");
    return;
  }
  try {
    api.init?.();
  } catch {
    /* already initialized */
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      void api.events?.on?.("ready", done);
    } catch {
      /* ignore */
    }
    setTimeout(done, 4_000);
  });
  await NeutralinoLog(w.NL_TOKEN ? "Neutralino client connected (token present)" : "Neutralino library without token");
}

/**
 * Mount.
 *
 * The agent is started *before* the UI is mounted when a shell is present, and
 * the port it reports is handed straight to the client — not re-derived. That
 * hand-off is the whole handshake: `startAgent` watches the agent's stdout for
 * its port, and a port thrown away here is a UI that guesses 3000 while a live
 * agent sits on an OS-assigned one nobody is talking to.
 */
async function boot(): Promise<void> {
  try {
    // With tokenSecurity "none", the served globals carry the real token, so
    // index.html loads globals + library directly and this connects them —
    // which is what makes window controls and dragging work in window mode.
    await ensureNeutralinoClient();

    let agentPort: number | undefined;
    // The agent's localhost socket is reachable by any local process and exposes
    // the provider config and the full tool set, so it is generated a token and
    // started with it: without one the server disables auth entirely (T-2).
    const agentToken = available() ? generateAgentToken() : undefined;
    // The launcher starts the agent and publishes its port as a static file. If
    // that file is there the agent is already running: spawning another one
    // through Neutralino fails on the port, and boot() threw before mounting the
    // UI. Only spawn when nothing has claimed the job.
    const launched = await readLaunchedAgentPort();
    if (launched !== null) {
      agentPort = launched;
      await NeutralinoLog(`using the agent the launcher started on port ${launched}`);
    } else if (available()) {
      try {
        agentPort = await startAgent(agentToken ? { token: agentToken } : {});
        await NeutralinoLog(`agent started on port ${agentPort}`);
      } catch (error) {
        // The app still mounts: the UI's own reconnect loop (and the served
        // port file a launcher may have written) is what keeps trying, and a
        // fatal error screen would hide the message the banner already shows.
        const message = error instanceof Error ? error.message : String(error);
        await NeutralinoLog(`agent start failed: ${message}`);
        console.error("actor0: agent start failed", error);
      }
    } else {
      await NeutralinoLog(
        `shell not available — Neutralino=${typeof (window as { Neutralino?: unknown }).Neutralino}, ` +
          `os=${typeof (window as { Neutralino?: { os?: unknown } }).Neutralino?.os}`,
      );
    }
    if (agentPort !== undefined) setDiscoveredEndpoint(agentPort, agentToken);

    const root = document.getElementById("root");
    if (!root) throw new Error("no #root element to mount into");
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (error) {
    // A boot that dies silently is a white window with nothing to diagnose.
    // The error goes where the user can see it and where the log file catches
    // it for a report.
    console.error("actor0: boot failed", error);
    const pre = document.createElement("pre");
    pre.style.padding = "2rem";
    pre.style.color = "#c46b6b";
    pre.style.font = "13px/1.5 ui-monospace,monospace";
    pre.textContent = `actor0 failed to start:\n${error instanceof Error ? error.stack ?? error.message : String(error)}`;
    document.body.replaceChildren(pre);
  }
}

void boot();

/** One diagnostic line into the shell's own log, where a report can read it. */async function NeutralinoLog(message: string): Promise<void> {
  try {
    const api = (window as unknown as { Neutralino?: { debug?: { log?: (line: string) => Promise<void> } } }).Neutralino;
    await api?.debug?.log?.(`[actor0] ${message}`);
  } catch {
    /* diagnostics must never be the thing that breaks the app */
  }
}

/**
 * The port the launcher already started the agent on, if any.
 *
 * The launcher writes `agent-port.json` next to the page precisely so the UI can
 * find an agent it did not start. Reading it here is what stops boot() from
 * spawning a second agent on the same machine (which fails on the port and, if
 * it throws, stops React from ever mounting).
 */
async function readLaunchedAgentPort(): Promise<number | null> {
  // The dev launcher writes agent-port.json inside the served root; the
  // packaged launcher writes agent/port.json beside the exe (where the page
  // reaches it through the scoped filesystem API with NL_PATH). The HTTP
  // fetch is dev-only because the packaged document root is the read-only
  // resources.neu bundle.
  try {
    const res = await fetch("/agent-port.json", { cache: "no-store" });
    if (res.ok) {
      const info = (await res.json()) as { port?: unknown };
      if (typeof info.port === "number" && info.port > 0) return info.port;
    }
  } catch {
    /* dev file absent in the packaged app */
  }
  const fs = window.Neutralino?.filesystem;
  const base = window.NL_PATH;
  if (fs && base) {
    try {
      const raw = await fs.readFile(`${base}/agent/port.json`);
      const info = JSON.parse(raw) as { port?: unknown };
      if (typeof info.port === "number" && info.port > 0) return info.port;
    } catch {
      /* the launcher has not run or its agent is gone; boot falls back */
    }
  }
  return null;
}
