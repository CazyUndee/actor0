import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ToolCall } from "@actor0/harness";
import { spawnSync } from "node:child_process";
import { createToolHost, resolveShell, shellNotes, toolLabel } from "./tools.js";
import { defaultSystemPrompt } from "./turn.js";

/**
 * The four tools, and the containment that replaced the approval gate.
 *
 * The gate is gone, so these tests have to carry the weight it used to. The
 * interesting cases are no longer "did it ask" but "what happens when a model
 * asks for something it should not have": paths that climb out of the working
 * directory, an edit whose target text is missing or ambiguous, a command that
 * runs forever, and output too large to read.
 */

const call = (name: string, args: unknown): ToolCall => ({
  id: "c1",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const scratch = (): string => mkdtempSync(join(tmpdir(), "actor0-tools-"));
const signal = new AbortController().signal;
const host = (cwd: string) => createToolHost({ cwd });

// --- the gate is gone -------------------------------------------------------

test("no approval callback exists on the host", () => {
  const created = createToolHost({ cwd: scratch() });
  assert.deepEqual(Object.keys(created).sort(), ["definitions", "execute"]);
  assert.equal("approval" in created, false);
});

test("an approval callback, if one is passed anyway, is never consulted", async () => {
  const dir = scratch();
  let consulted = false;
  // Cast: `approval` is not part of the options type, which is the point.
  const gated = createToolHost({
    cwd: dir,
    approval: {
      request: async () => {
        consulted = true;
        return false;
      },
    },
  } as never);

  await gated.execute(call("write", { path: "out.txt", content: "data" }), signal);
  assert.equal(consulted, false, "a write must not depend on anybody's consent");
  assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "data");
});

test("the four tools are advertised, and nothing else", () => {
  const names = createToolHost({ cwd: scratch() })
    .definitions()
    .map((d) => d.function.name);
  assert.deepEqual(names.sort(), ["edit", "read", "shell", "write"]);
  for (const definition of createToolHost({ cwd: scratch() }).definitions()) {
    assert.equal(definition.type, "function");
    assert.ok(definition.function.description.length > 10, `${definition.function.name} needs a real description`);
    assert.equal(definition.function.parameters.type, "object");
  }
});

test("every tool verb in the prompt is a real tool", () => {
  // A tool named in the system prompt but absent from the host is a prompt lie.
  for (const name of ["read", "write", "edit", "shell"]) {
    assert.ok(host(scratch()).definitions().some((d) => d.function.name === name), `missing ${name}`);
  }
});

// --- read -------------------------------------------------------------------

test("read returns the file contents unmodified when they fit", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "note.txt"), "hello world");
  assert.equal(await host(dir).execute(call("read", { path: "note.txt" }), signal), "hello world");
});

test("read pages and names the exact offset to resume at", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "lines.txt"), "a\nb\nc\nd\ne");
  const out = await host(dir).execute(call("read", { path: "lines.txt", offset: 2, limit: 2 }), signal);
  assert.match(out, /^2\tb\n3\tc/, "lines carry their file line numbers");
  assert.match(out, /Use offset=4 to continue/, "the next offset must be spelled out, not computed");
});

test("a limit that stops short still tells the model where the file continues", async () => {
  // pi's contract: a user-limited read is not silently truncated either. A
  // model that asked for 3 lines of 500 does not know to ask for more unless
  // the result says there are more.
  const dir = scratch();
  writeFileSync(join(dir, "lines.txt"), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"));
  const out = await host(dir).execute(call("read", { path: "lines.txt", limit: 3 }), signal);
  assert.match(out, /Use offset=4 to continue/);
  assert.match(out, /more lines in file/);
});

test("read pages a big file all the way through without repeating lines", async () => {
  const dir = scratch();
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(dir, "big.txt"), lines.join("\n"));
  // 5-byte lines: the 50KB byte cap would never bite, so force the paging
  // path with a tiny limit and walk it.
  let offset: number | undefined;
  let seen: string[] = [];
  for (let pages = 0; pages < 25; pages++) {
    const out = await host(dir).execute(call("read", { path: "big.txt", ...(offset ? { offset } : {}), limit: 4 }), signal);
    seen = seen.concat(out.split("\n").filter((l) => /^\d+\t/.test(l)));
    const m = /Use offset=(\d+) to continue/.exec(out);
    if (!m) break;
    offset = Number(m[1]);
  }
  assert.equal(seen.length, 50, "every line must be reachable through the named offsets");
  assert.equal(new Set(seen).size, 50, "no line may repeat across pages");
});

test("an offset past the end is an error that says how many lines there are", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "short.txt"), "one\ntwo");
  await assert.rejects(
    () => host(dir).execute(call("read", { path: "short.txt", offset: 99 }), signal),
    /offset 99 is past the end.*2 lines total/s,
  );
});

test("read points at bash for a directory instead of dumping one", async () => {
  const dir = scratch();
  mkdirSync(join(dir, "sub"));
  await assert.rejects(() => host(dir).execute(call("read", { path: "sub" }), signal), /is a directory/);
});

test("a missing file throws so the harness can account for it", async () => {
  await assert.rejects(() => host(scratch()).execute(call("read", { path: "missing.txt" }), signal), /ENOENT/);
});

// --- write ------------------------------------------------------------------

test("write creates parent directories and says it created", async () => {
  const dir = scratch();
  const out = await host(dir).execute(call("write", { path: "deep/nested/file.txt", content: "x" }), signal);
  assert.match(out, /^Created /);
  assert.equal(readFileSync(join(dir, "deep", "nested", "file.txt"), "utf8"), "x");
});

test("write says replaced when it clobbered something", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.txt"), "old");
  const out = await host(dir).execute(call("write", { path: "a.txt", content: "new" }), signal);
  assert.match(out, /^Replaced /);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "new");
});

test("write needs both a path and content", async () => {
  await assert.rejects(
    () => host(scratch()).execute(call("write", { path: "a.txt" }), signal),
    /missing required string parameter "content"/,
  );
});

test("write can create an empty file, and says it made zero lines", async () => {
  // Empty content is a real edit — it truncates a file — and rejecting it as a
  // *missing parameter* sent the model off to rebuild the file line by line.
  const dir = scratch();
  writeFileSync(join(dir, "f.txt"), "was here");
  const out = await host(dir).execute(call("write", { path: "f.txt", content: "" }), signal);
  assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "");
  assert.match(out, /0 lines/, `"".split("\\n") is one empty line; the model emptied the file`);
});

test("content that is absent is still an error, distinct from content that is empty", async () => {
  const dir = scratch();
  await assert.rejects(
    () => host(dir).execute(call("write", { path: "f.txt" }), signal),
    /missing required string parameter "content"/,
  );
});

// --- edit -------------------------------------------------------------------

test("edit replaces one exact string and leaves the rest alone", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\n");
  const out = await host(dir).execute(
    call("edit", { path: "a.ts", old_string: "const b = 2;", new_string: "const b = 3;" }),
    signal,
  );
  assert.match(out, /^Edited /);
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "const a = 1;\nconst b = 3;\n");
});

test("edit fails loudly when the text is not there", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  await assert.rejects(
    () => host(dir).execute(call("edit", { path: "a.ts", old_string: "nope", new_string: "x" }), signal),
    /old_string not found/,
  );
  // And it must not have touched the file on the way to failing.
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "const a = 1;\n");
});

test("edit refuses an ambiguous match rather than guessing which one", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.ts"), "x();\nx();\n");
  await assert.rejects(
    () => host(dir).execute(call("edit", { path: "a.ts", old_string: "x();", new_string: "y();" }), signal),
    /appears 2 times/,
  );
});

test("edit deletes text when the replacement is empty", async () => {
  // The most common edit there is, and it used to be impossible: `new_string`
  // was checked for non-emptiness, so a model that wanted a block gone had to
  // fall back to rewriting the whole file by hand.
  const dir = scratch();
  writeFileSync(join(dir, "f.txt"), "keep\nremove me\nalso keep\n");
  const out = await host(dir).execute(call("edit", { path: "f.txt", old_string: "remove me\n", new_string: "" }), signal);
  assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "keep\nalso keep\n");
  assert.match(out, /1 occurrence replaced/);
});

test("replace_all with an empty replacement removes every occurrence", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "f.txt"), "x y x y x");
  await host(dir).execute(
    call("edit", { path: "f.txt", old_string: "x ", new_string: "", replace_all: true }),
    signal,
  );
  assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "y y x");
});

test("an edit can empty a file completely", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "f.txt"), "everything\ngone\n");
  await host(dir).execute(
    call("edit", { path: "f.txt", old_string: "everything\ngone\n", new_string: "" }),
    signal,
  );
  assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "");
});

test("an absent old_string is still rejected — only the replacement may be empty", async () => {
  // The other half of the rule. An empty needle would match between every
  // character, so it has to stay an error.
  const dir = scratch();
  writeFileSync(join(dir, "f.txt"), "abc");
  await assert.rejects(
    () => host(dir).execute(call("edit", { path: "f.txt", old_string: "", new_string: "x" }), signal),
    /missing required string parameter "old_string"/,
  );
});

test("replace_all is the way to say you meant all of them", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.ts"), "x();\nx();\n");
  await host(dir).execute(
    call("edit", { path: "a.ts", old_string: "x();", new_string: "y();", replace_all: true }),
    signal,
  );
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "y();\ny();\n");
});

// --- shell ------------------------------------------------------------------

/**
 * A command that means the same thing in whichever shell this machine resolved to.
 *
 * Everything below is testing the *tool's* contract — stdout, stderr, exit
 * codes, caps, timeouts — and none of that is about shell syntax. Writing the
 * fixtures in POSIX meant they only ran where bash happened to be available,
 * which is the same assumption that produced the bug this change fixes: the
 * suite passed on the developer's machine and failed on the user's.
 */
const script = (posix: string, powershell: string, cmd: string): string => {
  const family = resolveShell().family;
  return family === "posix" ? posix : family === "powershell" ? powershell : cmd;
};

/** Something that takes the requested time, in every shell. */
const hang = script("sleep 30", "Start-Sleep -Seconds 30", "ping -n 31 127.0.0.1 > nul");

test("shell returns stdout, and the exit code on the last line when non-zero", async () => {
  const out = await host(scratch()).execute(
    call("shell", { command: script("echo hi; exit 3", "Write-Output hi; exit 3", "echo hi & exit /b 3") }),
    signal,
  );
  assert.match(out, /\bhi\b/);
  assert.match(out, /Command exited with code 3$/, "the code rides last, next to where the model decides");
});

test("shell reports a non-zero exit in the result, not as a rejection", async () => {
  // The model needs to see and reason about a failure, not have the turn abort.
  const out = await host(scratch()).execute(
    call("shell", { command: script("echo before; exit 1", "Write-Output before; exit 1", "echo before & exit /b 1") }),
    signal,
  );
  assert.match(out, /Command exited with code 1/);
  assert.match(out, /before/, "the output the command did produce must still arrive");
});

test("shell keeps the tail of oversized output, where the error is", async () => {
  // A head cap shows the model the start of a build log and drops the 'ERR!'
  // it was looking for. The cap must keep the end.
  const out = await host(scratch()).execute(
    call("shell", {
      command: script(
        "echo START_MARKER; yes 0123456789012345678901234567890123456789 | head -4000; echo END_MARKER",
        "Write-Output START_MARKER; 1..4000 | ForEach-Object { '0123456789012345678901234567890123456789' }; Write-Output END_MARKER",
        "echo START_MARKER & for /L %i in (1,1,4000) do @echo 0123456789012345678901234567890123456789 & echo END_MARKER",
      ),
    }),
    signal,
  );
  assert.match(out, /truncated/);
  assert.doesNotMatch(out, /START_MARKER/, "the head is what gets dropped");
  assert.match(out, /END_MARKER/, "the tail — the part that says what happened — must survive");
});

test("shell separates stderr so a real error is not lost in the noise", async () => {
  const out = await host(scratch()).execute(
    call("shell", { command: script("echo oops 1>&2", "[Console]::Error.WriteLine('oops')", "echo oops 1>&2") }),
    signal,
  );
  assert.match(out, /stderr:/);
  assert.match(out, /oops/);
});

test("shell says so when a command prints nothing", async () => {
  const out = await host(scratch()).execute(
    call("shell", { command: script("true", "$null = 1", "exit /b 0") }),
    signal,
  );
  assert.equal(out, "(no output)", "no exit-code line on success — it is noise");
});

test("shell runs in the working directory", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "marker.txt"), "");
  const out = await host(dir).execute(
    call("shell", { command: script("ls", "Get-ChildItem | Select-Object -ExpandProperty Name", "dir /b") }),
    signal,
  );
  assert.match(out, /marker\.txt/);
});

test("shell is killed at its timeout and says so", async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      host(scratch()).execute(
        call("shell", {
          command: script(
            "echo partial-before-hang; sleep 30",
            "Write-Output partial-before-hang; Start-Sleep -Seconds 30",
            "echo partial-before-hang & ping -n 31 127.0.0.1 > nul",
          ),
          timeout: 1,
        }),
        signal,
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("timed out after 1 second") && message.includes("partial-before-hang");
    },
    "a killed command must hand back the output it did produce",
  );
  assert.ok(Date.now() - started < 15_000, "must not have waited for the command");
});

test("shell has no default timeout — a long command finishes", async () => {
  // pi's contract: no timeout unless asked. A 120s default killed real installs
  // and builds mid-flight; nothing the model does routinely should die by clock.
  const out = await host(scratch()).execute(
    call("shell", {
      command: script(
        "sleep 2; echo done-slowly",
        "Start-Sleep -Seconds 2; Write-Output done-slowly",
        "ping -n 3 127.0.0.1 > nul & echo done-slowly",
      ),
    }),
    signal,
  );
  assert.match(out, /done-slowly/);
});

test("a nonsense timeout is rejected rather than clamped into a surprise", async () => {
  await assert.rejects(
    () => host(scratch()).execute(call("shell", { command: "echo x", timeout: 0 }), signal),
    /invalid timeout/,
  );
  await assert.rejects(
    () => host(scratch()).execute(call("shell", { command: "echo x", timeout: 999_999 }), signal),
    /max is 3600 seconds/,
  );
});

test("an aborted turn kills the command", async () => {
  const controller = new AbortController();
  const pending = host(scratch()).execute(call("shell", { command: hang }), controller.signal);
  setTimeout(() => controller.abort(), 250);
  await assert.rejects(() => pending, /cancelled/);
});

test("a command missing a body is a clear error, not a shell surprise", async () => {
  await assert.rejects(
    () => host(scratch()).execute(call("shell", {}), signal),
    /missing required string parameter "command"/,
  );
});

// --- edit: line endings and BOM -------------------------------------------

test("edit matches LF old_string against a CRLF file, and keeps the file CRLF", async () => {
  // The machine is Windows; most files are CRLF; the model quotes what it read
  // as LF. A byte-exact matcher fails every such edit, and the failure reads
  // to the model as 'the file changed underneath me'.
  const dir = scratch();
  writeFileSync(join(dir, "win.ts"), "const a = 1;\r\nconst b = 2;\r\n");
  await host(dir).execute(
    call("edit", { path: "win.ts", old_string: "const b = 2;", new_string: "const b = 3;" }),
    signal,
  );
  const after = readFileSync(join(dir, "win.ts"), "utf8");
  assert.match(after, /const b = 3;/);
  assert.match(after, /\r\n/, "the file's own line endings must survive the edit");
});

test("edit strips a UTF-8 BOM for matching and restores it on write", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "bom.ts"), "\uFEFFconst a = 1;\n");
  await host(dir).execute(
    call("edit", { path: "bom.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
    signal,
  );
  const after = readFileSync(join(dir, "bom.ts"), "utf8");
  assert.match(after, /^\uFEFF/);
  assert.match(after, /const a = 2;/);
});

test("edit applies to normalized text, so a multi-line LF match works on CRLF", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "multi.ts"), "function f() {\r\n  return 1;\r\n}\r\n");
  await host(dir).execute(
    call("edit", { path: "multi.ts", old_string: "function f() {\n  return 1;\n}", new_string: "function f() {\n  return 2;\n}" }),
    signal,
  );
  const after = readFileSync(join(dir, "multi.ts"), "utf8");
  assert.match(after, /return 2;/);
  assert.equal((after.match(/\r\n/g) ?? []).length, 3, "all three original CRLFs restored");
});

// --- containment ------------------------------------------------------------

test("no tool can reach outside the working directory", async () => {
  const outer = scratch();
  const inner = join(outer, "project");
  mkdirSync(inner);
  writeFileSync(join(outer, "secret.txt"), "hunter2");
  const escape = relative(inner, join(outer, "secret.txt"));
  const attack = host(inner);

  await assert.rejects(
    () => attack.execute(call("read", { path: escape }), signal),
    /outside the working directory/,
  );
  await assert.rejects(
    () => attack.execute(call("write", { path: `..${sep}secret.txt`, content: "clobbered" }), signal),
    /outside the working directory/,
  );
  await assert.rejects(
    () => attack.execute(call("edit", { path: `..${sep}secret.txt`, old_string: "hunter2", new_string: "x" }), signal),
    /outside the working directory/,
  );
  // The file that was the target is untouched.
  assert.equal(readFileSync(join(outer, "secret.txt"), "utf8"), "hunter2");
});

test("a sibling directory sharing a name prefix is still outside", async () => {
  // `..` plus a prefix is the classic way a naive startsWith check lets you out.
  const outer = scratch();
  const inner = join(outer, "app");
  const sibling = join(outer, "app-backup");
  mkdirSync(inner);
  mkdirSync(sibling);
  writeFileSync(join(sibling, "notes.txt"), "private");
  await assert.rejects(
    () => host(inner).execute(call("read", { path: `..${sep}app-backup${sep}notes.txt` }), signal),
    /outside the working directory/,
  );
});

test("a link inside the working directory does not become a way out", async () => {
  // The lexical check is satisfied by any path that *reads* as inside the
  // root, and a link reads as inside while living anywhere. With no approval
  // gate, this was the difference between a contained agent and one that could
  // read and write the whole disk through a link it happened to find.
  const outer = scratch();
  const inner = join(outer, "project");
  const elsewhere = join(outer, "elsewhere");
  mkdirSync(inner);
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "secret.txt"), "hunter2");
  const link = join(inner, "link");
  try {
    // "junction" is the only kind Windows will make without elevation; on
    // POSIX it is ignored and a directory symlink is made.
    symlinkSync(elsewhere, link, "junction");
  } catch {
    return; // No link permission here; the lexical tests above still hold.
  }
  const attack = host(inner);
  const through = join("link", "secret.txt");

  await assert.rejects(
    () => attack.execute(call("read", { path: through }), signal),
    /outside the working directory/,
    "a read through a link is still a read from outside",
  );
  await assert.rejects(
    () => attack.execute(call("write", { path: join("link", "planted.txt"), content: "x" }), signal),
    /outside the working directory/,
  );
  await assert.rejects(
    () => attack.execute(call("edit", { path: through, old_string: "hunter2", new_string: "x" }), signal),
    /outside the working directory/,
  );
  assert.equal(readFileSync(join(elsewhere, "secret.txt"), "utf8"), "hunter2", "the target is untouched");
  assert.equal(existsSync(join(elsewhere, "planted.txt")), false, "nothing was planted outside");
});

test("a link to a directory *inside* the working directory is still allowed", async () => {
  // Containment that refuses its own tree is worse than none: `node_modules`
  // and `.git` are full of links, and a model that cannot follow one will
  // report the project as broken.
  const dir = scratch();
  const real = join(dir, "real");
  mkdirSync(real);
  writeFileSync(join(real, "f.txt"), "ok");
  try {
    symlinkSync(real, join(dir, "link"), "junction");
  } catch {
    return;
  }
  assert.equal(await host(dir).execute(call("read", { path: join("link", "f.txt") }), signal), "ok");
});

test("write creates a file whose parent directories do not exist yet", async () => {
  // The containment resolves the deepest *existing* ancestor, precisely
  // because the target of a write usually does not exist. If that walk were
  // wrong, this — the most ordinary write there is — would throw.
  const dir = scratch();
  await host(dir).execute(call("write", { path: "a/b/c/deep.txt", content: "hi" }), signal);
  assert.equal(readFileSync(join(dir, "a", "b", "c", "deep.txt"), "utf8"), "hi");
});

test("paths inside the working directory are fine, however they are spelled", async () => {
  const dir = scratch();
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "a", "b", "f.txt"), "ok");
  assert.equal(await host(dir).execute(call("read", { path: "./a/b/f.txt" }), signal), "ok");
  assert.equal(await host(dir).execute(call("read", { path: join(dir, "a", "b", "f.txt") }), signal), "ok");
});

// --- the tool host itself ---------------------------------------------------

test("an unknown tool throws and lists what is available", async () => {
  await assert.rejects(() => host(scratch()).execute(call("rm_rf", {}), signal), /unknown tool "rm_rf"/);
  await assert.rejects(() => host(scratch()).execute(call("rm_rf", {}), signal), /read, write, edit, shell/);
});

test("malformed arguments throw rather than being silently ignored", async () => {
  const bad: ToolCall = { id: "c", type: "function", function: { name: "read", arguments: "{nope" } };
  await assert.rejects(() => host(scratch()).execute(bad, signal), /invalid arguments/);
});

test("a non-object argument payload is rejected", async () => {
  await assert.rejects(() => host(scratch()).execute(call("read", "[]"), signal), /arguments must be a JSON object/);
});

test("nothing runs once the turn has been cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const dir = scratch();
  await assert.rejects(
    () => host(dir).execute(call("write", { path: "late.txt", content: "x" }), controller.signal),
    /cancelled before the tool ran/,
  );
  assert.equal(existsSync(join(dir, "late.txt")), false);
});

test("the activity line shows a short verb and something the user can read", () => {
  assert.equal(toolLabel("read"), "read");
  assert.equal(toolLabel("write"), "write");
  assert.equal(toolLabel("edit"), "edit");
  assert.equal(toolLabel("shell"), "$");
  assert.equal(toolLabel("something-new"), "something-new");
});

test("the resolved shell can actually run a command", () => {
  // Not "the file exists" — `bash` *exists* on Windows and is still the wrong
  // answer, because it is the WSL launcher. Only running something catches it.
  const shell = resolveShell();
  const probe = spawnSync(shell.command, [...shell.prefixArgs, "echo actor0-marker"], { encoding: "utf8" });
  const said = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  assert.equal(probe.status, 0, `${shell.command} could not run a command: ${said}`);
  assert.match(probe.stdout ?? "", /actor0-marker/, `${shell.command} produced no output`);
  assert.doesNotMatch(said, /WSL|CreateProcessCommon|execvpe/, `${shell.command} is a launcher, not a shell`);
});

test("the note about chaining matches what this shell can actually do", () => {
  // `&&` is not constant even inside one family: PowerShell 7 has it and
  // Windows PowerShell 5.1 — still the `powershell.exe` on most machines —
  // rejects the whole line as a syntax error. Telling the model to chain with
  // `&&` there hands it a command that produces no output and a non-zero exit,
  // which reads to it as the tool being broken.
  const shell = resolveShell();
  const note = shellNotes(shell);
  const run = spawnSync(shell.command, [...shell.prefixArgs, "echo ACTOR0_A && echo ACTOR0_B"], {
    encoding: "utf8",
  });
  const actuallyChains = run.status === 0 && /ACTOR0_B/.test(run.stdout ?? "");
  assert.equal(
    shell.chainsWithAnd,
    actuallyChains,
    `${shell.command} chainsWithAnd disagrees with what it just did`,
  );
  if (shell.family === "powershell") {
    assert.match(
      note,
      shell.chainsWithAnd ? /Chain commands with `&&`/ : /syntax error/,
      "the PowerShell note must match the version the model is actually on",
    );
    if (!shell.chainsWithAnd) {
      assert.doesNotMatch(note, /chain with `&&`/i, "it must not recommend the operator it cannot run");
    }
  }
});

test("the cmd.exe note does not claim a feature cmd does not have", () => {
  // It used to say cmd has no `&&`. It has no *pipelines*; `&&` chains fine,
  // and telling a model otherwise makes it write `&`-joined one-liners that
  // swallow a failure.
  const cmd = shellNotes({
    command: "cmd.exe",
    name: "cmd.exe",
    family: "cmd",
    prefixArgs: ["/d", "/s", "/c"],
    chainsWithAnd: true,
  });
  assert.match(cmd, /no pipelines/i);
  assert.doesNotMatch(cmd, /no `&&`/, "cmd.exe does support &&");
  assert.match(cmd, /`&&`/, "and the note should say so");
});

test("every shell note stays true about && for the version it describes", () => {
  const base = { command: "powershell.exe", name: "Windows PowerShell", prefixArgs: ["-NoProfile"] };
  const five = shellNotes({ ...base, family: "powershell", chainsWithAnd: false });
  const seven = shellNotes({ ...base, family: "powershell", chainsWithAnd: true });
  assert.notEqual(five, seven, "the two PowerShell versions must not get the same note");
  assert.match(five, /is a syntax error/);
  assert.match(seven, /Chain commands with `&&`/);
});

test("the tool is named shell, and says which shell it is", () => {
  const names = createToolHost({ cwd: scratch() })
    .definitions()
    .map((d) => d.function.name);
  assert.ok(names.includes("shell"), `no shell tool among ${names.join(", ")}`);
  assert.equal(names.includes("bash"), false, "a tool called bash is a claim about the machine");

  const definition = createToolHost({ cwd: scratch() })
    .definitions()
    .find((d) => d.function.name === "shell")!;
  assert.match(
    definition.function.description,
    new RegExp(resolveShell().name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the description does not name the shell the tool will actually run",
  );
});

test("the tool description tells the model what this shell is not", () => {
  const definition = createToolHost({ cwd: scratch() })
    .definitions()
    .find((d) => d.function.name === "shell")!;
  const family = resolveShell().family;
  if (family === "posix") {
    assert.match(definition.function.description, /POSIX/i);
  } else if (family === "powershell") {
    // The whole point: a model told "bash" will run `find` here.
    assert.match(definition.function.description, /PowerShell/);
    assert.match(definition.function.description, /does NOT exist/i);
  } else {
    assert.match(definition.function.description, /cmd\.exe/);
  }
});

test("the default prompt names the shell tool, not bash", () => {
  const prompt = defaultSystemPrompt();
  assert.match(prompt, /`shell`/);
  assert.doesNotMatch(prompt, /\bwith bash\b/, "the prompt still asserts this is bash");
  assert.doesNotMatch(prompt, /`bash`/, "the prompt still names a bash tool");
});

test("shell advertises itself as a shell command, not a file tool", () => {
  const definition = createToolHost({ cwd: scratch() })
    .definitions()
    .find((d) => d.function.name === "shell");
  assert.ok(definition, "the shell tool must be offered");
  assert.match(definition.function.description, /shell/i);
  const required = definition.function.parameters.required;
  assert.ok(Array.isArray(required) && required.includes("command"), "command is the only thing the shell needs");
  assert.equal(toolLabel("shell"), "$", "a command has no path to show, so the verb carries it");
});
