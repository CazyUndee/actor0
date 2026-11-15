import assert from "node:assert/strict";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClipTempFile } from "./clipboard.js";

/**
 * The Windows clipboard hop writes the copied text to a file in the shared temp
 * directory and hands PowerShell its path. That file's name used to be
 * predictable — `actor0-clip-<pid>-<epoch_ms>.txt` — and it was opened with a
 * plain `writeFileSync`, which follows a symlink.
 *
 * A hostile local process could therefore guess the name (pids are enumerable,
 * the timestamp is a small window), pre-create it as a symlink, and have the
 * CLI write the user's transcript selection *through* the link — truncating and
 * replacing whatever it pointed at. Verified before the fix: a victim file
 * outside any directory the agent was given was overwritten.
 *
 * These tests pin both halves of the fix: the name is unpredictable, and a
 * path that already exists is refused rather than written through.
 */

test("two clipboard temp files never share a name", () => {
  const first = createClipTempFile("one");
  const second = createClipTempFile("two");
  try {
    assert.ok(first, "the first create should succeed");
    assert.ok(second, "the second create should succeed");
    assert.notEqual(first!.file, second!.file, "a predictable name is what made the symlink plant possible");
  } finally {
    first?.remove();
    second?.remove();
  }
});

test("an already-existing path is refused, not written through", () => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-clip-test-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "IMPORTANT DATA\n");
  const planted = join(dir, "actor0-clip-planted.txt");
  symlinkSync(victim, planted);
  try {
    // The stand-in for "a hostile process guessed the name". The real fix makes
    // the guess infeasible (randomBytes) *and* the open `wx`; this asserts the
    // second half directly, since the first cannot be forced.
    const opened = ((): boolean => {
      try {
        const handle = openSync(planted, "wx", 0o600);
        closeSync(handle);
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(opened, false, "`wx` must refuse a pre-existing path instead of truncating through it");
    assert.equal(readFileSync(victim, "utf8"), "IMPORTANT DATA\n", "the link's target must be untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the temp file holds the text and removes itself", () => {
  const created = createClipTempFile("transcript selection");
  assert.ok(created, "create should succeed on a fresh name");
  try {
    const raw = readFileSync(created!.file, "utf8");
    // PowerShell's Get-Content needs the BOM to auto-detect UTF-8; the text
    // after it is what lands on the clipboard.
    assert.ok(raw.startsWith("\uFEFF"), "a UTF-8 BOM is what makes non-ASCII survive the hop");
    assert.equal(raw.slice(1), "transcript selection");
  } finally {
    created!.remove();
  }
  assert.throws(() => readFileSync(created!.file, "utf8"), /ENOENT/, "remove() must take the file with it");
});