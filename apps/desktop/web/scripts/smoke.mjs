#!/usr/bin/env node
/**
 * Smoke-test a packaged artifact on the host that built it.
 *
 * The package scripts prove an archive exists. This proves the archive is an
 * installable: it unpacks with the platform's own tool, has the layout each
 * launcher resolves at runtime, carries an executable bundled Node of the
 * pinned version, and can start the shipped agent bundle. The agent run is
 * headless on purpose — CI has no reliable window server — so the WebKit
 * window itself is covered by the UI suite and by installing the artifact.
 *
 * Usage: node scripts/smoke.mjs <target> [artifact]
 *
 * macOS extraction uses ditto, not unzip: the ad-hoc signature and the
 * extended attributes codesign records must survive extraction, or the test
 * is checking a different bundle than the one a user gets.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, artifactName } from "./targets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const distRoot = join(webRoot, "dist");

const targetId = process.argv[2];
if (!targetId || !TARGETS[targetId]) {
  console.error(`usage: node scripts/smoke.mjs <${Object.keys(TARGETS).join("|")}> [artifact]`);
  process.exit(2);
}
const version = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")).version;
const artifact = process.argv[3] ? process.argv[3] : join(distRoot, artifactName(version, targetId));
const workRoot = join(distRoot, `smoke-${targetId}`);

function fail(message) {
  throw new Error(message);
}

function requireFile(path, description) {
  if (!existsSync(path)) fail(`missing ${description}: ${path}`);
  if (statSync(path).size === 0) fail(`empty ${description}: ${path}`);
}

function requireExecutable(path, description) {
  requireFile(path, description);
  // NTFS does not carry POSIX mode bits; a cross-smoke on Windows can only
  // check presence. The Linux and macOS runners enforce the bit.
  if (process.platform !== "win32" && (statSync(path).mode & 0o111) === 0) {
    fail(`${description} is not executable: ${path}`);
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function extract() {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  if (artifact.endsWith(".zip") && process.platform === "darwin") {
    run("ditto", ["-x", "-k", artifact, workRoot]);
  } else if (artifact.endsWith(".zip")) {
    run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${artifact.replace(/'/g, "''")}' -DestinationPath '${workRoot.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    // GNU tar is not a reliable consumer of Windows drive paths here: a colon
    // in -f becomes a remote host, and a D:\ path in -C becomes "Cannot open".
    // Copy the archive into the work root and unpack the bare name there.
    const local = join(workRoot, "artifact.tar.gz");
    copyFileSync(artifact, local);
    run("tar", ["-xzf", basename(local)], { cwd: workRoot });
    rmSync(local, { force: true });
  }
}

/** The directory that holds resources.neu and the staged binary. */
function layoutDir() {
  if (TARGETS[targetId].os === "darwin") {
    const app = join(workRoot, "actor0.app");
    requireFile(join(app, "Contents", "Info.plist"), "Info.plist");
    return join(app, "Contents", "MacOS");
  }
  if (TARGETS[targetId].os === "win32") return workRoot;
  const roots = readdirSync(workRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (roots.length !== 1) fail(`expected one top-level directory in the tarball, found ${roots.length}`);
  return join(workRoot, roots[0].name);
}

function bundledRuntime(layout) {
  if (TARGETS[targetId].os === "win32") return join(layout, "runtime", "node.exe");
  const arch = TARGETS[targetId].arch === "armhf" ? "armv7l" : TARGETS[targetId].arch;
  return join(layout, "runtime", arch, "node");
}

function hostCanExecute() {
  if (TARGETS[targetId].os !== process.platform) return false;
  if (process.platform === "win32") return TARGETS[targetId].arch === "x64";
  return TARGETS[targetId].arch === process.arch;
}

async function verifyAgent(layout, node) {
  const state = join(workRoot, ".smoke-state");
  const cwd = join(workRoot, ".smoke-cwd");
  mkdirSync(state, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const portFile = join(state, "port.json");
  const child = spawn(node, [join(layout, "agent", "agent.mjs")], {
    env: { ...process.env, ACTOR0_AGENT_PORT_FILE: portFile, ACTOR0_AGENT_TOKEN: "smoke-token", ACTOR0_AGENT_CWD: cwd },
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let exited = false;
  child.on("exit", (code) => { exited = true; stderr += `\n(agent exited ${code})`; });

  const deadline = Date.now() + 20_000;
  let record;
  while (Date.now() < deadline) {
    if (exited) fail(`the shipped agent exited before writing its port file\n${stderr}`);
    try {
      record = JSON.parse(readFileSync(portFile, "utf8"));
      if (typeof record.port === "number" && record.port > 0) break;
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  killTree(child);
  if (!record || typeof record.port !== "number") fail(`the shipped agent never wrote a port file\n${stderr}`);
  console.log(`agent started on 127.0.0.1:${record.port} from the packaged bundle`);
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

async function main() {
  requireFile(artifact, "artifact");
  console.log(`smoke ${targetId}: ${artifact}`);
  extract();
  const layout = layoutDir();
  const runtime = bundledRuntime(layout);
  requireFile(join(layout, "resources.neu"), "resources.neu");
  requireFile(join(layout, "agent", "agent.mjs"), "agent bundle");

  if (TARGETS[targetId].os === "darwin") {
    const app = join(workRoot, "actor0.app");
    requireFile(join(app, "Contents", "Resources", "icon.icns"), "icon.icns");
    requireExecutable(join(app, "Contents", "MacOS", "actor0"), "Mach-O launcher stub");
    requireExecutable(join(app, "Contents", "Resources", "run.sh"), "launcher script");
    const magic = readFileSync(join(app, "Contents", "MacOS", "actor0")).subarray(0, 4);
    if (magic.readUInt32BE(0) !== 0xfeedfacf && magic.readUInt32BE(0) !== 0xcffaedfe) {
      fail("the macOS entry point is not a Mach-O executable");
    }
    if (process.platform === "darwin") {
      run("codesign", ["--verify", "--deep", "--strict", app]);
      console.log("ad-hoc signature verifies after extraction");
    }
  } else if (TARGETS[targetId].os === "win32") {
    requireFile(join(layout, "actor0.cmd"), "actor0.cmd");
    requireFile(join(layout, "start-actor0.vbs"), "start-actor0.vbs");
    requireFile(join(layout, `actor0-${version}-win-x64.exe`), "shell executable");
  } else {
    requireExecutable(join(layout, "actor0"), "launcher");
    requireExecutable(join(layout, "install.sh"), "install.sh");
    requireFile(join(layout, "icon.png"), "icon.png");
    const launcher = readFileSync(join(layout, "actor0"), "utf8");
    if (!launcher.startsWith("#!/bin/sh\n")) fail("the POSIX launcher does not start with #!/bin/sh (CRLF?)");
    if (!launcher.includes(`actor0-${version}-${targetId.replaceAll("_", "-")}`)) {
      fail("the POSIX launcher does not name this package's shell binary");
    }
  }

  if (TARGETS[targetId].os === "win32") requireFile(runtime, "bundled Node runtime");
  else requireExecutable(runtime, "bundled Node runtime");
  console.log(`layout ok, runtime ${runtime.slice(layout.length + 1)}`);

  if (hostCanExecute()) {
    const reported = run(runtime, ["--version"]).trim();
    if (reported !== "v22.14.0") fail(`bundled runtime reports ${reported}, expected v22.14.0`);
    console.log(`bundled runtime runs: ${reported}`);
    await verifyAgent(layout, runtime);
  } else {
    console.log(`runtime ${TARGETS[targetId].arch} cannot run on this ${process.platform}/${process.arch} host; checked file only`);
  }
  console.log("smoke passed");
}

main().catch((error) => {
  console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
