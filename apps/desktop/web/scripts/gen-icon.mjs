/**
 * Renders the window/taskbar icon: the mascot face on its rounded square.
 *
 * The face is drawn at the same proportions as the in-app mascot (rounded #1a1a1a
 * tile, hairline ring, the face glyphs in the accent colour), so the taskbar,
 * the window and the favicon all show the same mark.
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

const ps = `
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 56
$rect = New-Object System.Drawing.Rectangle(0, 0, ($size - 1), ($size - 1))
$d = 2 * $r
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
$path.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
$path.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
$path.CloseFigure()
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 26, 26, 26))
$g.FillPath($bg, $path)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(128, 125, 124, 121), 8)
$g.DrawPath($pen, $path)
$font = New-Object System.Drawing.Font("Consolas", 72, [System.Drawing.FontStyle]::Bold)
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(201, 122, 122))
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rectFull = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
$g.DrawString("-_-", $font, $accent, $rectFull, $fmt)
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
}
console.log(result.status === 0 ? "icon.png written" : "icon.png written (with warnings)");
