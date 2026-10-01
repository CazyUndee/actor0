import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ToolCall } from "@actor0/harness";
import { spawnSync } from "node:child_process";
import { createToolHost, exitedNonZero, resolveShell, shellNotes, toolLabel } from "./tools.js";
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

test("the six tools are advertised, and nothing else", () => {
  const names = createToolHost({ cwd: scratch() })
    .definitions()
    .map((d) => d.function.name);
  assert.deepEqual(names.sort(), ["edit", "glob", "grep", "read", "shell", "write"]);
  for (const definition of createToolHost({ cwd: scratch() }).definitions()) {
    assert.equal(definition.type, "function");
    assert.ok(definition.function.description.length > 10, `${definition.function.name} needs a real description`);
    assert.equal(definition.function.parameters.type, "object");
  }
});

test("every tool verb in the prompt is a real tool", () => {
  // A tool named in the system prompt but absent from the host is a prompt lie.
  for (const name of ["read", "write", "edit", "grep", "glob", "shell"]) {
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

test("a single enormous line is cut, and the cut is reported", async () => {
  // The byte cap bounds the file, not the line. A minified bundle, a lockfile
  // entry, one base64 blob or one CSV row passes 50KB as a single 160,000-
  // character line, and the model cannot read it, navigate it, or safely quote
  // it back into a write. Claude Code puts the same 500-column cap on ripgrep.
  const dir = scratch();
  writeFileSync(join(dir, "bundle.js"), "var a=1;".repeat(20_000));
  const out = await host(dir).execute(call("read", { path: "bundle.js" }), signal);
  assert.ok(out.length < 1_000, `a 160,000-character line came back as ${out.length} characters`);
  assert.match(out, /\[cut: \+159500 chars\]/, "the marker says how much is missing, not just that something was");
});

test("a cut line is never cut silently", async () => {
  // The failure this guards is an edit, not an overflow: a line cut without a
  // marker reads as the whole line, and the model edits as though the rest of
  // it does not exist.
  const dir = scratch();
  writeFileSync(join(dir, "long.txt"), `${"x".repeat(900)}\nshort\n`);
  const out = await host(dir).execute(call("read", { path: "long.txt" }), signal);
  assert.match(out, /\[1 line longer than 500 characters was cut above\./);
  assert.match(out, /sed -n '1p' long\.txt/, "a count alone is not actionable — the note has to name the line");
  assert.match(out, /short\n/, "the rest of the file comes back untouched");
});

test("the cut notice names every long line, not just the first", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "two.txt"), `${"x".repeat(900)}\n${"y".repeat(700)}\nshort\n`);
  const out = await host(dir).execute(call("read", { path: "two.txt" }), signal);
  assert.match(out, /\[2 lines longer than 500 characters \(lines 1, 2\) were cut above\./);
});

test("a file whose lines all fit comes back byte for byte", async () => {
  // The cap must not touch anything. The unpaged path returns `raw` untouched
  // when nothing was cut, trailing newline included — the description used to
  // promise "verbatim", and it is still true for every ordinary file.
  const dir = scratch();
  const body = "hello world\nsecond line\n";
  writeFileSync(join(dir, "note.txt"), body);
  assert.equal(await host(dir).execute(call("read", { path: "note.txt" }), signal), body);
});

test("a cut is reported on the paged path too, with the file's line numbers", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "mixed.txt"), ["short", "x".repeat(900), "short"].join("\n"));
  const out = await host(dir).execute(call("read", { path: "mixed.txt", offset: 1, limit: 3 }), signal);
  assert.match(out, /^1\tshort\n2\tx{500}/, "the marker lands inside the line, after its number");
  assert.match(
    out,
    /was cut above\. To read it whole, use the shell tool: sed -n '2p' mixed\.txt/,
    "the number is the line in the file, not the page's offset into it",
  );
  assert.match(out, /\[End of file: 3 lines\.\]/, "both notes survive: the paging one and the cut one");
});

test("a line exactly at the cap is left alone", async () => {
  const dir = scratch();
  const line = "x".repeat(500);
  writeFileSync(join(dir, "edge.txt"), `${line}\n`);
  const out = await host(dir).execute(call("read", { path: "edge.txt" }), signal);
  assert.equal(out, `${line}\n`, "500 columns fits; only what is past them is cut");
});
test("a binary file is refused before it is decoded", async () => {
  // Measured on the real tool: a 75-byte PNG came back as
  // "�PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR..." — 74 characters of mojibake that
  // look like a corrupted file rather than a picture, and cost a round to
  // discover. Claude Code refuses binaries for the same reason, by extension;
  // the NUL test needs no list to rot and catches an extensionless one.
  const dir = scratch();
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
      "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd4" +
      "0000000049454e44ae426082",
    "hex",
  );
  writeFileSync(join(dir, "shot.png"), png);
  await assert.rejects(
    () => host(dir).execute(call("read", { path: "shot.png" }), signal),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /shot\.png is not text/);
      assert.match(message, /NUL byte at offset 8/, "the offset is named so the model can look");
      assert.match(message, /Use the shell tool instead/, "a refusal with no way forward is just a wall");
      return true;
    },
  );
});

test("a UTF-16 file is refused rather than returned with a NUL between every letter", async () => {
  // The case the NUL test earns its keep on. `h\0e\0l\0l\0o\0` looks like text
  // to a model, so it is read as if it were — and it is not a corrupted file,
  // it is a perfectly good file in an encoding this tool does not return.
  const dir = scratch();
  writeFileSync(join(dir, "wide.txt"), Buffer.from("hello world\n", "utf16le"));
  await assert.rejects(
    () => host(dir).execute(call("read", { path: "wide.txt" }), signal),
    (error: unknown) => {
      assert.match((error as Error).message, /can also mean the file is UTF-16/);
      assert.match((error as Error).message, /iconv/, "the message names the conversion that would work");
      return true;
    },
  );
});

test("an empty file says so instead of returning nothing", async () => {
  // An empty tool result is a fact the model cannot use: it is the same
  // signal as a read that produced no output, so the model either retries or
  // invents contents. This mirrors the shell tool's `(no output)`.
  const dir = scratch();
  writeFileSync(join(dir, "empty.txt"), "");
  assert.equal(await host(dir).execute(call("read", { path: "empty.txt" }), signal), "(the file is empty: 0 bytes)");
});

test("an ordinary file is untouched by the sniff", async () => {
  // The check reads the first 8KB and nothing else, so a file with no NUL in
  // its head has to come back exactly as it was — including one comfortably
  // longer than the sniff window, and comfortably inside the paging caps so
  // this is about the sniff and not about line numbers appearing.
  const dir = scratch();
  const body = `${"line of text\n".repeat(1_000)}tail\n`;
  assert.ok(Buffer.byteLength(body) > 8_000, "the file has to outlast the sniff window to mean anything");
  writeFileSync(join(dir, "long.txt"), body);
  assert.equal(await host(dir).execute(call("read", { path: "long.txt" }), signal), body);
});


test("a paged read reports the file's line count, not the window's", async () => {
  // `limit` says how much the model wants, not how much the file has. The
  // note used to end "of <window end>", so asking for 2500 lines of a
  // 3000-line file produced "Showing lines 1-2000 of 2500" — a file length
  // that is the reader's own doing, and one a model will go on to edit by.
  const dir = scratch();
  writeFileSync(
    join(dir, "big.txt"),
    Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  const out = await host(dir).execute(call("read", { path: "big.txt", limit: 2500 }), signal);
  assert.match(out, /Showing lines 1-2000 of 3000/);
  assert.doesNotMatch(out, /of 2500\b/, "the model's own limit must not become the file's length");
});

test("the page that reaches the end of the file says so", async () => {
  // The note that offers a next offset creates an obligation to answer it:
  // once the model has followed it to the end, something has to say the
  // paging is finished, or the last page reads like a page whose note went
  // missing and the model pages forever.
  const dir = scratch();
  writeFileSync(
    join(dir, "big.txt"),
    Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  let offset: number | undefined;
  let last = "";
  for (let pages = 0; pages < 10; pages++) {
    last = await host(dir).execute(
      call("read", { path: "big.txt", ...(offset ? { offset } : {}), limit: 2500 }),
      signal,
    );
    const m = /Use offset=(\d+) to continue/.exec(last);
    if (!m) break;
    offset = Number(m[1]);
  }
  assert.match(last, /\[End of file: 3000 lines\.\]/, "the final page must close the loop");
  assert.doesNotMatch(last, /Use offset=/, "and must not offer another page");
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

test("a $$ in the replacement lands as two dollars, not one", async () => {
  // `String.replace` reads a plain string replacement as its own
  // mini-language: $$ means "a literal dollar", so a model writing a
  // shell script's `echo $$` would have the file land as `echo $`
  // with no error anywhere. The replacement is data. Claude Code's
  // edit wraps its replacement in `() => replace` for the same
  // reason (applyEditToFile in FileEditTool/utils.ts).
  const dir = scratch();
  writeFileSync(join(dir, "s.sh"), "echo one\n");
  await host(dir).execute(
    call("edit", { path: "s.sh", old_string: "one", new_string: "$$" }),
    signal,
  );
  assert.equal(readFileSync(join(dir, "s.sh"), "utf8"), "echo $$\n");
});

test("$& in the replacement is not the matched text", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "re.ts"), "const a = 1;\nconst b = 2;\n");
  await host(dir).execute(
    call("edit", { path: "re.ts", old_string: "const b = 2;", new_string: "const b = $&;" }),
    signal,
  );
  assert.equal(readFileSync(join(dir, "re.ts"), "utf8"), "const a = 1;\nconst b = $&;\n");
});

test("$' in the replacement is not the text after the match", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "f.txt"), "a b c\n");
  await host(dir).execute(
    call("edit", { path: "f.txt", old_string: "b", new_string: "$'" }),
    signal,
  );
  assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "a $' c\n");
});

test("replace_all keeps a literal $$ too", async () => {
  // The split/join path was always literal; pinned so the two paths
  // cannot drift apart again.
  const dir = scratch();
  writeFileSync(join(dir, "s.sh"), "echo one one\n");
  await host(dir).execute(
    call("edit", { path: "s.sh", old_string: "one", new_string: "$$", replace_all: true }),
    signal,
  );
  assert.equal(readFileSync(join(dir, "s.sh"), "utf8"), "echo $$ $$\n");
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

test("a non-zero exit is readable back out of the result text", () => {
  // The row is drawn from this text, because a failing command has no other
  // channel: `shell` ran, captured the output and returned it, so the harness
  // sees a result and the row looks like a success.
  assert.equal(exitedNonZero("hi\n\nCommand exited with code 1"), true);
  assert.equal(exitedNonZero("hi\n\nCommand exited with code 127"), true);
  assert.equal(exitedNonZero("everything worked\n"), false);
  assert.equal(exitedNonZero("Command exited with code 0"), false, "zero is not a failure");
  assert.equal(
    exitedNonZero("hi\n\nCommand exited with code 1 and more"),
    false,
    "it has to be the last line, exactly",
  );
  assert.equal(
    exitedNonZero("grep said: Command exited with code 1"),
    false,
    "a command that printed the phrase has not exited non-zero",
  );
  // `unknown` is what a process killed by a signal reports, and it is not a
  // success: the command did not finish what it was asked to do.
  assert.equal(exitedNonZero("hi\n\nCommand exited with code unknown"), true);
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

test("the truncation notice counts what was actually thrown away", async () => {
  // The notice is there so the model knows it is looking at part of the
  // output. It used to be computed from the text that survived, which is
  // always only the text that survived: a 160KB log arrived at the notice as
  // the 34KB the accumulator kept, and it said "4,094 earlier bytes dropped"
  // when 130,000 had been. The model reads that as "the rest is here" and
  // answers from output it cannot see, which is worse than saying nothing.
  const out = await host(scratch()).execute(
    call("shell", {
      command: script(
        "yes 0123456789012345678901234567890123456789 | head -4000",
        "1..4000 | ForEach-Object { '0123456789012345678901234567890123456789' }",
        "for /L %i in (1,1,4000) do @echo 0123456789012345678901234567890123456789",
      ),
    }),
    signal,
  );
  const notice = /^\[output truncated: ([\d,]+) earlier bytes and ([\d,]+) lines dropped/.exec(out);
  assert.ok(notice, `no truncation notice in: ${out.slice(0, 120)}`);
  const bytes = Number(notice[1]!.replace(/,/g, ""));
  const lines = Number(notice[2]!.replace(/,/g, ""));
  // 4,000 lines of 41 bytes is about 160KB; the cap keeps 30,000 of it.
  assert.ok(bytes > 100_000, `claimed only ${bytes} bytes were dropped`);
  assert.ok(lines > 3_000, `claimed only ${lines} lines were dropped`);
});

test("output that fits is not announced as truncated", async () => {
  const out = await host(scratch()).execute(
    call("shell", { command: script("echo small", "Write-Output small", "echo small") }),
    signal,
  );
  assert.doesNotMatch(out, /truncated/);
  assert.match(out, /small/);
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
  // The timings here are the test's, and they are load-bearing.
  //
  // This asserts two things at once: that the kill happens, and that whatever
  // the command had already written is handed back. The second half needs the
  // command to have *run*, which at a one-second timeout it does not reliably
  // do: PowerShell is launched as a child here and takes the better part of a
  // second to start, and its stdout is block-buffered into a pipe, so on a
  // loaded machine the kill lands before a single byte is flushed and the
  // assertion fails for a reason that has nothing to do with the code. That
  // made this test fail about one run in three under the full suite and never
  // when its own file ran alone.
  //
  // So: a short warm-up before the hang, and a timeout wide enough for the
  // shell to have started and flushed. The kill is still proven by the
  // elapsed time, which has to be nowhere near the 30 seconds the command
  // asked to run for.
  const started = Date.now();
  await assert.rejects(
    () =>
      host(scratch()).execute(
        call("shell", {
          command: script(
            "echo partial-before-hang; sleep 30",
            "Start-Sleep -Milliseconds 250; Write-Output partial-before-hang; Start-Sleep -Seconds 30",
            "echo partial-before-hang & ping -n 31 127.0.0.1 > nul",
          ),
          timeout: 3,
        }),
        signal,
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("timed out after 3 seconds") && message.includes("partial-before-hang");
    },
    "a killed command must hand back the output it did produce",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `waited ${elapsed}ms for a 30s command`);
  assert.ok(elapsed >= 2_000, `the command was killed after ${elapsed}ms, before it could produce anything`);
});

test("a command that reads stdin is told there is none", async () => {
  // A command that reads input has to be told there is none, or it waits for
  // input that is never coming. The default stdin is a pipe, and a pipe nobody
  // closes never reaches EOF: with no default timeout on this tool that wait
  // is an hour, ended only by the user noticing. So a timeout is set here, and
  // it has to be the hang-breaker only — nothing else.
  //
  // It used to be five seconds, matching the bound the assertion checked, and
  // that is a race with the machine rather than with the code: the tool's
  // timer and the assertion's were the same five seconds, so whenever the
  // suite ran under load the tool killed the command first and the rejection
  // escaped the test. It failed once in a full green run and passed the next,
  // which is the worst of both. The breaker's job is to end a hang, so it
  // sits an order of magnitude above the assertion: a regression waits half
  // a minute and fails, and the fast path still finishes in milliseconds.
  const started = Date.now();
  const out = await host(scratch()).execute(
    call("shell", {
      command: script("cat", "cmd /c more", "cmd /c more"),
      timeout: 30,
    }),
    signal,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `waited ${elapsed}ms for input that never came`);
  assert.match(out, /no output|exited with code/);
});

test("redirecting stdin still works — closing the pipe is not the same as refusing it", async () => {
  // The pipe this closes is the child's own; a redirection is the shell
  // opening a file, and must be unaffected.
  const dir = scratch();
  writeFileSync(join(dir, "data.txt"), "piped-in\n");
  const out = await host(dir).execute(
    call("shell", {
      command: script("cat data.txt", "Get-Content data.txt", "type data.txt"),
    }),
    signal,
  );
  assert.match(out, /piped-in/);
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

test("a directory whose name starts with two dots is still inside", async () => {
  // `rel.startsWith("..")` is a prefix test on a path, and paths are not
  // prefixes. `..cache` and `...data` are ordinary directory names, and every
  // tool refused to read or write inside one — which is how a containment
  // check that is only ever tested against escapes ends up refusing the work
  // it exists to permit.
  const dir = scratch();
  mkdirSync(join(dir, "..cache"), { recursive: true });
  mkdirSync(join(dir, "...data"), { recursive: true });
  writeFileSync(join(dir, "..cache", "a.txt"), "dotted");
  writeFileSync(join(dir, "...data", "b.txt"), "tripled");

  const out = await host(dir).execute(call("read", { path: join("..cache", "a.txt") }), signal);
  assert.match(out, /dotted/);
  assert.match(await host(dir).execute(call("read", { path: "...data/b.txt" }), signal), /tripled/);

  // A write through the same name is equally inside.
  await host(dir).execute(call("write", { path: join("..cache", "new.txt"), content: "written" }), signal);
  assert.equal(readFileSync(join(dir, "..cache", "new.txt"), "utf8"), "written");

  // And the escape in the neighbouring directory is still an escape.
  const outside = scratch();
  writeFileSync(join(outside, "secret.txt"), "hunter2");
  await assert.rejects(
    () => host(dir).execute(call("read", { path: join("..", "..", relative(dir, outside), "secret.txt") }), signal),
    /outside the working directory/,
  );
});

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
  await assert.rejects(() => host(scratch()).execute(call("rm_rf", {}), signal), /read, write, edit, grep, glob, shell/);
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

/** A small tree for the search tests to work on. */
function fixture(): string {
  const dir = scratch();
  mkdirSync(join(dir, "apps", "cli", "ui"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(
    join(dir, "apps", "cli", "ui", "parts.tsx"),
    ["import { Text } from 'ink';", "export function fitTail() {", "  const rows = 5;", "  return rows;", "}"].join("\n"),
  );
  writeFileSync(join(dir, "apps", "cli", "ui", "parts.test.ts"), 'test("fitTail", () => {});\n');
  writeFileSync(join(dir, "README.md"), "# fixture\n\nfitTail is mentioned here too.\n");
  writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "function fitTail() {}\n");
  writeFileSync(join(dir, ".git", "config"), "[core]\nfitTail\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x01, ...Buffer.from("fitTail")]));
  return dir;
}

const grep = (dir: string, args: Record<string, unknown>): Promise<string> =>
  host(dir).execute(call("grep", args), signal);

// --- grep -------------------------------------------------------------------

test("grep returns the matching paths, relative and posix, by default", async () => {
  assert.equal(
    await grep(fixture(), { pattern: "fitTail" }),
    ["apps/cli/ui/parts.test.ts", "apps/cli/ui/parts.tsx", "README.md"].join("\n"),
  );
});

test("grep skips .git and node_modules rather than searching them", async () => {
  const dir = fixture();
  assert.equal(await grep(dir, { pattern: "fitTail" }), await grep(dir, { pattern: "fitTail" }));
  assert.ok(!(await grep(dir, { pattern: "fitTail" })).includes("node_modules"));
  // Asked for by name it is searched — the skip is about not descending into
  // it uninvited, not about pretending the directory is empty.
  assert.equal(await grep(dir, { pattern: "fitTail", path: "node_modules" }), "node_modules/left-pad/index.js");
});

test("grep scoped to a subdirectory still reports paths the model can read", async () => {
  // The paths have to come out relative to the working directory even when the
  // search itself was rooted somewhere else, or `read` cannot open them.
  assert.equal(
    await grep(fixture(), { pattern: "fitTail", path: "apps/cli/ui" }),
    ["apps/cli/ui/parts.test.ts", "apps/cli/ui/parts.tsx"].join("\n"),
  );
});

test("content mode marks a match with :n: and its context with -n-", async () => {
  const out = await grep(fixture(), {
    pattern: "fitTail",
    path: "apps/cli/ui/parts.tsx",
    output_mode: "content",
    context: 1,
  });
  assert.deepEqual(out.split("\n"), [
    "apps/cli/ui/parts.tsx-1- import { Text } from 'ink';",
    "apps/cli/ui/parts.tsx:2: export function fitTail() {",
    "apps/cli/ui/parts.tsx-3-   const rows = 5;",
  ]);
});

test("context around two nearby matches is not printed twice", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.txt"), ["hit", "x", "hit", "x", "x"].join("\n"));
  const out = await grep(dir, { pattern: "hit", path: "a.txt", output_mode: "content", context: 2 });
  assert.deepEqual(out.split("\n"), [
    "a.txt:1: hit",
    "a.txt-2- x",
    "a.txt:3: hit",
    "a.txt-4- x",
    "a.txt-5- x",
  ]);
});

test("count mode counts the lines that matched, the way ripgrep does", async () => {
  // Two matches on one line is still one matching line. This is `rg --count`
  // rather than a count of occurrences, and the difference is deliberate: the
  // model reads this as "how much of this file is about the thing", which is
  // the question it is asking.
  const dir = scratch();
  writeFileSync(join(dir, "a.txt"), ["one hit and another hit", "no match", "a third hit"].join("\n"));
  assert.equal(await grep(dir, { pattern: "hit", path: "a.txt", output_mode: "count" }), "a.txt:2");
});

test("an include glob with no slash matches the file name, so *.ts works", async () => {
  // This is the glob everybody writes. Anchored to the whole path it matches
  // nothing at all, and the search then reports "nothing was searched".
  assert.equal(
    await grep(fixture(), { pattern: "fitTail", include: "*.ts" }),
    "apps/cli/ui/parts.test.ts",
  );
  // And it stops at the end of the name. Unanchored, *.ts also matched
  // parts.tsx, and this test pinned that as correct — so a model that asked
  // for the TypeScript was handed the JSX too, with no way to tell which
  // of the two it had been given.
  assert.match(
    await grep(fixture(), { pattern: "fitTail", include: "*.tsx" }),
    /parts\.tsx/,
    "a glob that spells the extension out still reaches the file",
  );
});

test("an include glob with a slash matches the path", async () => {
  assert.equal(
    await grep(fixture(), { pattern: "fitTail", include: "apps/**/ui/*.tsx" }),
    "apps/cli/ui/parts.tsx",
  );
});

test("case_insensitive and multiline do what they say", async () => {
  assert.equal(await grep(fixture(), { pattern: "FITTail", case_insensitive: true }), await grep(fixture(), { pattern: "fitTail" }));
  // A pattern that crosses a line end only matches with multiline set, and is
  // then reported at the line it starts on.
  const across = { pattern: "function \\w+\\(\\) \\{\\n  const rows", output_mode: "content" as const };
  assert.equal(await grep(fixture(), { pattern: across.pattern, path: "apps/cli/ui/parts.tsx", output_mode: "content" }), "No matches for " + across.pattern + ". [searched 1 file].");
  assert.equal(
    await grep(fixture(), { pattern: across.pattern, path: "apps/cli/ui/parts.tsx", output_mode: "content", multiline: true }),
    "apps/cli/ui/parts.tsx:2: export function fitTail() {",
  );
});

test("a binary file is skipped and the skip is reported", async () => {
  const dir = fixture();
  const out = await grep(dir, { pattern: "fitTail", path: "blob.bin" });
  assert.match(out, /No matches for fitTail\. \[searched 1 file, skipped 1 binary file\]\./);
  // With only a binary file to search, the count of real files is zero, and the
  // model is told that rather than being told the pattern does not occur.
  assert.equal(await grep(dir, { pattern: "fitTail", include: "*.bin" }), await grep(dir, { pattern: "fitTail", path: "blob.bin" }));
});

test("an empty result says how much was searched, not just that nothing matched", async () => {
  const out = await grep(fixture(), { pattern: "no-such-symbol-anywhere" });
  assert.match(out, /^No matches for no-such-symbol-anywhere\. \[searched 4 files/);
});

test("an include that excludes everything names the glob instead of the path", async () => {
  assert.match(
    await grep(fixture(), { pattern: "fitTail", include: "*.rs" }),
    /include: \*\.rs excluded all \d+ files/,
  );
});

test("a path that does not exist is a sentence, not an ENOENT stack", async () => {
  await assert.rejects(() => grep(fixture(), { pattern: "x", path: "no/such/place" }), /path does not exist: no\/such\/place/);
});

test("a bad pattern and a bad output_mode each say which argument was wrong", async () => {
  const dir = fixture();
  await assert.rejects(() => grep(dir, { pattern: "fitTail(" }), /not a valid regular expression: fitTail\(/);
  await assert.rejects(() => grep(dir, { pattern: "x", output_mode: "everything" }), /output_mode must be files_with_matches, content or count/);
});

test("head_limit is honoured and the note says how much was left behind", async () => {
  const dir = scratch();
  for (const name of ["a", "b", "c"]) writeFileSync(join(dir, `${name}.txt`), "hit\n");
  const out = await grep(dir, { pattern: "hit", head_limit: 2 });
  assert.deepEqual(out.split("\n").slice(0, 2), ["a.txt", "b.txt"]);
  assert.match(out, /showing the first 2 of 3 candidate files/);
  // No truncation, no note — the same rule `shell` follows.
  assert.equal(await grep(dir, { pattern: "hit" }), ["a.txt", "b.txt", "c.txt"].join("\n"));
});

test("a very long matching line is cut, and the cut is announced", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.txt"), `${"hit ".repeat(400)}\n`);
  const out = await grep(dir, { pattern: "hit", path: "a.txt", output_mode: "content" });
  assert.ok(out.split("\n")[0]!.length < 600, "the line was not cut");
  assert.match(out, /1 line longer than 500 characters/);
});

test("grep will not leave the working directory", async () => {
  await assert.rejects(() => grep(fixture(), { pattern: "x", path: "../.." }), /outside|within|working directory/i);
});

test("grep is a real tool the prompt can name", () => {
  assert.ok(host(scratch()).definitions().some((d) => d.function.name === "grep"));
});
// --- glob -------------------------------------------------------------------

const glob = (dir: string, args: Record<string, unknown>): Promise<string> =>
  host(dir).execute(call("glob", args), signal);

test("glob lists a directory rather than reporting nothing", async () => {
  // The first version of this returned `No path matches apps/cli` for a
  // directory that was right there, and it did so for two independent reasons:
  // the trailing slash is a display convention that had leaked into matching,
  // and the walk starts inside the pattern's own directory, so that directory
  // is never yielded to itself. The bare name is the query a model reaches for
  // first after being told where something is, so it has to work.
  assert.equal(await glob(fixture(), { pattern: "apps/cli/ui" }), "apps/cli/ui/");
  assert.equal(await glob(fixture(), { pattern: "README.md" }), "README.md");
});

test("a directory carries a trailing slash, so one level is distinguishable from a tree", async () => {
  assert.deepEqual((await glob(fixture(), { pattern: "apps/*" })).split("\n"), ["apps/cli/"]);
  // A file at the same level is bare, so `apps/*` cannot be mistaken for a
  // list of files that happens to live in a directory.
  assert.deepEqual((await glob(fixture(), { pattern: "*.md" })).split("\n"), ["README.md"]);
});

test("a pattern with no slash in it matches the file name, at any depth", async () => {
  // The `*.ts` that everybody writes has to reach apps/cli/ui/parts.tsx, or the
  // tool is worse than the shell round trip it exists to remove.
  assert.deepEqual((await glob(fixture(), { pattern: "*.ts" })).split("\n"), [
    "apps/cli/ui/parts.test.ts",
  ]);
  assert.deepEqual((await glob(fixture(), { pattern: "*.tsx" })).split("\n"), [
    "apps/cli/ui/parts.tsx",
  ]);
});

test("a single star stays in one directory and a double star crosses", async () => {
  // The two stars are not interchangeable, and the difference is the only way
  // to ask for a shallow listing — which is what "what is in this directory"
  // means.
  assert.match(
    await glob(fixture(), { pattern: "apps/cli/*.ts" }),
    /^No path matches/,
    "a single star reached down into ui/, where no .ts file sits directly above it",
  );
  assert.deepEqual((await glob(fixture(), { pattern: "apps/cli/ui/*.ts" })).split("\n"), [
    "apps/cli/ui/parts.test.ts",
  ]);
  assert.deepEqual((await glob(fixture(), { pattern: "apps/**/*.ts" })).split("\n"), [
    "apps/cli/ui/parts.test.ts",
  ]);
});

test("the walk starts at the pattern's fixed part instead of at the root", async () => {
  // `apps/cli/src/*.ts` can only be answered under apps/cli/src, so the rest of
  // the tree is never read. A missing fixed part is therefore an error naming
  // it, not a walk that finds nothing — which is the difference between "there
  // is no such directory" and "no file matched", and the model acts on them
  // differently.
  await assert.rejects(
    () => glob(fixture(), { pattern: "nope/*.ts" }),
    /directory that does not exist: nope/,
  );
  // Scoped by `path`, the fixed part is relative to that path, not the root.
  await assert.rejects(
    () => glob(fixture(), { pattern: "nope/*.ts", path: "apps/cli" }),
    /directory that does not exist: nope/,
  );
});

test("a skipped directory is listed, not hidden, and the note says why", async () => {
  const out = await glob(fixture(), { pattern: "*" });
  // Listed, because the directory is there and a listing that omits it tells
  // the model the tree has no such thing. Not descended, because that is the
  // point of the skip — and the note is what separates the two, so that
  // `node_modules/` does not read as an empty folder.
  assert.match(out, /^node_modules\/$/m, "node_modules was hidden from the listing");
  assert.match(out, /^\.git\/$/m, ".git was hidden from the listing");
  assert.match(out, /listed but not searched: [^[]*node_modules\//);
  assert.ok(!out.includes("left-pad"), "the walk went inside a directory it said it skipped");
  // Asked for by path it is searched, exactly as grep does it: the skip is
  // about not descending uninvited, not about refusing.
  assert.equal(
    await glob(fixture(), { pattern: "*.js", path: "node_modules/left-pad" }),
    "node_modules/left-pad/index.js",
  );
});

test("the skip note only appears for a directory this answer contains", async () => {
  // Otherwise the output depends on the rest of the tree rather than on the
  // question: asking for one file came back with a footnote about a directory
  // that was nowhere in the result.
  assert.equal(
    await glob(fixture(), { pattern: "README.md" }),
    "README.md",
    "an unrelated skipped directory leaked into the answer",
  );
});

test("a symlinked directory is neither listed nor followed", async () => {
  // A link to an ancestor turns a listing into an infinite walk, and one that
  // points outward steps outside the directory the search was confined to.
  const dir = fixture();
  symlinkSync(join(dir, "apps"), join(dir, "loop"), "dir");
  const out = await glob(dir, { pattern: "*" });
  assert.ok(!out.includes("loop"), "the link was listed as a directory");
  assert.ok(out.includes("apps/cli/"), "but the real tree is still there");
});

test("glob scoped to a subdirectory still reports paths the model can read", async () => {
  // The paths have to come out relative to the working directory even when the
  // walk was rooted somewhere else, or `read` cannot open them. This is the
  // same trap `grep` has: `within` resolves paths and `ctx.cwd` does not, so a
  // display path built from the raw cwd is a chain of `../..` on a temp dir.
  const out = await glob(fixture(), { pattern: "*.ts", path: "apps/cli/ui" });
  assert.deepEqual(out.split("\n"), ["apps/cli/ui/parts.test.ts"]);
  assert.ok(!out.includes(".."), `the path is not readable from the working directory: ${out}`);
});

test("a capped listing says how many matched, so it cannot read as complete", async () => {
  // A short list handed over as if it were the whole tree is how a model
  // concludes a file does not exist when it was below the cut. The count is
  // the difference between "those are the files" and "those are the first
  // files", and it is the only channel the model has.
  const out = await glob(fixture(), { pattern: "*", head_limit: 2 });
  assert.equal(out.split("\n").filter((line) => line !== "" && !line.startsWith("[")).length, 2);
  assert.match(out, /showing 2 of \d+ matches/);
});

test("an empty listing says how much was walked", async () => {
  // "Nothing matches" and "I looked and found nothing to look at" are
  // different facts, and the second one is what a model needs when the tree is
  // not what it assumed.
  assert.match(await glob(fixture(), { pattern: "*.nomatch" }), /walked \d+ entries/);
  await assert.rejects(
    () => glob(fixture(), { pattern: "*", path: "node_modules/left-pad/deeper" }),
    /directory that does not exist/,
  );
});

test("the listing is sorted by path, case-insensitively, not by modification time", async () => {
  // Sorted by time — which is what Claude Code does — the same call returns a
  // different order on the next run, and the model cannot tell a reordering
  // from a different answer. A plain code-unit sort would put README.md above
  // apps/, which is not how anyone reads a directory.
  const dir = fixture();
  writeFileSync(join(dir, "zebra.ts"), "z");
  writeFileSync(join(dir, "Alpha.ts"), "a");
  writeFileSync(join(dir, "beta.ts"), "b");
  assert.deepEqual((await glob(dir, { pattern: "*.ts" })).split("\n"), [
    "Alpha.ts",
    "apps/cli/ui/parts.test.ts",
    "beta.ts",
    "zebra.ts",
  ]);
});

test("glob will not leave the working directory", async () => {
  await assert.rejects(
    () => glob(fixture(), { pattern: "../*" }),
    /outside|within|working directory/i,
  );
});

test("a path that is a file is told which tool to use instead", async () => {
  // Listing a file is not a question `glob` can answer, and an empty result
  // would read as "no such file" — so it names the tool that can.
  await assert.rejects(
    () => glob(fixture(), { pattern: "main.ts", path: "README.md" }),
    /Use read for a file/,
  );
});

test("glob is a real tool the prompt can name", async () => {
  assert.ok(host(scratch()).definitions().some((d) => d.function.name === "glob"));
});
