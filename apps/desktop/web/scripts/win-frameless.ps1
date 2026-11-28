<#
Strips the frame Windows draws around the app's borderless window.

The window is borderless and transparent (neutralino.config.json,
modes.window), so the page's own anti-aliased border-radius is the window's
silhouette and the app draws its own 2px ring inside it. DWM adds two things
neither the config nor the CSS can reach, and both are a second border:

  1. WS_THICKFRAME, when the window is resizable: a real non-client area that
     shrinks the client rect by 7px a side and paints that band. Removing the
     style makes the client area the whole window.
  2. DWMWA_BORDER_COLOR (34): the 1px frame line Windows 11 draws around every
     window. It is translucent, so over a magenta backdrop the app's outermost
     pixel measured (200,47,200) — a blend — with the app's own content only
     from the second pixel inward. Setting DWMWA_COLOR_NONE removes it, and the
     same pixel then measured pure app content. Nothing in the app can ask for
     that: the attribute is a DWM call, and DwmSetWindowAttribute is not in
     Neutralino's native API.

Corner preference is set to DONOTROUND for the same reason the border is
cleared: the page's radius is the silhouette. DWM's own rounding is fixed at
8px and would clip the app's 16px curve, which is what makes a corner look
"thinner and not anti-aliased".

Run by both launch paths — scripts/run.mjs (dev, window mode) and
start-actor0.vbs (packaged) — so there is one copy of this and not two that
drift. The window does not exist when either starts it, so this polls.
#>
param(
  # How long to keep looking for the window. The packaged launcher starts this
  # before it starts the agent, so it has to outlast agent start plus window
  # creation; anything shorter silently loses the race on a slow machine.
  [int]$Seconds = 30
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Frameless {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
}
'@

$WS_THICKFRAME = 0x00040000
$GWL_STYLE = -16
$DWMWA_NCRENDERING_POLICY = 2
$DWMWA_WINDOW_CORNER_PREFERENCE = 33
$DWMWA_BORDER_COLOR = 34
$DWMNCRP_DISABLED = 1
$DWMWCP_DONOTROUND = 1
$DWMWA_COLOR_NONE = [int]0xFFFFFFFE

# The shell binary is named `actor0-<version>-win-x64.exe` in a package and
# `neutralino-win_x64.exe` in dev; both carry a main window and nothing else
# on the machine does under those names.
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $app = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match '^(actor0|neutralino)' } |
    Select-Object -First 1
  if ($app) {
    $h = $app.MainWindowHandle
    $style = [Frameless]::GetWindowLong($h, $GWL_STYLE)
    if (($style -band $WS_THICKFRAME) -ne 0) {
      [Frameless]::SetWindowLong($h, $GWL_STYLE, $style -band (-bnot $WS_THICKFRAME)) | Out-Null
    }
    $ncr = $DWMNCRP_DISABLED
    [Frameless]::DwmSetWindowAttribute($h, $DWMWA_NCRENDERING_POLICY, [ref]$ncr, 4) | Out-Null
    $corner = $DWMWCP_DONOTROUND
    [Frameless]::DwmSetWindowAttribute($h, $DWMWA_WINDOW_CORNER_PREFERENCE, [ref]$corner, 4) | Out-Null
    $none = $DWMWA_COLOR_NONE
    $hr = [Frameless]::DwmSetWindowAttribute($h, $DWMWA_BORDER_COLOR, [ref]$none, 4)
    # A border that could not be cleared is the one failure worth reporting:
    # the app then wears two borders and nothing else says why. 0 is S_OK.
    if ($hr -ne 0) { Write-Output "win-frameless: could not clear the DWM border (hr=$hr)" }
    exit 0
  }
  Start-Sleep -Milliseconds 250
}
Write-Output "win-frameless: no app window within $Seconds s"
exit 1
