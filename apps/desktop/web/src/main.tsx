import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { available, startAgent } from "./shell";

/**
 * Mount.
 *
 * The agent is started *before* the UI is mounted when a shell is present, so
 * the first render can already find it and the app does not flash a
 * "connecting" state on every launch. In a browser there is no shell, the start
 * is a no-op, and the UI falls back to the dev default.
 */
async function boot(): Promise<void> {
  if (available()) {
    try {
      await startAgent();
    } catch (error) {
      // The app still mounts: the UI's own reconnect loop is the thing that
      // keeps trying, and a fatal error screen would hide the message the
      // connection banner already shows.
      console.error("actor0: agent start failed", error);
    }
  }
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root element to mount into");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
