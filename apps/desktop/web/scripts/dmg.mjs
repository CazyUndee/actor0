/**
 * Wrap a signed .app in the disk image macOS users expect.
 *
 * The .zip remains for automation and for people who already have a bundle.
 * The DMG adds the conventional drag-to-Applications target. ditto is used
 * rather than cp or a plain file copy because it preserves the extended
 * attributes and resource fork that carry the ad-hoc signature.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export function buildDmg({ appDir, outFile, version }) {
  if (process.platform !== "darwin") throw new Error("a DMG can only be built on macOS");
  const root = `${outFile}.work`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    const copied = join(root, "actor0.app");
    console.log("copying the signed bundle into the disk image...");
    execFileSync("ditto", [appDir, copied], { stdio: "inherit" });
    // The conventional drag target. It is absolute because the image is
    // mounted at a different point on every machine, and /Applications is the
    // one path Finder resolves after the drag.
    symlinkSync("/Applications", join(root, "Applications"), "dir");
    execFileSync("codesign", ["--verify", "--deep", "--strict", copied], { stdio: "inherit" });
    console.log("building the compressed disk image...");
    execFileSync(
      "hdiutil",
      [
        "create",
        "-quiet",
        "-volname",
        `actor0 ${version}` ,
        "-srcfolder",
        root,
        "-ov",
        "-format",
        "UDZO",
        outFile,
      ],
      { stdio: "inherit" },
    );
    execFileSync("hdiutil", ["verify", outFile], { stdio: "inherit" });
    return outFile;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
