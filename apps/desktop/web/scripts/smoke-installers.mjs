#!/usr/bin/env node
/**
 * Smoke-test the native installers on the host that built them.
 *
 * The archive smoke test proves the app layout; this proves the thing a user
 * actually double-clicks. Each platform gets its own native check: NSIS is
 * silently installed and uninstalled, the DMG is mounted and its signature is
 * verified, and each .deb is inspected and extracted with dpkg-deb. The checks
 * deliberately do not launch the window: CI has no reliable display, and the
 * archive smoke already starts the shipped agent.
 *
 * Usage: node scripts/smoke-installers.mjs [target ...]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { installerName, TARGETS } from "./targets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const distRoot = join(webRoot, "dist");
const version = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")).version;

function fail(message) {
  throw new Error(message);
}

function requireFile(path, description) {
  if (!existsSync(path)) fail(`missing ${description}: ${path}`);
  if (statSync(path).size === 0) fail(`empty ${description}: ${path}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function defaultTargets() {
  if (process.platform === "win32") return ["win_x64"];
  if (process.platform === "darwin") {
    const universal = join(distRoot, installerName(version, "mac_universal"));
    return [existsSync(universal) ? "mac_universal" : process.arch === "arm64" ? "mac_arm64" : "mac_x64"];
  }
  return ["linux_x64", "linux_arm64", "linux_armhf"];
}

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : defaultTargets();
for (const targetId of targets) {
  if (!TARGETS[targetId]) fail(`unknown target ${targetId}`);
  const expected = TARGETS[targetId].os;
  const host = process.platform === "win32" ? "win32" : process.platform;
  if (expected !== host) fail(`${targetId} installer cannot be tested on ${process.platform}`);
}

function smokeWindows(targetId) {
  const setup = join(distRoot, installerName(version, targetId));
  requireFile(setup, "Windows installer");
  const dir = join(distRoot, ".installer-smoke");
  if (/\s/.test(dir)) fail(`the smoke install path must not contain spaces: ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  try {
    console.log(`installing ${setup} silently...`);
    execFileSync(setup, ["/S", `/D=${dir}`], { stdio: "inherit" });
    requireFile(join(dir, "actor0.cmd"), "installed actor0.cmd");
    requireFile(join(dir, "start-actor0.vbs"), "installed start-actor0.vbs");
    requireFile(join(dir, "runtime", "node.exe"), "installed Node runtime");
    requireFile(join(dir, `actor0-${version}-win-x64.exe`), "installed shell binary");
    requireFile(join(dir, "Uninstall.exe"), "installed uninstaller");
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\actor0";
    run("reg.exe", ["query", key]);
    console.log("silent install and uninstall entry verified");
  } finally {
    const uninstaller = join(dir, "Uninstall.exe");
    if (existsSync(uninstaller)) {
      console.log("uninstalling silently...");
      execFileSync(uninstaller, ["/S"], { stdio: "inherit" });
      const deadline = Date.now() + 20_000;
      while (existsSync(dir) && Date.now() < deadline) {
        execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 150)"]);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\actor0";
  try {
    run("reg.exe", ["query", key]);
    fail("the uninstall registry entry survived uninstall");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("uninstall registry entry survived uninstall")) throw error;
    // reg.exe exits non-zero when the key is missing: uninstall cleaned up.
  }
  console.log("Windows installer smoke passed");
}

function smokeMac(targetId) {
  const dmg = join(distRoot, installerName(version, targetId));
  requireFile(dmg, "macOS disk image");
  const mount = join(distRoot, ".dmg-smoke");
  rmSync(mount, { recursive: true, force: true });
  mkdirSync(mount, { recursive: true });
  let attached = false;
  try {
    console.log(`mounting ${dmg}...`);
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
    attached = true;
    const app = join(mount, "actor0.app");
    requireFile(join(app, "Contents", "Info.plist"), "Info.plist in the DMG");
    requireFile(join(app, "Contents", "MacOS", "actor0"), "Mach-O launcher in the DMG");
    if (readlinkSync(join(mount, "Applications")) !== "/Applications") {
      fail("the DMG does not link Applications to /Applications");
    }
    run("codesign", ["--verify", "--deep", "--strict", app]);
    console.log("mounted, signature verified, Applications link present");
  } finally {
    if (attached) run("hdiutil", ["detach", "-quiet", mount]);
    rmSync(mount, { recursive: true, force: true });
  }
  console.log("macOS installer smoke passed");
}

function smokeDeb(targetId) {
  const deb = join(distRoot, installerName(version, targetId));
  requireFile(deb, "Debian package");
  const info = run("dpkg-deb", ["--info", deb]);
  if (!info.includes(`Architecture: ${TARGETS[targetId].deb}`)) {
    fail(`${deb} does not report Architecture: ${TARGETS[targetId].deb}`);
  }
  if (!info.includes("libwebkit2gtk-4.1-0")) fail(`${deb} does not depend on WebKitGTK 4.1`);
  if (!info.includes("Package: actor0-desktop")) fail(`${deb} has the wrong package name`);

  const root = join(distRoot, `.deb-smoke-${targetId}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    run("dpkg-deb", ["--extract", deb, root]);
    const app = join(root, "opt", "actor0");
    requireFile(join(app, "actor0"), "Debian launcher");
    requireFile(join(app, `actor0-${version}-${TARGETS[targetId].slug}`), "Debian shell binary");
    requireFile(join(app, "resources.neu"), "Debian resources");
    requireFile(join(app, "runtime", targetId === "linux_armhf" ? "armv7l" : TARGETS[targetId].arch, "node"), "Debian Node runtime");
    const wrapper = join(root, "usr", "bin", "actor0-desktop");
    requireFile(wrapper, "actor0-desktop command");
    if ((statSync(wrapper).mode & 0o111) === 0) fail("actor0-desktop is not executable");
    if (!readFileSync(wrapper, "utf8").startsWith("#!/bin/sh\n")) fail("actor0-desktop is not an LF shell script");
    requireFile(join(root, "usr", "share", "applications", "actor0.desktop"), "desktop entry");
    requireFile(join(root, "usr", "share", "icons", "hicolor", "512x512", "apps", "actor0.png"), "desktop icon");
    console.log(`${targetId}: control metadata and extracted tree verified`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const targetId of targets) {
  if (TARGETS[targetId].os === "win32") smokeWindows(targetId);
  else if (TARGETS[targetId].os === "darwin") smokeMac(targetId);
  else smokeDeb(targetId);
}
