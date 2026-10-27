import { spawn } from "node:child_process";

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
 */
export function copyToClipboard(text: string): boolean {
  if (!text) return false;
  for (const [command, args] of candidates()) {
    try {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      child.stdin?.end(text);
      return true;
    } catch {
      // A missing tool surfaces as an "error" event, not a throw; this catch is
      // for the exotic case of a spawn that throws outright.
      continue;
    }
  }
  return false;
}

function candidates(): [string, string[]][] {
  if (process.platform === "win32") return [["clip", []]];
  if (process.platform === "darwin") return [["pbcopy", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}
