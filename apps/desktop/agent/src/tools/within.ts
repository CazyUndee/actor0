import { lstat, readlink, realpath } from "node:fs/promises";
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
 * exists is resolved with `realpath` and the tail is re-applied one component at
 * a time — the target of a `write` usually does not exist yet. A *non-existent*
 * tail cannot be a live link, but a **dangling** link (`escape.txt` -> a path
 * outside the root that does not exist yet) can sit in that tail: realpath fails
 * on it, yet lstat sees the link and readlink reveals where it points. Each
 * missing component is lstat'd and a symlink is followed before the path is
 * accepted, so a planted dangling link cannot carry a write outside the root.
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
      // Re-apply the missing tail one component at a time from the deepest real
      // ancestor, following any symlink — including a dangling one — so the
      // containment check runs against where the OS would actually write.
      if (tail.length === 0) {
        resolved = real;
      } else {
        resolved = real;
        for (const component of tail.reverse()) {
          const next = resolve(resolved, component);
          const link = await lstat(next).catch(() => null);
          if (link?.isSymbolicLink()) {
            const dest = await readlink(next).catch(() => null);
            resolved = dest === null ? next : resolve(dirname(next), dest);
          } else {
            resolved = next;
          }
        }
      }
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
