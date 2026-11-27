#!/usr/bin/env node
/**
 * Packages the desktop app for distribution, per target.
 *
 * What "packaged" has to mean, worked out against the built binaries rather
 * than assumed:
 *
 *   1. `neu build` produces the shell binary plus a resources.neu with the UI
 *      and the agent bundle embedded. The shell runs with no developer
 *      tooling — but the agent is a separate Node process, and a user's
 *      machine is not guaranteed to have Node. So the runtime is bundled: a
 *      pinned Node LTS (v22) downloaded at package time and checked against
 *      the SHA256 pinned in targets.mjs, which came from nodejs.org's
 *      SHASUMS256.txt. The pin is committed: a dist directory that changes
 *      under us must fail the build, not become the runtime a user runs.
 *   2. The agent bundle cannot run from inside resources.neu (nothing mounts
 *      it as a filesystem), so the first boot extracts /resources/agent to the
 *      app's data directory via the Neutralino resources API, and every boot
 *      after that reuses it. The packaged launcher starts it before the
 *      window, because the packaged page must not hold os.spawnProcess.
 *   3. Updates use Neutralino's updater contract: an update manifest URL is
 *      baked into the build, and `updater.checkForUpdates()` against it hands
 *      back a new resources.neu. The manifest is generated here and written
 *      beside the artifacts so a release can publish it verbatim.
 *
 * Targets (see targets.mjs for why there is no Windows arm64):
 *
 *   win_x64        zip, contents at the root
 *   mac_x64        .app inside a zip, ad-hoc signed (Apple Silicon blocks
 *   mac_arm64      an unsigned arm64 binary outright, so signing is not
 *   mac_universal  optional even for a local build)
 *   linux_x64      tar.gz with a top-level directory and install.sh
 *   linux_arm64
 *   linux_armhf
 *
 * macOS bundles are built only on macOS: codesign is part of the package,
 * and a cross-built bundle would be unsigned and would not start on arm64.
 * Linux and Windows artifacts can be cross-built; every mode bit in the
 * tarball is written by tar.mjs rather than read from the host filesystem.
 *
 * Usage:
 *   node scripts/package.mjs win_x64
 *   node scripts/package.mjs mac_x64 mac_arm64 mac_universal
 *   node scripts/package.mjs linux_x64 linux_arm64 linux_armhf --no-build
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageLauncher } from "./stage-launcher.mjs";
import { createTarGz, extractTarGz, makeExecutablePredicate } from "./tar.mjs";
import {
  DIST_BASE,
  TARGETS,
  artifactName,
  isWindows,
  neuBinaryName,
  stagedBinaryName,
  targetRuntimes,
} from "./targets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const distRoot = join(webRoot, "dist");
const shellOut = join(distRoot, "actor0-desktop");
const runtimeCache = join(webRoot, ".runtime-cache");

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const requested = args.filter((arg) => !arg.startsWith("--"));

const appVersion = readAppVersion();

async function main() {
  const targets = requested.length > 0 ? requested : [hostDefaultTarget()];
  validateTargets(targets);
  buildShell(targets);
  writeReleaseFiles();
  for (const targetId of targets) await stageTarget(targetId);
  console.log("\ndone: " + targets.map((targetId) => artifactName(appVersion, targetId)).join(", "));
}

function readAppVersion() {
  const pkg = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8"));
  return pkg.version;
}

/** Packaging on a machine with no target argument builds that machine's app. */
function hostDefaultTarget() {
  if (process.platform === "win32") return "win_x64";
  if (process.platform === "darwin") return "mac_universal";
  return "linux_x64";
}

function validateTargets(targets) {
  const known = Object.keys(TARGETS);
  const unknown = targets.filter((targetId) => !TARGETS[targetId]);
  if (unknown.length > 0) {
    throw new Error(`unknown target(s) ${unknown.join(", ")} — known: ${known.join(", ")}`);
  }
  const wrongHost = targets.filter(
    (targetId) => TARGETS[targetId].os === "darwin" && process.platform !== "darwin",
  );
  if (wrongHost.length > 0) {
    throw new Error(
      `${wrongHost.join(", ")}: macOS bundles must be built on macOS.\n` +
        "The .app is ad-hoc signed as part of packaging; without that signature an Apple Silicon\n" +
        "machine kills the binary at launch (\"damaged\"), and codesign does not run on Windows.\n" +
        "Build those targets on a macOS runner."
    );
  }
}

/**
 * Assemble resources and run `neu build` once for every target.
 *
 * One resources.neu serves all targets: it is platform-independent, and the
 * shell binaries in dist/ are the only per-platform part. `neu build` (not
 * --release) is deliberate — --release also produces a zip of every binary
 * together, which is not an installable for any of them.
 */
function buildShell(targets) {
  if (!flags.has("--no-build")) {
    console.log("assembling resources...");
    run(process.execPath, ["scripts/assemble.mjs"], { cwd: webRoot });
    console.log("building the Neutralino bundle...");
    run("npx", ["neu", "build"], { cwd: webRoot, shell: process.platform === "win32" });
  }
  const missing = targets
    .map((targetId) => join(shellOut, neuBinaryName(targetId)))
    .filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `neu build did not produce:\n  ${missing.join("\n  ")}\n` +
        "The shell binaries come from apps/desktop/web/bin/ (gitignored). Fetch them with:\n" +
        "  cd apps/desktop/web && npx neu update"
    );
  }
}

function run(command, commandArgs, options = {}) {
  console.log(`$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The pinned runtime archive, downloaded once and verified every time.
 *
 * A cached file is re-hashed on every run: the cache lives in the checkout,
 * and a truncated download from a previous run is exactly the failure that
 * otherwise shows up as "the agent did not start" in a user's package.
 */
async function ensureRuntime(flavour, runtime) {
  mkdirSync(runtimeCache, { recursive: true });
  const archivePath = join(runtimeCache, runtime.file);
  if (!existsSync(archivePath) || sha256(archivePath) !== runtime.sha256) {
    await download(`${DIST_BASE}/${runtime.file}`, archivePath);
    const actual = sha256(archivePath);
    if (actual !== runtime.sha256) {
      rmSync(archivePath, { force: true });
      throw new Error(
        `runtime checksum mismatch for ${runtime.file}:\n  expected ${runtime.sha256}\n  actual   ${actual}`
      );
    }
  }

  const extractDir = join(runtimeCache, `node-${flavour}`);
  const innerPath = join(extractDir, ...runtime.inner.split("/"));
  const marker = join(extractDir, ".source-sha256");
  const fresh = existsSync(innerPath) && existsSync(marker) && readFileSync(marker, "utf8").trim() === runtime.sha256;
  if (!fresh) {
    console.log(`unpacking ${runtime.file}...`);
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    if (runtime.file.endsWith(".zip")) {
      extractZip(archivePath, extractDir);
    } else {
      const written = extractTarGz(archivePath, extractDir, { only: (path) => path === runtime.inner });
      if (written.length === 0) throw new Error(`${runtime.file} has no ${runtime.inner}`);
    }
    if (!existsSync(innerPath)) {
      throw new Error(`the Node runtime did not unpack to ${innerPath} — delete ${extractDir} and build again`);
    }
    writeFileSync(marker, runtime.sha256);
  }
  return innerPath;
}

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${dest}.part`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  renameSync(partial, dest);
}

/**
 * Cross-platform zip extraction, fastest reliable archiver first.
 *
 * `tar` is bsdtar on Windows 10+ and unpacks a .zip in seconds; `unzip` is the
 * POSIX default. PowerShell's Expand-Archive is the last resort and a poor one:
 * measured on this checkout it took minutes over the 3,000-entry Node zip and
 * once left a half-filled directory, which the next build reported as a missing
 * runtime.
 */
function extractZip(zipPath, dest) {
  const attempts = [
    // Run from the archive's directory and pass its bare name: GNU tar reads a
    // colon in an -f argument as a remote host, so "D:/..." becomes "connect to
    // host D", which is a misleading error on the one platform where the zip
    // fallback is most likely to be used.
    ["tar", ["-xf", basename(zipPath), "-C", dest], dirname(zipPath)],
    ["unzip", ["-q", zipPath, "-d", dest]],
    [
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`,
      ],
    ],
  ];
  const errors = [];
  for (const [command, commandArgs, cwd] of attempts) {
    try {
      execFileSync(command, commandArgs, { stdio: "inherit", cwd });
      return;
    } catch (error) {
      errors.push(`${command}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(`could not unpack ${zipPath}\n  ${errors.join("\n  ")}`);
}

async function stageTarget(targetId) {
  const os = TARGETS[targetId].os;
  const mac = os === "darwin";
  const staging = join(distRoot, `build-${targetId}`);
  resetDirectory(staging);

  const appDir = mac ? join(staging, "actor0.app") : undefined;
  const layout = mac ? join(appDir, "Contents", "MacOS") : staging;
  mkdirSync(layout, { recursive: true });

  const binaryName = stagedBinaryName(appVersion, targetId);
  const shellBin = join(shellOut, neuBinaryName(targetId));
  cpSync(shellBin, join(layout, binaryName));
  chmodSync(join(layout, binaryName), 0o755);
  cpSync(join(shellOut, "resources.neu"), join(layout, "resources.neu"));

  stageLauncher(layout, webRoot, { targetId, binaryName });
  await stageRuntimes(layout, targetId);

  if (isWindows(targetId)) await patchWindowsIcon(join(layout, binaryName));
  if (mac) stageMacBundle(appDir, targetId);
  if (os === "linux") stageLinux(layout);
  if (!mac) writeReadme(layout, targetId);

  const artifact = join(distRoot, artifactName(appVersion, targetId));
  rmSync(artifact, { force: true });
  if (isWindows(targetId)) {
    zipWindows(staging, artifact);
  } else if (mac) {
    console.log("zipping the .app with ditto...");
    execFileSync("ditto", ["-c", "-k", "--keepParent", appDir, artifact], { stdio: "inherit" });
  } else {
    console.log("creating the tarball...");
    await createTarGz(staging, artifact, {
      prefix: `actor0-desktop-${appVersion}-${targetId}`,
      executable: makeExecutablePredicate(binaryName),
    });
  }
  const hash = sha256(artifact);
  writeFileSync(`${artifact}.sha256`, `${hash}  ${basename(artifact)}\n`);
  const size = statSync(artifact).size / 1048576;
  console.log(`\nok ${artifactName(appVersion, targetId)} (${size.toFixed(1)} MB)`);
}

/**
 * Remove a previous staging tree, with the one error a user can cause.
 *
 * Windows refuses the removal while the packaged app is still running: it is
 * the directory the exe and the agent's Node runtime were launched from. Say
 * that, instead of surfacing EPERM on a path the user never chose.
 */
function resetDirectory(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "EPERM" || code === "EBUSY") {
      throw new Error(`cannot clear ${dir} — the packaged app is still running. Close the actor0 window and build again.`);
    }
    throw error;
  }
  mkdirSync(dir, { recursive: true });
}

async function stageRuntimes(layout, targetId) {
  for (const runtime of targetRuntimes(targetId)) {
    const dir = runtime.runtimeSubdir ? join(layout, "runtime", runtime.runtimeSubdir) : join(layout, "runtime");
    mkdirSync(dir, { recursive: true });
    const source = await ensureRuntime(runtime.flavour, runtime);
    const dest = join(dir, runtime.binary);
    cpSync(source, dest);
    // chmod is close to a no-op on Windows (it maps to the read-only bit); the
    // tar writer carries the real 0755, which is why this is not the only place
    // the mode is set.
    chmodSync(dest, 0o755);
  }
}

/**
 * Replace the exe's embedded icon. Windows reads the taskbar and Explorer icon
 * from the resource section, and neu build embeds the Neutralino default.
 * rcedit is a Windows binary, so this runs only when packaging on Windows.
 *
 * A clean machine has no .tools/rcedit.exe, and a package that silently kept
 * the Neutralino logo is not the package this repository promises. So the
 * binary is downloaded at package time like the Node runtimes, from a pinned
 * release and with the pinned hash checked before it is executed.
 */
const RCEDIT_URL = "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe";
const RCEDIT_SHA256 = "3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a";

async function ensureRcedit() {
  const dir = join(webRoot, ".tools");
  const dest = join(dir, "rcedit.exe");
  const matches = (path) =>
    existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex") === RCEDIT_SHA256;
  if (matches(dest)) return dest;

  mkdirSync(dir, { recursive: true });
  console.log("downloading rcedit for the exe icon...");
  const response = await fetch(RCEDIT_URL);
  if (!response.ok) throw new Error(`could not download rcedit: HTTP ${response.status} from ${RCEDIT_URL}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== RCEDIT_SHA256) {
    throw new Error(`rcedit hash mismatch: expected ${RCEDIT_SHA256}, got ${actual}`);
  }
  const download = `${dest}.download`;
  writeFileSync(download, bytes);
  rmSync(dest, { force: true });
  renameSync(download, dest);
  return dest;
}

async function patchWindowsIcon(exe) {
  const ico = join(webRoot, "resources", "app", "icon.ico");
  if (process.platform !== "win32") {
    console.log("icon patch skipped on this host (rcedit is a Windows binary)");
    return;
  }
  if (!existsSync(ico)) throw new Error(`the icon is missing: ${ico}`);
  const rcedit = await ensureRcedit();
  console.log("patching the exe icon...");
  execFileSync(rcedit, [exe, "--set-icon", ico], { stdio: "inherit" });
}

/**
 * The macOS bundle: a Mach-O launcher stub, the script it runs, the .icns,
 * Info.plist, and the ad-hoc signature.
 *
 * Launch Services runs CFBundleExecutable, and the agent has to start before
 * the window exists (the packaged page holds no spawn permission). That entry
 * is a compiled stub rather than the shell script: a script's code signature
 * lives in extended attributes, which do not reliably survive a zip download,
 * and an app whose main executable fails verification is reported as damaged.
 * The stub execs Contents/Resources/run.sh, which holds the launch logic.
 *
 * The shell binary, the resources and the per-arch Node runtimes sit in
 * Contents/MacOS, which is what Neutralino computes NL_PATH to be.
 */
function stageMacBundle(appDir, targetId) {
  const contents = join(appDir, "Contents");
  const resources = join(contents, "Resources");
  mkdirSync(resources, { recursive: true });
  cpSync(join(webRoot, "resources", "app", "icon.icns"), join(resources, "icon.icns"));
  writeFileSync(join(contents, "Info.plist"), infoPlist());
  writeFileSync(join(contents, "PkgInfo"), "APPL????");

  if (process.platform !== "darwin") {
    throw new Error("stageMacBundle ran on a non-macOS host; the bundle would be unsigned");
  }
  // stageLauncher wrote the POSIX script as Contents/MacOS/actor0. A script in
  // MacOS is exactly what Apple's signing notes warn about, so move it to
  // Resources and put a compiled stub in its place.
  const scriptLauncher = join(contents, "MacOS", "actor0");
  if (!existsSync(scriptLauncher)) throw new Error(`the launcher script is missing from ${appDir}`);
  const runScript = join(resources, "run.sh");
  renameSync(scriptLauncher, runScript);
  chmodSync(runScript, 0o755);

  const archFlags =
    targetId === "mac_universal"
      ? ["-arch", "x86_64", "-arch", "arm64"]
      : targetId === "mac_arm64"
        ? ["-arch", "arm64"]
        : ["-arch", "x86_64"];
  const executable = join(contents, "MacOS", "actor0");
  console.log("compiling the Mach-O launcher stub...");
  execFileSync(
    "clang",
    ["-O2", "-mmacosx-version-min=11.0", ...archFlags, "-o", executable, join(webRoot, "scripts", "mac-launcher.c")],
    { stdio: "inherit" },
  );

  // Sign the bundle once, with --deep. Signing the stub by its own path is
  // not a smaller operation: codesign recognises it as the app's main
  // executable and starts signing the enclosing bundle, where --force without
  // --deep refuses to continue at the still-unsigned shell binary (that is
  // exactly how the first macOS CI run failed).
  execFileSync("xattr", ["-cr", appDir], { stdio: "inherit" });
  execFileSync("plutil", ["-lint", join(contents, "Info.plist")], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appDir], { stdio: "inherit" });
  console.log("ad-hoc signed and verified the .app (not notarized)");
}

function infoPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleName</key><string>actor0</string>",
    "  <key>CFBundleDisplayName</key><string>actor0</string>",
    "  <key>CFBundleIdentifier</key><string>com.actor0.desktop</string>",
    "  <key>CFBundleExecutable</key><string>actor0</string>",
    "  <key>CFBundleIconFile</key><string>icon.icns</string>",
    "  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>",
    "  <key>CFBundlePackageType</key><string>APPL</string>",
    `  <key>CFBundleShortVersionString</key><string>${appVersion}</string>`,
    `  <key>CFBundleVersion</key><string>${appVersion}</string>`,
    "  <key>LSMinimumSystemVersion</key><string>11.0</string>",
    "  <key>NSHighResolutionCapable</key><true/>",
    "  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function stageLinux(layout) {
  // The checkout is CRLF on Windows, and this script is copied verbatim into
  // the tarball. A shebang followed by CR is not a shebang on Linux, so a
  // tar built on Windows would install nothing. Normalise it here rather than
  // relying on which host produced the archive.
  const source = readFileSync(join(webRoot, "scripts", "install-linux.sh"), "utf8");
  const installer = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!installer.startsWith("#!/bin/sh\n")) throw new Error("install-linux.sh must start with a #!/bin/sh line");
  writeFileSync(join(layout, "install.sh"), installer, { mode: 0o755 });
  cpSync(join(webRoot, "resources", "app", "icon.png"), join(layout, "icon.png"));
}

function writeReadme(layout, targetId) {
  const target = TARGETS[targetId];
  const platform = target.os === "win32" ? `Windows ${target.arch}` : `Linux ${target.arch}`;
  const common = [
    `actor0 desktop ${appVersion} (${platform})`,
    "",
    "This directory is self-contained: the shell binary, resources.neu, the agent",
    "bundle and a pinned Node runtime. Do not move files out of it.",
    "",
  ];
  const body =
    target.os === "win32"
      ? [
          "Run actor0.cmd (start-actor0.vbs does the same without a console window).",
          "If SmartScreen warns about an unknown publisher: More info -> Run anyway.",
          "The agent's log is agent\\agent.log next to this file.",
        ]
      : [
          "Install:  ./install.sh        (to ~/.local)",
          "          PREFIX=/usr/local sudo ./install.sh",
          "Then run: actor0              (or the desktop entry)",
          "",
          "Without installing, ./actor0 also runs from this directory.",
          "Requires WebKitGTK 4.1: libwebkit2gtk-4.1-0 (Debian/Ubuntu),",
          "webkit2gtk4.1 (Fedora). The agent's log and port record live in",
          "~/.actor0/agent/, which the launcher and the page both derive from home.",
        ];
  writeFileSync(join(layout, "README.txt"), [...common, ...body, ""].join("\n"));
}

function zipWindows(staging, artifact) {
  console.log("zipping the installable...");
  // Contents at the archive root: a user who extracts it gets actor0.cmd, not
  // a build-win_x64/ directory they have to know to open.
  try {
    execFileSync("zip", ["-q", "-r", artifact, "."], { cwd: staging, stdio: "inherit" });
    return;
  } catch {
    // Fall through to the archivers Windows actually has.
  }
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Path '${join(staging, "*").replace(/'/g, "''")}' -DestinationPath '${artifact.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "inherit" },
    );
    return;
  } catch (error) {
    throw new Error(
      "could not create the zip: neither zip nor PowerShell's Compress-Archive is available\n  " +
        (error instanceof Error ? error.message.split("\n")[0] : String(error)),
    );
  }
}

/**
 * The release-wide files: the manifest the updater reads, and the raw
 * resources.neu it swaps in. Both are identical on every runner; a release
 * uploads whichever copy arrived last.
 */
function writeReleaseFiles() {
  const resources = join(shellOut, "resources.neu");
  if (!existsSync(resources)) throw new Error(`missing ${resources} — neu build did not run`);
  cpSync(resources, join(distRoot, `actor0-desktop-resources-${appVersion}.neu`));
  const manifest = {
    applicationId: "com.actor0.desktop",
    version: appVersion,
    resourcesURL: `https://github.com/cazyundee/actor0/releases/download/v${appVersion}/actor0-desktop-resources-${appVersion}.neu`,
  };
  writeFileSync(join(distRoot, "update-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`update manifest and resources written for v${appVersion}`);
}

main().catch((error) => {
  console.error(`\npackaging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
