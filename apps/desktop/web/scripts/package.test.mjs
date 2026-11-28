import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nsisScript } from "./nsis.mjs";
import { createDeb } from "./deb.mjs";
import { encodeIcns, encodeIco, pngFor, renderIcon } from "./icon-art.mjs";
import { createTarGz, extractTarGz, makeExecutablePredicate } from "./tar.mjs";
import { artifactName, installerName, targetRuntimes, TARGETS } from "./targets.mjs";

test("the target table is the seven installables, with no invented Windows arm64", () => {
  assert.deepEqual(Object.keys(TARGETS).sort(), [
    "linux_arm64", "linux_armhf", "linux_x64",
    "mac_arm64", "mac_universal", "mac_x64",
    "win_x64",
  ]);
  assert.equal(TARGETS.win_arm64, undefined);
  assert.equal(Object.values(TARGETS).filter((target) => target.os === "win32").length, 1);
});

test("a universal macOS package carries both Node flavours; armhf is armv7l on disk", () => {
  const universal = targetRuntimes("mac_universal");
  assert.deepEqual(universal.map((runtime) => runtime.runtimeSubdir).sort(), ["arm64", "x64"]);
  const armhf = targetRuntimes("linux_armhf");
  assert.equal(armhf.length, 1);
  assert.equal(armhf[0].runtimeSubdir, "armv7l");
  assert.equal(armhf[0].binary, "node");
  assert.equal(targetRuntimes("win_x64")[0].binary, "node.exe");
  assert.equal(targetRuntimes("win_x64")[0].runtimeSubdir, null);
});

test("artifact names are the release's filenames", () => {
  assert.equal(artifactName("1.2.3", "win_x64"), "actor0-desktop-1.2.3-win_x64.zip");
  assert.equal(artifactName("1.2.3", "mac_arm64"), "actor0-desktop-1.2.3-mac_arm64.zip");
  assert.equal(artifactName("1.2.3", "linux_armhf"), "actor0-desktop-1.2.3-linux_armhf.tar.gz");
});


test("installer names match the platform conventions", () => {
  assert.equal(installerName("1.2.3", "win_x64"), "actor0-desktop-1.2.3-win_x64-setup.exe");
  assert.equal(installerName("1.2.3", "mac_universal"), "actor0-desktop-1.2.3-mac_universal.dmg");
  assert.equal(installerName("1.2.3", "linux_x64"), "actor0-desktop_1.2.3_amd64.deb");
  assert.equal(installerName("1.2.3", "linux_arm64"), "actor0-desktop_1.2.3_arm64.deb");
  assert.equal(installerName("1.2.3", "linux_armhf"), "actor0-desktop_1.2.3_armhf.deb");
});

function arMembers(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("ascii"), "!<arch>\n");
  const members = [];
  let offset = 8;
  while (offset < buffer.length) {
    const header = buffer.subarray(offset, offset + 60);
    assert.equal(header.subarray(58, 60).toString("ascii"), "`\n");
    const name = header.subarray(0, 16).toString("ascii").trim().replace(/\/$/, "");
    const size = Number.parseInt(header.subarray(48, 58).toString("ascii").trim(), 10);
    members.push({ name, data: buffer.subarray(offset + 60, offset + 60 + size) });
    offset += 60 + size + (size % 2);
  }
  return members;
}

test("the deb is an ar archive with control metadata and an executable data tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "actor0-deb-"));
  try {
    const layout = join(root, "layout");
    mkdirSync(join(layout, "runtime", "x64"), { recursive: true });
    mkdirSync(join(layout, "agent"), { recursive: true });
    writeFileSync(join(layout, "actor0"), "#!/bin/sh\nexec ./actor0-0.5.7-linux-x64\n");
    writeFileSync(join(layout, "actor0-0.5.7-linux-x64"), "dummy shell");
    writeFileSync(join(layout, "resources.neu"), "resources");
    writeFileSync(join(layout, "runtime", "x64", "node"), "node");
    writeFileSync(join(layout, "agent", "agent.mjs"), "agent");
    writeFileSync(join(layout, "README.txt"), "readme\n");
    writeFileSync(join(layout, "install.sh"), "#!/bin/sh\n");
    writeFileSync(join(layout, "icon.png"), "png");
    const out = join(root, "actor0-desktop_0.5.7_amd64.deb");
    await createDeb({
      layout,
      version: "0.5.7",
      targetId: "linux_x64",
      outFile: out,
      binaryName: "actor0-0.5.7-linux-x64",
    });

    const brew = readFileSync(out);
    const members = arMembers(brew);
    assert.deepEqual(members.map((member) => member.name), ["debian-binary", "control.tar.gz", "data.tar.gz"]);
    assert.equal(members[0].data.toString("utf8"), "2.0\n");

    const controlDir = join(root, "control");
    const dataDir = join(root, "data");
    mkdirSync(controlDir);
    mkdirSync(dataDir);
    writeFileSync(join(root, "control.tar.gz"), members[1].data);
    writeFileSync(join(root, "data.tar.gz"), members[2].data);
    extractTarGz(join(root, "control.tar.gz"), controlDir);
    extractTarGz(join(root, "data.tar.gz"), dataDir);

    const control = readFileSync(join(controlDir, "control"), "utf8");
    assert.match(control, /^Package: actor0-desktop$/m);
    assert.match(control, /^Architecture: amd64$/m);
    assert.match(control, /^Depends: .*libwebkit2gtk-4\.1-0/m);
    assert.match(control, /^Installed-Size: [1-9][0-9]*$/m);
    assert.ok(readFileSync(join(controlDir, "md5sums"), "utf8").includes("  usr/bin/actor0-desktop\n"));
    assert.ok(readFileSync(join(controlDir, "postinst"), "utf8").startsWith("#!/bin/sh\n"));

    const wrapper = join(dataDir, "usr", "bin", "actor0-desktop");
    assert.equal(readFileSync(wrapper, "utf8"), "#!/bin/sh\nexec /opt/actor0/actor0 \"$@\"\n");
    assert.ok(readFileSync(join(dataDir, "usr", "share", "applications", "actor0.desktop"), "utf8").includes("Exec=/opt/actor0/actor0"));
    assert.ok(existsSync(join(dataDir, "usr", "share", "icons", "hicolor", "512x512", "apps", "actor0.png")));
    assert.ok(existsSync(join(dataDir, "opt", "actor0", "actor0-0.5.7-linux-x64")));
    assert.ok(!existsSync(join(dataDir, "opt", "actor0", "install.sh")));
    assert.ok(!existsSync(join(dataDir, "opt", "actor0", "icon.png")));
    if (process.platform !== "win32") {
      assert.equal(statSync(wrapper).mode & 0o111, 0o111);
      assert.equal(statSync(join(dataDir, "opt", "actor0", "actor0")).mode & 0o111, 0o111);
      assert.equal(statSync(join(dataDir, "opt", "actor0", "actor0-0.5.7-linux-x64")).mode & 0o111, 0o111);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the NSIS script installs per user and points the shortcut at the VBS launcher", () => {
  const script = nsisScript({
    staging: "D:\\stage",
    outFile: "D:\\out\\setup.exe",
    version: "0.5.7",
    binaryName: "actor0-0.5.7-win-x64.exe",
    icon: "D:\\icon.ico",
  });
  assert.match(script, /^RequestExecutionLevel user$/m);
  assert.match(script, /^InstallDir "\$LOCALAPPDATA\\Programs\\actor0"$/m);
  assert.match(script, /^ {2}File \/r "\$\{STAGE\}\\\*"$/m);
  assert.match(script, /CreateShortCut .*start-actor0\.vbs/);
  assert.match(script, /"UninstallString"/);
  assert.match(script, /FileOpen \$1/);
  assert.doesNotMatch(script, /RequestExecutionLevel admin/);
});

test("the tarball round-trips a prefix, nested files and the executable bit", async () => {
  const root = mkdtempSync(join(tmpdir(), "actor0-tar-"));
  try {
    const source = join(root, "source");
    mkdirSync(join(source, "runtime", "x64"), { recursive: true });
    writeFileSync(join(source, "README.txt"), "hello\n");
    writeFileSync(join(source, "runtime", "x64", "node"), "#!/bin/sh\nexit 0\n");
    const archive = join(root, "pkg.tar.gz");
    await createTarGz(source, archive, {
      prefix: "actor0-test",
      executable: makeExecutablePredicate("actor0-test-app"),
    });
    const dest = join(root, "out");
    mkdirSync(dest);
    const written = extractTarGz(archive, dest);
    assert.ok(written.includes("actor0-test/README.txt"));
    assert.ok(written.includes("actor0-test/runtime/x64/node"));
    assert.equal(readFileSync(join(dest, "actor0-test", "README.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(join(dest, "actor0-test", "runtime", "x64", "node"), "utf8"), "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dest, "actor0-test", "runtime", "x64", "node")).mode & 0o111, 0o111);
      assert.equal(statSync(join(dest, "actor0-test", "README.txt")).mode & 0o111, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the icon encoders emit containers Windows and macOS accept", () => {
  const rgba = renderIcon(256).data;
  const png = pngFor(256);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.equal(rgba.length, 256 * 256 * 4);

  const ico = encodeIco();
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);

  const icns = encodeIcns();
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
});
