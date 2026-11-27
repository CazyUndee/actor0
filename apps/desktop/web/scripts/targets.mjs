/**
 * The seven build targets, in one place.
 *
 * `neu build` copies *every* platform binary in `bin/` into `dist/`, so the
 * shell side of a cross-platform package is already free: one build produces
 * `actor0-desktop-{win,mac,linux}_*` for all of them. What was Windows-only was
 * everything around it — the runtime mapping, the launcher, the archive, the
 * install step — and each of those used to be hard-coded inline in package.mjs,
 * so "add macOS" meant editing string literals scattered over three files.
 *
 * The two tables here are the contract those files read from instead:
 *
 *   NODE_FLAVOURS  one row per Node distribution that can be downloaded and
 *                  SHA256-verified from nodejs.org for a given platform+arch.
 *   TARGETS        one row per package we ship: which Node row(s) it bundles,
 *                  what `neu build` calls the binary, and which archive kind
 *                  the platform's users actually install from.
 *
 * The mapping from target -> neu binary name is deliberately derived the same
 * way `neu` derives it (`neutralino-<id>` renamed with the config's
 * `cli.binaryName`) and is asserted against neu's own `constants.js` in
 * package.test.mjs, because a hand-written table that disagrees with neu is a
 * package that quietly stages the wrong binary.
 */

/** The pinned Node LTS the agent runs on. Same value package.mjs used to hard-code. */
export const NODE_VERSION = "22.14.0";

/**
 * Node distributions, keyed by the flavour string in nodejs.org's file names.
 *
 * `inner` is the path of the runnable inside the archive, which differs by
 * kind: Windows zips put `node.exe` in a folder, the POSIX tarballs put
 * `bin/node`.
 *
 * `runtimeSubdir` is where package.mjs stages it inside `runtime/`. Windows
 * keeps the historical flat `runtime/node.exe` because packaged-launcher.vbs
 * resolves exactly that path; POSIX uses `runtime/<arch>/node` so a universal
 * macOS package can carry both architectures and pick one at launch from
 * `uname -m`.
 */
export const NODE_FLAVOURS = {
  "win-x64": {
    file: `node-v${NODE_VERSION}-win-x64.zip`,
    inner: `node-v${NODE_VERSION}-win-x64/node.exe`,
    sha256: "55b639295920b219bb2acbcfa00f90393a2789095b7323f79475c9f34795f217",
    runtimeSubdir: null,
    binary: "node.exe",
  },
  "darwin-x64": {
    file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    inner: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
    sha256: "6698587713ab565a94a360e091df9f6d91c8fadda6d00f0cf6526e9b40bed250",
    runtimeSubdir: "x64",
    binary: "node",
  },
  "darwin-arm64": {
    file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    inner: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
    sha256: "e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42",
    runtimeSubdir: "arm64",
    binary: "node",
  },
  "linux-x64": {
    file: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    inner: `node-v${NODE_VERSION}-linux-x64/bin/node`,
    sha256: "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
    runtimeSubdir: "x64",
    binary: "node",
  },
  "linux-arm64": {
    file: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    inner: `node-v${NODE_VERSION}-linux-arm64/bin/node`,
    sha256: "8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0",
    runtimeSubdir: "arm64",
    binary: "node",
  },
  "linux-armv7l": {
    file: `node-v${NODE_VERSION}-linux-armv7l.tar.gz`,
    inner: `node-v${NODE_VERSION}-linux-armv7l/bin/node`,
    sha256: "1cadf5aee7d71b6f0921235faec05e42d908ba5e8a76959f0697968fe0741204",
    runtimeSubdir: "armv7l",
    binary: "node",
  },
};

/**
 * The `nodejs.org/dist` base every runtime is fetched from, and the checksum
 * file that pins them. Both live here so nothing can drift from NODE_VERSION.
 */
export const DIST_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;
export const CHECKSUMS_URL = `${DIST_BASE}/SHASUMS256.txt`;

/**
 * The packageable targets, keyed by the id `neu` uses for its platform binary
 * (`actor0-desktop-<id>` after the rename), which is also the id the packaging
 * command takes.
 *
 * `slug` is the stable, hyphenated name used in artifact file names
 * (the target id uses `_`, which reads as a typo in a filename).
 *
 * `os`/`arch`/`universal` name the platform triple for `neu`'s own constants;
 * `universal` mac bundles both Node flavours because a single binary must run
 * on Apple Silicon and on Intel, and neither single-arch Node runs on both.
 */
export const TARGETS = {
  win_x64: { os: "win32", arch: "x64", slug: "win-x64", flavour: "win-x64", archive: "zip" },
  mac_x64: { os: "darwin", arch: "x64", slug: "mac-x64", flavour: "darwin-x64", archive: "zip" },
  mac_arm64: { os: "darwin", arch: "arm64", slug: "mac-arm64", flavour: "darwin-arm64", archive: "zip" },
  mac_universal: {
    os: "darwin",
    arch: "universal",
    slug: "mac-universal",
    flavour: null,
    flavours: ["darwin-x64", "darwin-arm64"],
    archive: "zip",
  },
  linux_x64: { os: "linux", arch: "x64", slug: "linux-x64", flavour: "linux-x64", archive: "tar.gz" },
  linux_arm64: { os: "linux", arch: "arm64", slug: "linux-arm64", flavour: "linux-arm64", archive: "tar.gz" },
  linux_armhf: { os: "linux", arch: "armhf", slug: "linux-armhf", flavour: "linux-armv7l", archive: "tar.gz" },
};

/** The Node flavours a target bundles — two for the universal macOS build. */
export function targetFlavours(targetId) {
  const target = TARGETS[targetId];
  if (!target) throw new Error(`unknown target "${targetId}" — known: ${Object.keys(TARGETS).join(", ")}`);
  return target.flavours ?? [target.flavour];
}

/** The resolved Node distribution a target bundles. */
export function targetRuntimes(targetId) {
  return targetFlavours(targetId).map((flavour) => ({ flavour, ...NODE_FLAVOURS[flavour] }));
}

/** A platform-hosted archive, or a ZIP (which every platform unpacks). */
export function archiveKind(targetId) {
  return TARGETS[targetId].archive;
}

export const isWindows = (targetId) => TARGETS[targetId].os === "win32";

/**
 * The binary `neu build` writes for a target once `cli.binaryName` has been
 * substituted for `neutralino`.
 */
export function neuBinaryName(targetId) {
  return `actor0-desktop-${targetId}${isWindows(targetId) ? ".exe" : ""}`;
}

/**
 * The name the binary is staged under: version-stamped on every platform.
 *
 * Windows needs it (the taskbar icon cache is keyed on exe path+name, so a
 * rebuild at the same name keeps the first build's icon), and POSIX inherits
 * the convention so launcher templates, READMEs and desktop entries all name
 * one file instead of a moving one.
 */
export function stagedBinaryName(version, targetId) {
  return `actor0-${version}-${TARGETS[targetId].slug}${isWindows(targetId) ? ".exe" : ""}`;
}

/** The installable: `actor0-desktop-<version>-<target>.zip|.tar.gz`. */
export function artifactName(version, targetId) {
  const ext = archiveKind(targetId) === "tar.gz" ? "tar.gz" : "zip";
  return `actor0-desktop-${version}-${targetId}.${ext}`;
}
