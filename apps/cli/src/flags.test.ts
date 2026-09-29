import { test } from "node:test";
import assert from "node:assert/strict";
import { FlagError, nearestFlag, parseFlags, resolveCwd } from "./flags.js";

/**
 * The parser used to live in `index.ts`, which runs `main()` on import, so it
 * had no tests — and so it went unnoticed that every malformed command line did
 * something other than what was asked, silently.
 */

test("an empty command line is a plain run", () => {
  assert.deepEqual(parseFlags([]), { new: false, help: false, version: false, sessions: false });
});

test("the boolean flags set what they say", () => {
  assert.equal(parseFlags(["--new"]).new, true);
  assert.equal(parseFlags(["--help"]).help, true);
  assert.equal(parseFlags(["-h"]).help, true);
  assert.equal(parseFlags(["--version"]).version, true);
  assert.equal(parseFlags(["-v"]).version, true);
  assert.equal(parseFlags(["--sessions"]).sessions, true);
});

test("flags that take a value take the next argument", () => {
  assert.equal(parseFlags(["--session", "abc"]).session, "abc");
  assert.equal(parseFlags(["--cwd", "/tmp/x"]).cwd, "/tmp/x");
  assert.equal(parseFlags(["-p", "hello there"]).print, "hello there");
  assert.equal(parseFlags(["--print", "hi"]).print, "hi");
});

test("flags combine", () => {
  const flags = parseFlags(["--cwd", "/tmp", "-p", "do the thing"]);
  assert.equal(flags.cwd, "/tmp");
  assert.equal(flags.print, "do the thing");
});

test("a value-taking flag with no value stops rather than guessing", () => {
  // `actor0 --session` used to resume the *most recent* session instead. The
  // user asked for a specific conversation and silently got a different one.
  assert.throws(() => parseFlags(["--session"]), FlagError);
  assert.throws(() => parseFlags(["--cwd"]), /--cwd needs a path/);
  assert.throws(() => parseFlags(["-p"]), /-p needs a prompt/);
});

test("a value-taking flag followed by another flag is missing its value", () => {
  // `--session --version` is a cut-short line, not a session called
  // "--version". Taking the flag as the value would have looked up a session
  // with an id that can never exist.
  assert.throws(() => parseFlags(["--session", "--new"]), /--session needs an id/);
  assert.throws(() => parseFlags(["--cwd", "--version"]), /--cwd needs a path/);
});

test("a prompt that starts with a dash can still be sent", () => {
  // The guard above is about *flag* tokens, so `-p --version` is a cut-short
  // line rather than a prompt. `--` is the conventional way out, and without
  // it there is simply no way to send one.
  assert.throws(() => parseFlags(["-p", "--version"]), FlagError);
  assert.equal(parseFlags(["--", "--version is a flag"]).print, "--version is a flag");
  assert.equal(parseFlags(["-p", "plain", "--", "ignored"]).print, "plain");
});

test("a mistyped flag is named back with its correction", () => {
  // `--modle` used to be discarded without a word, so the run that followed
  // was not the one that was asked for.
  assert.throws(() => parseFlags(["--sessoin", "abc"]), /Did you mean --session/);
  assert.throws(() => parseFlags(["--sessons"]), /Did you mean --sessions/);
  assert.throws(() => parseFlags(["--nw"]), /Did you mean --new/);
  assert.throws(() => parseFlags(["--cwi", "/tmp"]), /Did you mean --cwd/);
});

test("an unrecognised flag that is not a near-miss still explains itself", () => {
  assert.throws(() => parseFlags(["--frobnicate"]), /unknown flag --frobnicate.*--help/s);
});

test("a stray word is refused and told how to send it as a prompt", () => {
  // `actor0 hello` used to launch a TUI that appeared to ignore the user.
  assert.throws(() => parseFlags(["hello"]), /unexpected argument "hello".*actor0 -p/s);
  assert.throws(() => parseFlags(["fix the bug"]), /unexpected argument/);
});

test("contradictory ways of picking a session are rejected", () => {
  // Whichever won would have been decided by code the user cannot see.
  assert.throws(() => parseFlags(["--new", "--session", "abc"]), /contradict/);
  assert.throws(() => parseFlags(["--new", "-p", "hi"]), /contradict/);
});

test("the failure names the program and the fix", () => {
  try {
    parseFlags(["--cwd"]);
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof FlagError);
    assert.equal((error as Error).name, "FlagError");
  }
});

// --- the suggestion helper -------------------------------------------------

test("nearestFlag finds a real typo and ignores an unrelated one", () => {
  const known = ["--new", "--help", "--version", "--sessions", "--session", "--cwd", "--print"];
  assert.equal(nearestFlag("--sessoin", known), "--session");
  assert.equal(nearestFlag("--sessons", known), "--sessions");
  assert.equal(nearestFlag("--prt", known), "--print");
  // Far from anything real: guessing here would be worse than saying "unknown".
  assert.equal(nearestFlag("--zzz", known), undefined);
  assert.equal(nearestFlag("-", known), undefined);
  assert.equal(nearestFlag("", known), undefined);
});

test("a single-character difference is still a match", () => {
  const known = ["--new", "--cwd", "--print"];
  assert.equal(nearestFlag("--cw", known), "--cwd");
  assert.equal(nearestFlag("--prnt", known), "--print");
});

// --- cwd --------------------------------------------------------------------

test("resolveCwd falls back to the process directory, and never returns a relative path", () => {
  assert.equal(resolveCwd(undefined), process.cwd());
  const resolved = resolveCwd(".");
  assert.ok(!resolved.startsWith("."), `expected an absolute path, got ${resolved}`);
});
