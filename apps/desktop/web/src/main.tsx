import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { setDiscoveredEndpoint } from "./client";
import { available, startAgent } from "./shell";


/** Connect the Neutralino client library when in window mode. */
async function ensureNeutralinoClient(): Promise<void> {
  const w = window as unknown as {
    NL_MODE?: string;
    NL_TOKEN?: string;
    Neutralino?: {
      init?: () => void;
      events?: { on?: (name: string, handler: () => void) => Promise<void> };
    };
  };

  const waitReady = (api: NonNullable<typeof w.Neutralino>): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => { if (!settled) { settled = true; resolve(); } };
      try { void api.events?.on?.("ready", done); } catch { /* ignore */ }
      setTimeout(done, 4_000);
    });

  // Already connected (injected with a real token and library).
  if (w.Neutralino && w.NL_TOKEN) {
    try { w.Neutralino.init?.(); } catch { /* already initialized */ }
    await waitReady(w.Neutralino);
    return;
  }

  // Only window mode needs the native client; chrome mode must not load it
  // against an empty token (it replaces the page with NE_CL_IVCTOKN).
  if (w.NL_MODE !== "window") return;

  // Fetch the real token the launcher wrote (it appears shortly after start).
  let token: string | undefined;
  let nlPort: number | undefined;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("/shell-mode.json", { cache: "no-store" });
      if (res.ok) {
        const info = (await res.json()) as { nlToken?: string; nlPort?: number };
        if (info.nlToken) { token = info.nlToken; nlPort = info.nlPort; break; }
      }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!token) {
    await NeutralinoLog("window mode: no Neutralino token available — native APIs disabled");
    return;
  }

  w.NL_TOKEN = token;
  if (nlPort) (w as { NL_PORT?: number }).NL_PORT = nlPort as unknown as undefined;

  // Load the client library if injection didn't provide it.
  if (!w.Neutralino) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/neutralino.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load neutralino.js"));
      document.head.appendChild(s);
    }).catch(() => {});
  }

  const api = (window as unknown as { Neutralino?: NonNullable<typeof w.Neutralino> }).Neutralino;
  if (!api) {
    await NeutralinoLog("window mode: neutralino.js loaded but Neutralino global missing");
    return;
  }
  try { api.init?.(); } catch { /* ignore */ }
  await waitReady(api);
  await NeutralinoLog("Neutralino client connected (window mode)");
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
    // In window mode the Neutralino client must be connected for native APIs
    // (window controls, dragging). The static globals endpoint serves an empty
    // token, so boot fetches the real one (written by the launcher) and loads
    // the library before init. In chrome mode the library is intentionally not
    // loaded — an empty-token connection destroys the page.
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
