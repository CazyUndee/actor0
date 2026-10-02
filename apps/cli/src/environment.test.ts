import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEnvironment, formatEnvironment, PROBED_COMMANDS, resetEnvironmentCache } from "./environment.js";
import { resolveShell } from "./tools.js";
import { defaultSystemPrompt, withProjectContext } from "./turn.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "actor0-env-"));

test("the inventory is a measurement, and the two halves do not overlap", () => {
  resetEnvironmentCache();
  const found = detectEnvironment(scratch());
  const overlap = found.present.filter((name) => found.absent.includes(name));
  assert.deepEqual(overlap, [], `a command cannot be both installed and not: ${overlap.join(", ")}`);
  assert.equal(
    found.present.length + found.absent.length,
    PROBED_COMMANDS.length,
    "every probed command must land on exactly one side of the line",
  );
});

test("the block says what is not installed, because that is the half the model gets wrong", () => {
  // The failure this exists to prevent is a model reaching for a canonical
  // command that this particular image does not have. Telling it what it has
  // is not enough — the absent list is the half that changes the behaviour,
  // and it is the half a model cannot derive for itself at any effort level.
  resetEnvironmentCache();
  const block = formatEnvironment(detectEnvironment(scratch()));
  assert.match(block, /not installed:/, "the absent list is the point of the block");
  assert.match(block, /installed:/);
  assert.match(block, /Measured on this machine/);
});

test("a machine that refused every probe reports nothing rather than reporting empty", () => {
  // The dangerous failure here is inverted: a failed probe that renders as
  // "not installed: <everything>" would tell the model that a machine with a
  // full toolchain has none of it, and the model would believe that.
  const empty = formatEnvironment({
    platform: "linux",
    shell: resolveShell(),
    present: [],
    absent: [],
  });
  assert.ok(!/not installed/.test(empty), `an empty measurement must not read as an absence: ${empty}`);
  assert.ok(!/installed:/.test(empty), "nor as a presence");
  // The shell and platform are known without any probe, so they survive.
  assert.match(empty, /operating system: linux/);
  assert.match(empty, /shell:/);
});

test("a test command is stated only when the project declares one", () => {
  // Printing the convention for a project that has no tests is the same
  // failure as fabricating a measurement: the model runs it, it fails, and it
  // has learned something false about the project from a prompt that read
  // like a finding.
  resetEnvironmentCache();
  const bare = scratch();
  assert.equal(detectEnvironment(bare).testCommand, undefined, "no manifest, no claim");

  resetEnvironmentCache();
  const node = scratch();
  writeFileSync(join(node, "package.json"), JSON.stringify({ name: "x", scripts: { build: "tsc" } }));
  assert.equal(detectEnvironment(node).testCommand, undefined, "a package.json with no test script is not a test runner");

  resetEnvironmentCache();
  const withTests = scratch();
  writeFileSync(join(withTests, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  assert.equal(detectEnvironment(withTests).testCommand, "npm test");

  resetEnvironmentCache();
  const rust = scratch();
  writeFileSync(join(rust, "Cargo.toml"), "[package]\nname='x'\n");
  assert.equal(detectEnvironment(rust).testCommand, "cargo test");
});

test("the block is facts, and never advice", () => {
  // Advice here would compete with the prompt's own for attention, and the
  // reason this block works at all is that it is not advice. It is the one
  // thing the model could not have known, handed over.
  const block = formatEnvironment(detectEnvironment(scratch()));
  assert.ok(!/you should|try to|remember to|make sure to/i.test(block), `the block gave an instruction: ${block}`);
});

test("the prompt tells the model the block is a measurement, and that it beats a guess", () => {
  resetEnvironmentCache();
  const cwd = scratch();
  const prompt = withProjectContext(defaultSystemPrompt(), cwd);
  assert.match(prompt, /<environment>/);
  assert.match(prompt, /measured on this machine, not assumed/i);
  // Ordering: the facts about the machine come before the user's own rules,
  // so a rule that contradicts the machine is visibly about to be overridden.
  assert.ok(
    prompt.indexOf("<environment>") < prompt.indexOf("<project_context>") ||
      !prompt.includes("<project_context>"),
    "environment facts must precede project instructions",
  );
});

test("a prompt for this machine does not describe another one", () => {
  // The whole class of bug: a prompt that is a claim about an operating
  // system rather than about the box the agent landed on. Terminal work moves
  // between a Windows host, a Linux container and a Mac, and a prompt that
  // hardcodes one of them is wrong on the other two.
  const prompt = defaultSystemPrompt();
  const shell = resolveShell();
  if (shell.family === "powershell") {
    assert.match(prompt, /PowerShell/, "a PowerShell shell must be described as PowerShell");
    assert.ok(!/This is bash/i.test(prompt));
  }
  if (shell.family === "posix") {
    assert.ok(!/This is PowerShell, not bash/.test(prompt), "a POSIX shell must not be told it is PowerShell");
  }
  assert.match(prompt, new RegExp(shell.chainsWithAnd ? /&&/ : /;/), "the chaining example must match the probe");
});

test("the release is a fact about the machine, not a stringified object", () => {
  // `process.release` is a string on Linux and macOS and an *object* on
  // Windows. Rendering it without looking produced "win32 ([object Object])"
  // — a visibly wrong fact inside the one block whose entire value is that it
  // contains no wrong facts. Found by printing the block on a real machine,
  // which is the only way this class of bug shows up.
  const block = formatEnvironment(detectEnvironment(scratch()));
  assert.ok(!/\[object Object\]/.test(block), `the block stringified an object: ${block}`);
  const os = /operating system: (.+)/.exec(block)?.[1] ?? "";
  assert.ok(os.length > 0 && !os.includes("object"), `unusable OS line: ${os}`);
});
