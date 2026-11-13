import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Path containment.
 *
 * Nothing in this app is gated behind an approval dialog — a prompt that is
 * always approved is not a control. What actually contains the agent is this:
 * writes and edits stay inside the working directory, and the check is against
 * *real* paths, not lexical ones.
 *
 * The lexical form (`resolve` + `startsWith`) is satisfied by any path that
 * merely reads as inside the root, and a symlink or Windows junction inside the
 * working directory is exactly such a path: `link/escape/secret.txt` is
 * lexically inside and physically anywhere. So the deepest ancestor that
 * exists is resolved with `realpath` and the tail is appended — the target of a
 * `write` usually does not exist yet, and a non-existent tail cannot contain a
 * link, because there is nothing to point at.
 *
 * Readers resolve but are not contained: inspecting the wider machine is the
 * point of `read`, `glob` and `rg`, and a read can neither plant nor modify
 * anything. Writers are contained, and an escape is a refusal.
 */

/** Did a relative path leave the root? A `..` *segment*, not a `..` prefix. */
export function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Resolve `path` against `cwd`, refusing to escape it when `contain` is set.
 *
 * The refusal names both the requested path and where it really landed, because
 * the usual cause is a link, and a message that only said "outside the working
 * directory" would send the reader looking for a `..` that is not there.
 */
export async function within(cwd: string, path: string, contain = true): Promise<string> {
  const target = isAbsolute(path) ? path : resolve(cwd, path);
  const root = contain ? await realpath(resolve(cwd)).catch(() => resolve(cwd)) : undefined;

  let resolved = target;
  const tail: string[] = [];
  for (;;) {
    const real = await realpath(resolved).catch(() => null);
    if (real !== null) {
      resolved = tail.length === 0 ? real : resolve(real, ...tail.reverse());
      break;
    }
    const parent = dirname(resolved);
    if (parent === resolved) break;
    tail.push(resolved.slice(parent.length + 1));
    resolved = parent;
  }

  if (root === undefined) return resolved;
  const rel = relative(root, resolved);
  if (rel === "") return resolved;
  if (escapes(rel)) {
    throw new Error(
      `refusing to touch ${path}: resolves to ${resolved}, outside the working directory ${root}` +
        (tail.length > 0 ? " (through a link)" : ""),
    );
  }
  return resolved;
}
