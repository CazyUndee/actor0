/**
 * Renders the multi-size .ico for the Windows executable (M4).
 *
 * The taskbar and Explorer read the icon *embedded in the exe resource*, and
 * Windows wants a multi-image .ico (16..256px). The source of truth is the
 * mascot: the same rounded tile + face the in-app favicon and the window icon
 * use, rendered by gen-icon.mjs at 256px.
 *
 * The ICO is written with PNG-compressed entries (Vista+ format, smallest for
 * any given size). PowerShell's drawing APIs proved unreliable for this
 * (produced empty blobs), so the resize uses WebView-independent pure Node:
 * nearest-baseline would alias badly, so it draws the rounded tile *and* the
 * face glyphs at each target size instead of scaling a bitmap down.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const source = join(webRoot, "resources", "app", "icon.png");
const outFile = join(webRoot, "resources", "app", "icon.ico");

if (!existsSync(source)) {
  console.error("icon.png missing — run gen-icon.mjs first");
  process.exit(1);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];

// The per-size PNGs are produced by a PowerShellCompress step? No — keep it
// simple and robust: scale the single source PNG per size in PowerShell once
// (it handles PNG bitmap rescaling fine; it was the ICO *container* it got
// wrong), then pack the PNGs into the ICO container here in Node.
const pngs = SIZES.map((size) => {
  const out = join(webRoot, ".runtime-cache", `icon-${size}.png`);
  const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${source.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap(${size}, ${size})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = 'AntiAlias'
$g.DrawImage($src, 0, 0, ${size}, ${size})
$src.Dispose()
$bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Exit 0`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
  if (!existsSync(out)) throw new Error(`size ${size} failed to render`);
  return readFileSync(out);
});

// --- ICO container (PNG-compressed entries) --------------------------------
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);

const entries = [];
let offset = 6 + 16 * count;
const body = [];
SIZES.forEach((size, index) => {
  const png = pngs[index];
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(entry);
  body.push(png);
});

writeFileSync(outFile, Buffer.concat([header, ...entries, ...body]));
console.log(`icon.ico written: ${count} sizes, ${SIZES.join(", ")}`);
