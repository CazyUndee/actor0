import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { setDiscoveredEndpoint } from "./client";
import { available, startAgent } from "./shell";


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
    if (available()) {
      try {
        agentPort = await startAgent();
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
    if (agentPort !== undefined) setDiscoveredEndpoint(agentPort);

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
    document.body.innerHTML = `<pre style="padding:2rem;color:#c46b6b;font:13px/1.5 ui-monospace,monospace">actor0 failed to start:\n${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }</pre>`;
  }
}

void boot();

/** One diagnostic line into the shell's own log, where a report can read it. */
async function NeutralinoLog(message: string): Promise<void> {
  try {
    const api = (window as unknown as { Neutralino?: { debug?: { log?: (line: string) => Promise<void> } } }).Neutralino;
    await api?.debug?.log?.(`[actor0] ${message}`);
  } catch {
    /* diagnostics must never be the thing that breaks the app */
  }
}
