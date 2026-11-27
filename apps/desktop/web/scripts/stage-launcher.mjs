/**
 * Stage the packaged launcher beside the app.
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
 * direct-spawn since M1; this is the packaged counterpart, on every platform.
 *
 * What ships next to the app after this runs:
 *
 *   Windows  start-actor0.vbs (silent: wscript, no console window)
 *            actor0.cmd (double-click comfort; wraps the vbs)
 *   POSIX    actor0, a sh script (the .app's CFBundleExecutable on macOS)
 *   all      agent/agent.mjs, staged from resources/agent — the page's old
 *            extraction path stays as the dev fallback
 *
 * The page's boot() already prefers a launcher-written port file
 * (readLaunchedAgentPort) and falls back to its own spawn when none exists —
 * and after this change the packaged allowlist drops os.spawnProcess, so the
 * fallback can only run where the permission is still granted: dev.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Stages the launcher for one target and returns the file a user runs.
 *
 * `binaryName` is the staged shell binary (version and target in its name).
 * The POSIX launcher needs it baked in because the version moves; the Windows
 * vbs finds the exe by pattern instead, so it ignores the argument.
 */
export function stageLauncher(stagingDir, webRoot, { targetId, binaryName } = {}) {
  mkdirSync(join(stagingDir, "agent"), { recursive: true });
  cpSync(join(webRoot, "resources", "agent", "agent.mjs"), join(stagingDir, "agent", "agent.mjs"));
  if (!targetId) throw new Error("stageLauncher needs a target id");
  if (targetId.startsWith("win")) return stageWindowsLauncher(stagingDir, webRoot);
  return stagePosixLauncher(stagingDir, webRoot, { targetId, binaryName });
}

function stageWindowsLauncher(stagingDir, webRoot) {
  const vbsSource = join(webRoot, "scripts", "packaged-launcher.vbs");
  if (!existsSync(vbsSource)) throw new Error("packaged-launcher.vbs missing");
  cpSync(vbsSource, join(stagingDir, "start-actor0.vbs"));

  // Double-click entry: the exe's name is fixed by the shim's own script body.
  // The CRLF pair is built from a char-code join rather than written as an
  // escape, so nothing that reformats this file can turn it into real newlines.
  const cmd = ["@echo off", "start \"\" wscript.exe \"%~dp0start-actor0.vbs\" " + buildArgument(), ""].join(String.fromCharCode(13, 10));
  writeFileSync(join(stagingDir, "actor0.cmd"), cmd, "utf8");
  return { launcher: "start-actor0.vbs", entry: "actor0.cmd" };
}

function stagePosixLauncher(stagingDir, webRoot, { targetId, binaryName }) {
  const sourcePath = join(webRoot, "scripts", "packaged-launcher.sh");
  if (!existsSync(sourcePath)) throw new Error("packaged-launcher.sh missing");
  if (!binaryName) throw new Error(`stageLauncher needs the staged binary name for ${targetId}`);
  const source = readFileSync(sourcePath, "utf8");
  // The checkout is CRLF on Windows. A shebang followed by CR is not a shebang
  // on Linux or macOS (the kernel looks for "/bin/sh\r"), and a script that is
  // packaged on a Windows host and extracted on a POSIX one must not depend on
  // which host built it.
  const template = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!template.startsWith("#!/bin/sh\n")) throw new Error("packaged-launcher.sh must start with a #!/bin/sh line");
  const body = template
    .split("__APP_BINARY__").join(binaryName)
    .split("__BUILD_ARG__").join(buildArgument());
  if (body.includes("__APP_BINARY__") || body.includes("__BUILD_ARG__")) {
    throw new Error("packaged-launcher.sh still has an unsubstituted placeholder");
  }
  const target = join(stagingDir, "actor0");
  writeFileSync(target, body, { mode: 0o755 });
  return { launcher: "actor0", entry: "actor0" };
}

/**
 * The build number, as the launcher's first argument.
 *
 * It counts the commits since the last version tag, which is exactly what every
 * commit's `(build: N)` records. It is passed at package time rather than baked
 * into the UI bundle so that the number a window reports is the one this
 * package was cut from — the two would disagree the moment a commit landed
 * without a rebuild. A checkout where the count cannot be taken (no git, no
 * tags) simply omits it, and the title bar then shows the version alone.
 *
 * The count is taken from `git` directly rather than by running
 * `scripts/build-number.sh`: that script needs `bash` on PATH, and on Windows
 * `npm run package:win` spawns through `cmd.exe`, where Git's bash is not on the
 * PATH it inherits. The catch below treated that as "no count available", so
 * every package shipped with an empty build argument and the title bar showed
 * `v0.5.7` with no build at all — silently, because an absent build number looks
 * exactly like an old package.
 *
 * The repository root is `../../../../` from `apps/desktop/web/scripts`,
 * resolved from this file rather than from the process's working directory,
 * because the packaging script runs from the workspace, not from the root.
 */
function buildArgument() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  try {
    const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    // No tag in this checkout is build 0, which is what the shell script
    // reported for the same case: the first commit after the first release is
    // build 1, and before there is a release there is nothing to count from.
    let tag = "";
    try {
      tag = git(["describe", "--tags", "--match", "v[0-9]*", "--abbrev=0"]);
    } catch {
      return "0";
    }
    if (!tag) return "0";
    const count = Number.parseInt(git(["rev-list", "--count", `${tag}..HEAD`]), 10);
    if (!Number.isFinite(count)) return "";
    // Just the number. The launcher adds the flag: it is the process that
    // owns the agent's argv, and a cmd.exe `start` with the flag already
    // attached drops the argument it cannot parse as a number — which is
    // exactly how `--build --build` reached the agent and it fell back to no
    // build at all.
    return `${count}`;
  } catch {
    return "";
  }
}
