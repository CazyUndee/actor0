/**
 * Build a Debian binary package without dpkg-deb.
 *
 * The project cross-builds Linux artifacts from Windows, so shelling out to
 * dpkg-deb would make the .deb the one target only buildable on the host that
 * consumes it. A .deb is an `ar` archive around two gzip tarballs, and the
 * repository already writes deterministic ustar headers for the tar.gz
 * artifacts. This module adds the small ar layer and the Debian metadata;
 * dpkg-deb remains the verifier in CI, which is the part that matters.
 *
 * Layout: /opt/actor0 is the self-contained app. `/usr/bin/actor0-desktop` is
 * a tiny wrapper rather than a symlink, because a wrapper names the absolute
 * app path in one place and avoids depending on tar symlink support in the
 * cross-platform writer. It also leaves the npm CLI's `actor0` command alone.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTarGz, makeExecutablePredicate } from "./tar.mjs";
import { TARGETS } from "./targets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

/** Debian's architecture name for a Linux target id. */
export function debArchitecture(targetId) {
  const arch = TARGETS[targetId]?.deb;
  if (!arch) throw new Error(`${targetId} is not a Debian target`);
  return arch;
}

/** The file name Debian tools expect: package_version_arch.deb. */
export function debFileName(version, targetId) {
  return `actor0-desktop_${version}_${debArchitecture(targetId)}.deb`;
}

function arHeader(name, size, { mode = "100644", mtime = Math.floor(Date.now() / 1000) } = {}) {
  const field = (value, width) => value.padEnd(width, " ").slice(0, width);
  return Buffer.from(
    field(`${name}/`, 16) +
      field(String(mtime), 12) +
      field("0", 6) +
      field("0", 6) +
      field(mode, 8) +
      field(String(size), 10) +
      "`\n",
    "ascii",
  );
}

/**
 * An `ar` archive, which is what a .deb is before Debian metadata is added.
 * Members are padded to an even offset with a newline, as ar requires.
 */
export function createAr(members, mtime = Math.floor(Date.now() / 1000)) {
  const chunks = [Buffer.from("!<arch>\n", "ascii")];
  for (const member of members) {
    chunks.push(arHeader(member.name, member.data.length, { mtime }));
    chunks.push(member.data);
    if (member.data.length % 2 === 1) chunks.push(Buffer.from("\n"));
  }
  return Buffer.concat(chunks);
}

async function md5File(path) {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function controlText(version, targetId, installedSize) {
  return [
    "Package: actor0-desktop",
    `Version: ${version}`,
    `Architecture: ${debArchitecture(targetId)}`,
    "Maintainer: actor0 <actor0@users.noreply.github.com>",
    `Installed-Size: ${installedSize}`,
    "Depends: libc6 (>= 2.28), libgtk-3-0, libwebkit2gtk-4.1-0",
    "Section: utils",
    "Priority: optional",
    "Homepage: https://github.com/CazyUndee/actor0",
    "Description: actor0 desktop",
    " A native window around the actor0 coding agent, with its own pinned Node",
    " runtime. The application lives in /opt/actor0; user state stays in ~/.actor0",
    " and ~/.config/actor0.",
    "",
  ].join("\n");
}

const POSTINST = [
  "#!/bin/sh",
  "set -e",
  "if command -v update-desktop-database >/dev/null 2>&1; then",
  "  update-desktop-database -q /usr/share/applications || true",
  "fi",
  "if command -v gtk-update-icon-cache >/dev/null 2>&1; then",
  "  gtk-update-icon-cache -q /usr/share/icons/hicolor || true",
  "fi",
  "",
].join("\n");

/**
 * Write one architecture's .deb from an already staged Linux layout.
 *
 * `layout` is the same tree the tar.gz ships: the versioned shell binary,
 * resources.neu, the agent bundle, the launchers and the pinned Node runtime.
 * The tar installer and its icon are intentionally not copied: the package
 * manager owns installation, and the icon is installed in the hicolor theme.
 */
export async function createDeb({ layout, version, targetId, outFile, binaryName }) {
  if (TARGETS[targetId]?.os !== "linux") throw new Error(`${targetId} is not a Linux target`);
  const work = `${outFile}.work`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const dataRoot = join(work, "data");
    const appRoot = join(dataRoot, "opt", "actor0");
    mkdirSync(appRoot, { recursive: true });
    for (const entry of readdirSync(layout)) {
      if (entry === "install.sh" || entry === "icon.png") continue;
      cpSync(join(layout, entry), join(appRoot, entry), { recursive: true });
    }

    const binDir = join(dataRoot, "usr", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "actor0-desktop"), "#!/bin/sh\nexec /opt/actor0/actor0 \"$@\"\n", { mode: 0o755 });

    const applications = join(dataRoot, "usr", "share", "applications");
    mkdirSync(applications, { recursive: true });
    writeFileSync(
      join(applications, "actor0.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=actor0",
        "Comment=actor0 desktop agent",
        "Exec=/opt/actor0/actor0",
        "Icon=actor0",
        "Terminal=false",
        "Categories=Development;Utility;",
        "StartupWMClass=actor0-desktop",
        "",
      ].join("\n"),
    );

    const iconDir = join(dataRoot, "usr", "share", "icons", "hicolor", "512x512", "apps");
    mkdirSync(iconDir, { recursive: true });
    cpSync(join(layout, "icon.png"), join(iconDir, "actor0.png"));

    const docDir = join(dataRoot, "usr", "share", "doc", "actor0-desktop");
    mkdirSync(docDir, { recursive: true });
    const license = join(repoRoot, "LICENSE");
    if (existsSync(license)) cpSync(license, join(docDir, "copyright"));

    const files = walkFiles(dataRoot);
    let total = 0;
    for (const file of files) total += statSync(file).size;
    const installedSize = Math.ceil(total / 1024);

    const controlDir = join(work, "control");
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(join(controlDir, "control"), controlText(version, targetId, installedSize));
    writeFileSync(join(controlDir, "postinst"), POSTINST, { mode: 0o755 });
    writeFileSync(join(controlDir, "postrm"), POSTINST, { mode: 0o755 });

    const sums = [];
    for (const file of files.sort()) {
      const relative = file.slice(dataRoot.length + 1).split("\\").join("/");
      sums.push(`${await md5File(file)}  ${relative}`);
    }
    writeFileSync(join(controlDir, "md5sums"), `${sums.join("\n")}\n`);

    const dataTar = join(work, "data.tar.gz");
    const controlTar = join(work, "control.tar.gz");
    const program = makeExecutablePredicate(binaryName);
    await createTarGz(dataRoot, dataTar, {
      prefix: ".",
      level: 6,
      executable: (relative) => relative === "usr/bin/actor0-desktop" || program(relative),
    });
    await createTarGz(controlDir, controlTar, {
      prefix: ".",
      executable: (relative) => relative === "postinst" || relative === "postrm",
    });

    const deb = createAr([
      { name: "debian-binary", data: Buffer.from("2.0\n") },
      { name: "control.tar.gz", data: readFileSync(controlTar) },
      { name: "data.tar.gz", data: readFileSync(dataTar) },
    ]);
    rmSync(outFile, { force: true });
    writeFileSync(outFile, deb);
    return { installedSize, files: files.length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
