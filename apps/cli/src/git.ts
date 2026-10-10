import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The current git branch of a directory, without shelling out.
 *
 * `.git/HEAD` holds `ref: refs/heads/<branch>` on a normal checkout and a bare
 * commit id in a detached one. Reading the file is one stat and no subprocess;
 * the branch shows in the status bar so the user always knows what they are
 * editing against. Anything unreadable or detached is simply undefined — the
 * indicator is optional, never an error.
 */
export function gitBranch(cwd: string): string | undefined {
  try {
    const head = readFileSync(join(cwd, ".git", "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match ? match[1]! : undefined;
  } catch {
    return undefined;
  }
}
