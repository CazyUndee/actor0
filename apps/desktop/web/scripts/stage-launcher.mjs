/**
 * Stage the packaged launcher beside the exe.
 *
 * The launcher exists because the alternative — the webview spawning the agent
 * through os.spawnProcess — is a hole that cannot be closed while open. Cycle
 * 13's PoCs: (1) commandAllowList matches argv[0] as a name, so the entry
 * "node" resolved through Windows' search order to a node.bat planted in the
 * caller-chosen cwd: arbitrary execution through the token every local process
 * can fetch; (2) after pinning the app's own spawn to the runtime's absolute
 * path, the wildcard entry that must allow it (*node.exe) still lets a
 * simulated page-XSS read NL_PATH from the same globals endpoint that serves
 * the token and spawn the runtime with -e — a verified end-to-end
 * write-to-disk RCE. A permission the page holds cannot be scoped to "the
 * caller is us", so the page must not hold it. The dev launcher has done
 * direct-spawn since M1; this is the packaged counterpart.
 *
 * What ships next to the exe after this runs:
 *
 *   start-actor0.vbs  the launcher (silent: wscript, no console window)
 *   actor0.cmd        double-click comfort (wraps the vbs)
 *   agent/            the agent bundle (staged from resources/agent — the
 *                     page's old extraction path stays as the dev fallback)
 *   runtime/          the pinned node.exe (unchanged)
 *
 * The page's boot() already prefers a launcher-written port file
 * (readLaunchedAgentPort) and falls back to its own spawn when none exists —
 * and after this change the packaged allowlist drops os.spawnProcess, so the
 * fallback can only run where the permission is still granted: dev.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function stageLauncher(stagingDir, webRoot) {
  const vbsSource = join(webRoot, "scripts", "packaged-launcher.vbs");
  if (!existsSync(vbsSource)) throw new Error("packaged-launcher.vbs missing");
  cpSync(vbsSource, join(stagingDir, "start-actor0.vbs"));

  // Double-click entry: the exe's name is fixed by the shim's own script body.
  const cmd = "@echo off\r\nstart \"\" wscript.exe \"%~dp0start-actor0.vbs\"\r\n";
  mkdirSync(join(stagingDir, "agent"), { recursive: true });
  cpSync(join(webRoot, "resources", "agent", "agent.mjs"), join(stagingDir, "agent", "agent.mjs"));
  writeCmd(join(stagingDir, "actor0.cmd"), cmd);
  return { launcher: "start-actor0.vbs", entry: "actor0.cmd" };
}

function writeCmd(target, body) {
  writeFileSync(target, body, "utf8");
}
