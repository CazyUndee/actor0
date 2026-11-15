#!/usr/bin/env node
/**
 * Launch the desktop app end-to-end: start the agent, write its port where the
 * UI can read it, then open Neutralino in chrome mode.
 *
 * This is the reliable dev path: it does not depend on the page being able to
 * call Neutralino's native API (which needs a valid client token — something
 * chrome mode does not inject into a fetchable globals file), and it does not
 * depend on the agent picking port 3000. The agent prints its port; this script
 * catches it and serves it to the UI as a static file.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const agentBundle = path.join(web, "resources", "agent", "agent.mjs");
const servedPortFile = path.join(web, "resources", "app", "agent-port.json");
const shellModeFile = path.join(web, "resources", "app", "shell-mode.json");
const authInfoFile = path.join(web, ".tmp", "auth_info.json");
const neuExe = path.join(web, "bin", "neutralino-win_x64.exe");

const children = new Set();

function killAll() {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
}

process.on("exit", killAll);
process.on("SIGINT", () => { killAll(); process.exit(130); });
process.on("SIGTERM", () => { killAll(); process.exit(143); });

/** Start the agent and resolve with the port it reports on stdout. */
async function startAgent() {
  const child = spawn("node", [agentBundle], {
    cwd: web,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    console.error(`[run] agent exited (code=${code} signal=${signal})`);
  });
  child.stderr.on("data", (d) => process.stderr.write(`[agent] ${d}`));

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("agent did not report a port within 15s")), 15_000);
    let buf = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      process.stdout.write(`[agent] ${text}`);
      buf += text;
      const m = /"port"\s*:\s*(\d+)/.exec(buf);
      if (m) { clearTimeout(timeout); resolve(Number(m[1])); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`agent exited early (code=${code})`)); });
  });

  await mkdir(path.dirname(servedPortFile), { recursive: true });
  await writeFile(servedPortFile, JSON.stringify({ port, pid: child.pid }), "utf8");
  console.log(`[run] agent ready on ws://127.0.0.1:${port} (wrote ${path.relative(web, servedPortFile)})`);
  return { child, port };
}

/**
 * Strip the native frame from the borderless window.
 *
 * resizable:true makes Neutralino add WS_THICKFRAME, and it re-adds it after
 * any SWP_FRAMECHANGED. That frame is a real non-client area: the client rect
 * shrinks by 7px on every side and DWM paints the band (it showed up as an
 * accent-blue strip along the top). With the style removed the client area is
 * the whole window, so the only border is the CSS hairline.
 *
 * Resize is in-page (invisible edge handles) because the native frame is gone.
 */
/**
 * Make the window frameless and rounded.
 *
 * Two Windows behaviours the app cannot reach from CSS:
 *
 *  1. WS_THICKFRAME is a real non-client area: the client rect shrinks by 7px
 *     on every side and DWM paints that band (the light strip that used to run
 *     along the top). Removing the style makes the client area the whole
 *     window, so the CSS hairline is the only border.
 *  2. DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND gives the silhouette its
 *     curve, composited with alpha. No clip region: DWM rounds the window
 *     itself, so nothing is cut and nothing is drawn outside the curve but the
 *     desktop. (A region can give any radius but a stair-stepped edge.)
 */
function stripNativeFrame() {
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class StripFrame {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
}
'@
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process neutralino-win_x64 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) {
    $h = $p.MainWindowHandle
    $GWL_STYLE = -16
    $WS_THICKFRAME = 0x00040000
    $style = [StripFrame]::GetWindowLong($h, $GWL_STYLE)
    if (($style -band $WS_THICKFRAME) -ne 0) {
      [StripFrame]::SetWindowLong($h, $GWL_STYLE, $style -band (-bnot $WS_THICKFRAME)) | Out-Null
    }
    $pref = 2   # DWMWCP_ROUND
    [StripFrame]::DwmSetWindowAttribute($h, 33, [ref]$pref, 4) | Out-Null
    exit 0
  }
  Start-Sleep -Milliseconds 250
}
exit 1
`;
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function main() {
  const mode = process.argv.includes("--window") ? "window" : "chrome";
  const { port } = await startAgent();

  // Tell the UI which shell mode is active so it can load the Neutralino client
  // correctly (window mode needs the client for native APIs; chrome mode must not
  // load it against an empty token or the page is replaced with an error).
  await writeFile(shellModeFile, JSON.stringify({ mode }), "utf8");

  // Remove stale auth info so we never publish a previous instance's token.
  await rm(authInfoFile, { force: true }).catch(() => {});

  // The UI discovers the agent via the port file we just wrote. Chrome mode is
  // the default because window mode (WebView2) segfaults intermittently on some
  // machines; pass --window for the frameless native shell when it is stable.
  const neu = spawn(
    neuExe,
    [
      "--load-dir-res",
      "--path=.",
      `--mode=${mode}`,
      // Transparent window: the page's own anti-aliased border-radius becomes
      // the silhouette, at any radius. Without it the OS gives a square window
      // (and DWM's rounding is fixed at 8px, a region's edge cannot anti-alias).
      ...(mode === "window" ? ["--window-transparent"] : []),
    ],
    {
      cwd: web,
      stdio: "inherit",
    }
  );
  children.add(neu);


  // No native frame (see stripNativeFrame): the client area is the whole
  // window, so the CSS hairline is the only border.
  if (mode === "window") {
    void stripNativeFrame().then((ok) => {
      console.log(ok ? "[run] native frame stripped" : "[run] could not strip the native frame");
    });
  }

  // Neutralino writes its auth info once the server is up; expose the token so
  // the page can connect the client library in window mode even when injection
  // does not run (without this, window controls and dragging APIs are no-ops).
  void (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(authInfoFile, "utf8");
        const auth = JSON.parse(raw);
        // A token is only published when it plausibly belongs to *this*
        // server: the connect token is the per-run half of nlToken. rm()
        // before the spawn already removed any previous run's file; this
        // guard is the second line of defence against publishing a stale
        // session — the exact bug that showed as NE_CL_IVCTOKN.
        if (
          auth.nlToken && auth.nlPort && auth.nlConnectToken &&
          auth.nlToken.endsWith(auth.nlConnectToken)
        ) {
          await writeFile(shellModeFile, JSON.stringify({ mode, nlToken: auth.nlToken, nlPort: auth.nlPort, nlConnectToken: auth.nlConnectToken }), "utf8");
          return;
        }
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  neu.on("exit", async (code) => {
    children.delete(neu);
    await rm(servedPortFile, { force: true }).catch(() => {});
    await rm(shellModeFile, { force: true }).catch(() => {});
    killAll();
    process.exit(code ?? 0);
  });
  neu.on("error", (err) => {
    console.error(`[run] failed to start Neutralino: ${err.message}`);
    killAll();
    process.exit(1);
  });

  console.log(`[run] Neutralino launched (${mode} mode). Agent on ${port}. Close the window to exit.`);
}

main().catch((err) => {
  console.error(`[run] ${err.stack ?? err.message}`);
  killAll();
  process.exit(1);
});

