/**
 * Renders the window/taskbar icon: the mascot face on its rounded square.
 *
 * The face is *drawn*, not typeset. A font glyph (`-_-` in Consolas) does not
 * survive being scaled to a 16px taskbar icon: the underscores sit on the
 * baseline, the downscale drops them below the tile, and what is left reads as
 * a lone dash. The shapes mirror `faceShapes()` in src/mascot.ts exactly, so the
 * taskbar, the window icon and the favicon are the same mark at every size.
 *
 * Runs from assemble.mjs (not by hand) because `vite build` empties
 * resources/app — a hand-copied icon would vanish on every build.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const outDir = join(webRoot, "resources", "app");
const outFile = join(outDir, "icon.png");

// Idle face: two dashes at mid height with one low between them, in 64-unit
// tile coordinates. Kept in sync with faceShapes() in src/mascot.ts.
const accent = "232, 144, 144"; // #e89090
const ps = `
Add-Type -AssemblyName System.Drawing
$size = 256
$s = $size / 64.0   # tile units -> pixels
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

# rounded tile
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 14 * $s
$rect = New-Object System.Drawing.Rectangle(0, 0, ($size - 1), ($size - 1))
$d = 2 * $r
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
$path.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
$path.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
$path.CloseFigure()
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 26, 26, 26))
$g.FillPath($bg, $path)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(128, 125, 124, 121), 3 * $s)
$g.DrawPath($pen, $path)

# the face: two mid dashes and one low dash, drawn as rounded bars
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, ${accent}))
function Bar($x, $y, $w, $h) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $rr = ($h / 2)
  $rect = New-Object System.Drawing.Rectangle([int]($x * $s), [int]($y * $s), [int]($w * $s), [int]($h * $s))
  $dd = [int](2 * $rr * $s)
  $p.AddArc($rect.X, $rect.Y, $dd, $dd, 180, 90)
  $p.AddArc(($rect.Right - $dd), $rect.Y, $dd, $dd, 270, 90)
  $p.AddArc(($rect.Right - $dd), ($rect.Bottom - $dd), $dd, $dd, 0, 90)
  $p.AddArc($rect.X, ($rect.Bottom - $dd), $dd, $dd, 90, 90)
  $p.CloseFigure()
  $g.FillPath($accent, $p)
}
Bar 9 26 14 6    # left dash
Bar 25 42 14 6   # low dash (the mouth of -_-)
Bar 41 26 14 6   # right dash

$g.Dispose()
$bmp.Save('${outFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Exit 0
`;

mkdirSync(outDir, { recursive: true });
const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
if (!existsSync(outFile)) {
  // Non-Windows or PowerShell unavailable: the window simply keeps the default
  // icon there; the favicon (an SVG data URI) is unaffected.
  console.log("icon.png not generated (powershell unavailable?) — window keeps the default icon");
  process.exit(0);
}
console.log(result.status === 0 ? "icon.png written (vector face)" : "icon.png written (with warnings)");