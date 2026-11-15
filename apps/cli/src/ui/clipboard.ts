import { spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Put text on the system clipboard.
 *
 * There is no Node API for this, so it is the platform's tool or nothing: no
 * library, no dependency, no daemon. The command list is ordered by preference
 * and the first one that spawns wins — `clip` on Windows, `pbcopy` on macOS,
 * and on Linux the Wayland and X11 tools in that order.
 *
 * Every failure is swallowed. A copy that does not land is an annoyance; an
 * exception thrown from a mouse handler mid-draw would take the session down,
 * and there is nothing the user could do about it.
 *
 * Returns whether a tool was spawned — not whether the clipboard took the text,
 * which cannot be known synchronously. The caller uses it only to pick a notice.
 *
 * Encoding: `clip.exe` reads stdin in the console's active code page, so
 * multi-byte UTF-8 (the glyphs the transcript is made of) arrives mangled.
 * On Windows we therefore write the text to a temp file as UTF-8 and have
 * PowerShell read that file with an explicit UTF-8 encoding, which sidesteps
 * the stdin code-page problem entirely.
 */
export function copyToClipboard(text: string): boolean {
  if (!text) return false;
  if (process.platform === "win32") {
    return copyViaPowerShellFile(text);
  }
  for (const [command, args] of candidates()) {
    try {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      child.stdin?.end(text, "utf8");
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Create the UTF-8 temp file the PowerShell clipboard hop reads, or undefined
 * when the path could not be claimed.
 *
 * Exported for the regression test that pins the symlink rule. The name is
 * unpredictable (`randomBytes`) *and* the open is `wx`, and both halves matter:
 * the randomness makes a guess useless, while `wx` means that even a correct
 * guess — a hostile local process that pre-created the path as a symlink — is
 * refused instead of written through. A predictable name opened with plain `w`
 * is the classic shared-temp symlink attack: verified to truncate a file
 * outside any directory the agent was given.
 */
export function createClipTempFile(text: string): { file: string; remove: () => void } | undefined {
  const file = join(tmpdir(), `actor0-clip-${process.pid}-${randomBytes(16).toString("hex")}.txt`);
  let handle: number;
  try {
    handle = openSync(file, "wx", 0o600);
  } catch {
    return undefined;
  }
  const remove = (): void => {
    try { unlinkSync(file); } catch { /* best effort */ }
  };
  try {
    // Write with a UTF-8 BOM so PowerShell's Get-Content auto-detects UTF-8
    // regardless of the system's default encoding.
    writeFileSync(handle, "\uFEFF" + text, "utf8");
    closeSync(handle);
  } catch {
    try { closeSync(handle); } catch { /* the failure already closed it */ }
    remove();
    return undefined;
  }
  return { file, remove };
}

function copyViaPowerShellFile(text: string): boolean {
  // The temp file is created, not merely named — see createClipTempFile for
  // why that distinction is the security property.
  const created = createClipTempFile(text);
  if (!created) return false;
  const { file, remove } = created;
  const script =
    "$t = Get-Content -LiteralPath $env:ACTOR0_CLIP_FILE -Raw -Encoding UTF8; " +
    "Set-Clipboard -Value $t";
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: "ignore", windowsHide: true, env: { ...process.env, ACTOR0_CLIP_FILE: file } },
    );
    child.on("error", () => {
      // The child never started, so nothing will read the file and no `exit`
      // is coming: unlink here, or the transcript text the user copied sits in
      // the shared temp dir indefinitely.
      remove();
    });
    // Clean up once the process exits.
    child.on("exit", remove);
    return true;
  } catch {
    remove();
    return false;
  }
}

function candidates(): [string, string[]][] {
  if (process.platform === "darwin") return [["pbcopy", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}
