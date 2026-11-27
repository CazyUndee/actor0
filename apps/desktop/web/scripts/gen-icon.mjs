/**
 * Renders the window/taskbar icon and the macOS .icns.
 *
 * Both come from the same pure-Node renderer (icon-art.mjs), so the build no
 * longer needs PowerShell's System.Drawing and produces the same mark on
 * Windows, macOS and Linux. That matters because the packaging workflow runs
 * on all three: an icon step that silently skipped on a mac runner would ship
 * a bundle with the default Neutralino icon, and gen-ico's execFileSync would
 * have failed the Linux job outright.
 *
 * The shapes mirror faceShapes() in src/mascot.ts, so the taskbar, window,
 * favicon and dock icon stay one mark at every size.
 *
 * Runs from assemble.mjs (not by hand) because `vite build` empties
 * resources/app - a hand-copied icon would vanish on every build.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeIcns, pngFor } from "./icon-art.mjs";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(webRoot, "resources", "app");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "icon.png"), pngFor(256));
writeFileSync(join(outDir, "icon.icns"), encodeIcns());
console.log("icon.png + icon.icns written (vector face)");
