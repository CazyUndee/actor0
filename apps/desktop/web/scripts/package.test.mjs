import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeIcns, encodeIco, pngFor, renderIcon } from "./icon-art.mjs";
import { createTarGz, extractTarGz, makeExecutablePredicate } from "./tar.mjs";
import { artifactName, targetRuntimes, TARGETS } from "./targets.mjs";

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
