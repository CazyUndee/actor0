import type { ToolCall, ToolDefinition, ToolHost } from "@actor0/harness";
import { readFile, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";

/**
 * The CLI's tools.
 *
 * The harness has a `ToolHost` port: the harness sequences tool calls and feeds
 * results back, but it has no idea what a tool *does*. Everything below is
 * host policy — which files are reachable, how big a result may be, how long a
 * command may run.
 *
 * There is no approval gate. It was here for a while, and it was removed on
 * purpose: it existed to protect against a model that asked for the wrong
 * thing, but every shell command and every full-file overwrite needed a
 * keypress, and the result was a user pressing `y` without reading. A prompt
 * that is always approved is not a control. The mitigations that actually help
 * are here instead — every path is confined to the working directory, results
 * are capped, and the model is told plainly what the blast radius is.
 *
 * The contracts below are written for the model, not for us: a truncation note
 * that names the exact offset to resume at, an output cap that keeps the tail
 * because errors come last, an edit that survives CRLF and BOM instead of
 * failing on a Windows file. Those details are what separate a tool the model
 * can drive from one it fights.
 */
export type ToolContext = {
  cwd: string;
  signal: AbortSignal;
};

type CliTool = {
  definition: ToolDefinition;
  /** One line for the activity line in the transcript. */
  label: (args: Record<string, unknown>, ctx: ToolContext) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

// --- shared helpers --------------------------------------------------------

const MAX_READ_LINES = 2_000;
const MAX_READ_BYTES = 50_000;

/**
 * Columns kept from one line before it is cut.
 *
 * The byte cap bounds the *file*; it says nothing about a file that is one
 * line. A minified bundle, a lockfile entry, a base64 data URI or one CSV row
 * passes the 50KB budget as a single 50,000-character line the model cannot
 * read, cannot navigate, and may quote back verbatim into a write — and a
 * line number in front of it is no help, because there is only the one.
 *
 * Claude Code puts the same number on ripgrep (`--max-columns 500`) for the
 * same reason. It is not a tuned number: it is a width at which a human can
 * still read the line, which is the only test that matters for a cut this blunt.
 */
const MAX_LINE_COLUMNS = 500;
const MAX_OUTPUT_BYTES = 30_000;
const MAX_TIMEOUT_SECONDS = 3_600;

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing required string parameter "${key}"`);
  }
  return value;
}

/**
 * A string that is allowed to be empty.
 *
 * `requireString` is right for a path and wrong for the two parameters whose
 * whole job is to carry content, because the one value a caller most often
 * needs to send is the empty one. `edit` with `new_string: ""` is how a model
 * deletes a block, and `write` with `content: ""` is how it empties a file;
 * both were rejected as *missing parameters*, so the model fell back to
 * rewriting whole files by hand — which is the one thing `edit` exists to
 * avoid, and a much more destructive way to achieve the same edit.
 */
function requireText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`missing required string parameter "${key}"`);
  }
  return value;
}

/**
 * Resolve a path, and refuse to leave the working directory.
 *
 * This is the one containment that matters now that nothing is gated. A model
 * that decides `../../.ssh/id_rsa` was a reasonable thing to read is stopped
 * here rather than by a dialog the user stopped reading three turns ago.
 *
 * The comparison has to be against *real* paths. A purely lexical check
 * (`resolve` + `startsWith`) is satisfied by any path that merely reads as
 * inside the root, and a symlink or Windows junction inside the working
 * directory is such a path: `link/escape/secret.txt` is lexically inside and
 * physically anywhere. Since nothing is gated any more, that was the
 * difference between a contained agent and one that could read and write the
 * whole disk through a link it happened to find. Both directions were
 * reachable — a read that returned the contents of another user's temp file,
 * and a write that planted one.
 *
 * Symlinks are resolved for the deepest ancestor that exists, because the
 * target of a `write` usually does not exist yet: `a/b/c.txt` is checked as
 * realpath(`a/b`) + `c.txt`. The tail cannot contain a link, because a
 * non-existent path has nothing to point at.
 */
async function within(cwd: string, path: string): Promise<string> {
  const target = isAbsolute(path) ? path : resolve(cwd, path);
  // Not cached: realpath on a directory is one call, and a cache keyed on the
  // cwd string is a stale-root waiting for a directory to be moved under it.
  const root = await realpath(resolve(cwd)).catch(() => resolve(cwd));

  let resolved = target;
  const tail: string[] = [];
  // Walk up until something real exists to resolve. Bounded by the path depth,
  // and the lexical check below stops a climb that leaves the root anyway.
  for (;;) {
    const real = await realpath(resolved).catch(() => null);
    if (real !== null) {
      resolved = tail.length === 0 ? real : resolve(real, ...tail.reverse());
      break;
    }
    const parent = dirname(resolved);
    if (parent === resolved) {
      // Reached the filesystem root without finding anything that exists, so
      // the lexical check below is all there is.
      break;
    }
    tail.push(resolved.slice(parent.length + 1));
    resolved = parent;
  }

  const rel = relative(root, resolved);
  if (rel === "") return resolved;
  const outside = escapes(rel);
  if (outside) {
    throw new Error(
      `refusing to touch ${path}: resolves to ${resolved}, outside the working directory ${root}`
      + (outside && tail.length > 0 ? " (through a link)" : ""),
    );
  }
  return resolved;
}

/**
 * Did a relative path leave the root?
 *
 * Not `startsWith("..")`, which is a prefix test on a path, and paths are not
 * prefixes. `..cache/data.txt` is a file two levels down in a directory that
 * happens to be named `..cache`, and the prefix test refused to read it —
 * along with every other `..`-prefixed name a project might legitimately
 * contain. What escapes is a `..` *segment*: the path itself, or a segment
 * that starts with one.
 */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** `cwd` is usually the same directory for every call in a turn; resolve it once. */

// --- read ------------------------------------------------------------------

/**
 * Cut one line to the column cap, or say that nothing changed.
 *
 * The marker is part of the output on purpose. A line cut without one is a
 * silently edited file: the model would read the first 500 columns as the whole
 * line and edit as though the rest did not exist, which is the same class of lie
 * as a truncated result that claims to be complete.
 */
function cutLine(line: string): { text: string; cut: boolean } {
  if (line.length <= MAX_LINE_COLUMNS) return { text: line, cut: false };
  return {
    text: `${line.slice(0, MAX_LINE_COLUMNS)} [cut: +${line.length - MAX_LINE_COLUMNS} chars]`,
    cut: true,
  };
}

/**
 * Say which lines were cut, and how to read one whole.
 *
 * A count is not actionable: the model cannot `sed -n` line 1 of 4,213. The
 * numbers are the whole point, so they are listed — bounded, because a minified
 * file has one enormous line and a lockfile has thousands of merely long ones.
 */
function cutNotice(numbers: number[], asked: string): string {
  const one = numbers.length === 1;
  const shown = numbers.slice(0, 5);
  const rest = numbers.length - shown.length;
  // With one line, "(1)" says nothing the sentence has not already said.
  const where = one ? "" : `(lines ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""})`;
  return (
    `[${numbers.length} line${one ? "" : "s"} longer than ${MAX_LINE_COLUMNS} characters${where ? ` ${where}` : ""} ` +
    `${one ? "was" : "were"} cut above. To read ${one ? "it" : "one of them"} whole, use the shell tool: ` +
    `sed -n '${shown[0]}p' ${asked} | fold -w ${MAX_LINE_COLUMNS}.]`
  );
}

/**
 * Put a note under a body without stacking blank lines.
 *
 * A file that ends in a newline plus the separator the note needs is three
 * newlines, which reads as a gap in the transcript rather than as formatting.
 */
function withNotice(body: string, note: string): string {
  return `${body.replace(/\n+$/, "")}\n\n${note}`;
}
function cutLongLines(text: string): { text: string; lines: number[] } {
  const cut: number[] = [];
  const out = text.split("\n").map((line, i) => {
    const result = cutLine(line);
    if (result.cut) cut.push(i + 1);
    return result.text;
  });
  return { text: out.join("\n"), lines: cut };
}

/**
 * Slice `lines` to the line and byte caps, reporting what survived.
 *
 * The continuation offset is the load-bearing part: a model that just ran out
 * of file needs the next `offset=` handed to it, not a count of what it did
 * not get. "N more lines" made the model guess — or worse, re-read the whole
 * file with a bigger limit and burn the context window it was trying to save.
 *
 * `totalLines` is the file's own length, not the window's. The note used to
 * say "of <window end>", so `limit: 2500` on a 3000-line file claimed the
 * file was 2500 lines long — and a model that believes the file ends where
 * its own `limit` ended edits a file it thinks it has read in full.
 */
function capLines(
  lines: string[],
  startLine: number,
  totalLines: number,
): { text: string; nextOffset?: number; cuts: number[] } {
  let byteCount = 0;
  let end = 0;
  for (; end < lines.length && end < MAX_READ_LINES; end++) {
    const lineBytes = Buffer.byteLength(lines[end], "utf8") + 1;
    if (byteCount + lineBytes > MAX_READ_BYTES && end > 0) {
      break;
    }
    byteCount += lineBytes;
  }
  // Cut before the number goes on, so the marker lands inside the line and the
  // column it happened at stays visible.
  const cuts: number[] = [];
  const shown = lines.slice(0, end).map((line, i) => {
    const cut = cutLine(line);
    if (cut.cut) cuts.push(startLine + i);
    return `${startLine + i}\t${cut.text}`;
  });
  const remaining = lines.length - end;
  if (remaining <= 0) return { text: shown.join("\n"), cuts };
  const nextOffset = startLine + end;
  // Reaching the line cap means the loop ran out of lines budget; stopping
  // early means the next line would have busted the byte cap.
  const why =
    end >= MAX_READ_LINES
      ? `${MAX_READ_LINES}-line limit`
      : `${MAX_READ_BYTES.toLocaleString("en-US")}-byte limit`;
  return {
    text: `${shown.join("\n")}\n\n[Showing lines ${startLine}-${startLine + end - 1} of ${totalLines} (${why}). Use offset=${nextOffset} to continue.]`,
    nextOffset,
    cuts,
  };
}

const readTool: CliTool = {
  definition: {
    type: "function",
    function: {
      name: "read",
      description:
        "Read a text file. Files are capped at 2000 lines / 50KB, and any single line longer than 500 characters is cut with a marker saying so; when either cap bites, the output ends with the exact offset=N to pass next. Prefer this over shelling out to `cat` — it is cheaper and it pages deterministically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory." },
          offset: { type: "number", description: "First line to return, 1-based. Use the offset named in a truncation note to continue a large file." },
          limit: { type: "number", description: "Maximum number of lines to return. Optional." },
        },
        required: ["path"],
      },
    },
  },
  label: (args) => `read ${String(args.path ?? "")}`,
  async run(args, ctx) {
    const target = await within(ctx.cwd, requireString(args, "path"));
    const info = await stat(target);
    if (info.isDirectory()) throw new Error(`${target} is a directory — list it with the shell tool, or read a file inside it`);
    const raw = await readFile(target, "utf8");
    const all = raw.split("\n");
    if (all.length > 0 && all[all.length - 1] === "") all.pop();

    // Small file, no paging requested: return the bytes as they are. Line
    // numbers are for navigation, and the model does not need them — or the
    // round-trip noise — to quote the file back in an edit.
    const fits = all.length <= MAX_READ_LINES && Buffer.byteLength(raw, "utf8") <= MAX_READ_BYTES;
    if (fits && args.offset === undefined && args.limit === undefined) {
      // Byte for byte when nothing was cut. The line cap is the only thing in
      // here that edits the bytes, so the test is on the bytes rather than on
      // a flag: if the cut changed nothing, `raw` goes back exactly as it was.
      const cut = cutLongLines(raw);
      return cut.lines.length === 0 ? raw : withNotice(cut.text, cutNotice(cut.lines, String(args.path)));
    }

    const start = Math.max(1, Math.floor(Number(args.offset) || 1));
    if (start > all.length) {
      throw new Error(`offset ${start} is past the end of ${target} (${all.length} lines total)`);
    }
    const window = Math.floor(Number(args.limit))
      ? Math.max(1, Math.floor(Number(args.limit)))
      : all.length;
    const slice = all.slice(start - 1, start - 1 + window);
    const capped = capLines(slice, start, all.length);
    const cut = capped.cuts.length > 0 ? `\n\n${cutNotice(capped.cuts, String(args.path))}` : "";
    const moreAfterWindow = start - 1 + slice.length < all.length;
    if (!capped.nextOffset && moreAfterWindow) {
      const nextOffset = start + slice.length;
      return `${capped.text}\n\n[${all.length - (start - 1 + slice.length)} more lines in file. Use offset=${nextOffset} to continue.]${cut}`;
    }
    // A paged read that has run out of file says so. Without it the last
    // page is indistinguishable from a page whose note was merely lost, and
    // the model cannot tell when to stop paging.
    if (!capped.nextOffset) return `${capped.text}\n\n[End of file: ${all.length} lines.]${cut}`;
    return `${capped.text}${cut}`;
  },
};

// --- write -----------------------------------------------------------------

const writeTool: CliTool = {
  definition: {
    type: "function",
    function: {
      name: "write",
      description:
        "Create a file or replace its entire contents. Parent directories are created automatically. Overwrites without asking. Use for new files or deliberate whole-file rewrites; use edit to change part of an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory." },
          content: { type: "string", description: "The complete new contents of the file." },
        },
        required: ["path", "content"],
      },
    },
  },
  label: (args) => `write ${String(args.path ?? "")}`,
  async run(args, ctx) {
    const target = await within(ctx.cwd, requireString(args, "path"));
    const content = requireText(args, "content");
    const existed = await stat(target).then(
      () => true,
      () => false,
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    // `"".split("\n")` is one empty line, not zero; a file the model just
    // emptied should not be reported as having one.
    const lines = content === "" ? 0 : content.split("\n").length;
    return existed
      ? `Replaced ${target} (${content.length} characters, ${lines} lines).`
      : `Created ${target} (${content.length} characters, ${lines} lines).`;
  },
};

// --- edit ------------------------------------------------------------------

/**
 * Line endings and BOM, handled where the model cannot see them.
 *
 * A model quoting text it read over the wire sends LF; most files on this
 * machine are CRLF, and a byte-exact match against the raw file simply fails,
 * which reads to the model as "the file changed underneath me". pi normalizes
 * to LF, matches, and restores the file's own endings on write; so does this.
 * The BOM is stripped for the same reason — the model will never include one
 * in old_string, and must not be punished for the editor that added it.
 */
function splitTextFile(raw: string): { bom: string; body: string; crlf: boolean } {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? raw.slice(1) : raw;
  return { bom, body, crlf: body.includes("\r\n") };
}

function joinTextFile(bom: string, body: string, crlf: boolean): string {
  return bom + (crlf ? body.replace(/\n/g, "\r\n") : body);
}

const toLf = (text: string): string => text.replace(/\r\n/g, "\n");

const editTool: CliTool = {
  definition: {
    type: "function",
    function: {
      name: "edit",
      description:
        "Replace an exact string in one file. old_string must appear exactly once unless replace_all is true; on zero or multiple matches nothing is written and the error says the count. CRLF line endings and a UTF-8 BOM are handled for you: quote the text as it looked when you read it. Prefer this over write for any change to part of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory." },
          old_string: { type: "string", description: "Exact text to replace, including indentation. Keep it as small as possible while still unique in the file." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence. Defaults to false." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  label: (args) => `edit ${String(args.path ?? "")}`,
  async run(args, ctx) {
    const target = await within(ctx.cwd, requireString(args, "path"));
    const oldString = requireString(args, "old_string");
    // Empty is the *point* of an edit as often as not — that is a deletion.
    const newString = requireText(args, "new_string");
    const replaceAll = args.replace_all === true;

    const raw = await readFile(target, "utf8");
    const { bom, body, crlf } = splitTextFile(raw);
    const content = toLf(body);
    const before = toLf(oldString);
    const after = toLf(newString);

    const occurrences = content.split(before).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `old_string not found in ${target}. Read the file and copy the text exactly, including indentation.`,
      );
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string appears ${occurrences} times in ${target}. Include more surrounding context to make it unique, or pass replace_all.`,
      );
    }
    const updated = replaceAll ? content.split(before).join(after) : content.replace(before, after);
    const written = joinTextFile(bom, updated, crlf);
    await writeFile(target, written, "utf8");
    const changed = occurrences === 1 ? "1 occurrence" : `${occurrences} occurrences`;
    return `Edited ${target} (${changed} replaced, ${written.length} characters total).`;
  },
};

// --- shell -----------------------------------------------------------------

/** Which syntax the command text has to be written in. */
export type ShellFamily = "posix" | "powershell" | "cmd";

export type ResolvedShell = {
  /** The binary to spawn. */
  command: string;
  /** argv inserted before the user's command text. */
  prefixArgs: string[];
  /** What to call it in prose, to the model, and in the UI. */
  name: string;
  family: ShellFamily;
  /**
   * Whether `a && b` actually parses here.
   *
   * Probed, not assumed, because it is not constant even within a family:
   * PowerShell 7 added the pipeline chain operators and Windows PowerShell
   * 5.1 — still the `powershell.exe` on most machines — rejects them as a
   * syntax error, running *nothing*. Telling the model to chain with `&&` on
   * 5.1 hands it a command that produces no output and a non-zero exit, which
   * reads to it as the tool being broken.
   */
  chainsWithAnd: boolean;
};

/** A candidate before it has been probed. */
type ShellCandidate = Omit<ResolvedShell, "chainsWithAnd">;

/**
 * The shells Windows ships, in the order a person running a terminal would
 * expect. PowerShell first: it is the default profile in Windows Terminal and
 * the one a developer means by "the command line" on Windows. cmd.exe is the
 * fallback, not the preference.
 */
const WINDOWS_SHELLS: ShellCandidate[] = [
  { command: "pwsh.exe", name: "PowerShell", family: "powershell", prefixArgs: ["-NoProfile", "-NonInteractive", "-Command"] },
  { command: "powershell.exe", name: "Windows PowerShell", family: "powershell", prefixArgs: ["-NoProfile", "-NonInteractive", "-Command"] },
  { command: "cmd.exe", name: "cmd.exe", family: "cmd", prefixArgs: ["/d", "/s", "/c"] },
];

/** POSIX shells all take `-c`; the name is taken from the binary that was asked for. */
function posixShell(command: string): ShellCandidate {
  const base = command.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "") || "sh";
  return { command, prefixArgs: ["-c"], name: base, family: "posix" };
}

/**
 * Run a real two-command line through the candidate and report what it did.
 *
 * One spawn answers both questions, because the first is too weak to stand
 * alone: `exit 0` succeeds on a shell that cannot actually run the commands it
 * will be handed — on PowerShell 7 it exits before evaluating the rest, and on
 * the WSL launcher it exits zero while relaying `execvpe(/bin/bash) failed`.
 * `echo` is a builtin or an alias in every shell this could pick, so the
 * output proves the line was parsed *and* executed, and proves `&&` at the
 * same time: if `TWO` is missing, `&&` never ran.
 */
const PROBE = "echo ACTOR0_PROBE && echo ACTOR0_CHAINED";

function probe(candidate: ShellCandidate): { usable: boolean; chains: boolean } {
  try {
    const run = spawnSync(candidate.command, [...candidate.prefixArgs, PROBE], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (run.error || run.status !== 0) return { usable: false, chains: false };
    const stdout = run.stdout ?? "";
    // The WSL launcher relays the failure on stderr and can still exit zero.
    if (/WSL|CreateProcessCommon|execvpe/i.test(`${stdout}${run.stderr ?? ""}`)) {
      return { usable: false, chains: false };
    }
    if (!stdout.includes("ACTOR0_PROBE")) return { usable: false, chains: false };
    return { usable: true, chains: stdout.includes("ACTOR0_CHAINED") };
  } catch {
    return { usable: false, chains: false };
  }
}

/** Resolved once: the probe spawns a process and this is on every tool call. */
let cachedShell: ResolvedShell | undefined;

/**
 * The shell this machine actually has, and how to talk to it.
 *
 * Nothing here is hardcoded to bash, for two reasons that each caused a real
 * failure. The *binary* was `bash`, which on Windows resolves through PATH to
 * `C:\Windows\System32\bash.exe` — the WSL launcher — and then fails with
 * `execvpe(/bin/bash) failed` on any machine without a distro. The *argv* was
 * `-c`, which PowerShell does not accept at all.
 *
 * So the binary is whatever this OS considers the default: `$SHELL` when the
 * user launched from a POSIX shell, otherwise PowerShell and then cmd.exe on
 * Windows. `ACTOR0_SHELL` overrides it for anyone who wants a specific one.
 */
export function resolveShell(): ResolvedShell {
  if (cachedShell) return cachedShell;
  const override = process.env.ACTOR0_SHELL;
  const candidates: ShellCandidate[] = override
    ? [posixShell(override)]
    : process.env.SHELL
      ? [posixShell(process.env.SHELL)]
      : process.platform === "win32"
        ? WINDOWS_SHELLS
        : [posixShell("/bin/bash"), posixShell("/bin/sh")];

  for (const candidate of candidates) {
    const result = probe(candidate);
    if (!result.usable) continue;
    cachedShell = {
      ...candidate,
      // POSIX guarantees it, so do not spend a second spawn to learn it; for
      // the Windows shells it is exactly the thing that varies.
      chainsWithAnd: result.chains || candidate.family === "posix",
    };
    return cachedShell;
  }
  // Nothing ran. Report the first candidate honestly — including that its
  // `&&` support is unknown — so the model's next tool call shows the real
  // failure rather than a note that guesses at the cause.
  cachedShell = { ...candidates[0]!, chainsWithAnd: candidates[0]!.family === "posix" };
  return cachedShell;
}

/**
 * What to tell the model about the shell it is holding.
 *
 * The point of naming the tool `shell` rather than `bash` is that the model
 * stops assuming POSIX: on PowerShell `find` does not exist and a piped `grep`
 * is a PowerShell error, and a model told it is in bash will confidently run
 * both. Saying which shell it is, and what that implies, is the whole fix.
 *
 * Everything asserted here is something a model will otherwise guess wrong, so
 * each clause is a probed fact rather than a convention. That is also how the
 * cmd.exe note was wrong for a while: it claimed there was no `&&`, which is
 * false — cmd has no *pipelines*, and chains with `&&` perfectly well.
 */
export function shellNotes(shell: ResolvedShell): string {
  switch (shell.family) {
    case "powershell":
      return (
        "This is PowerShell, not bash: use cmdlets and PowerShell operators. " +
        "`Get-ChildItem`, `Get-Content`, `Select-String`, `Test-Path` exist; `ls` and `cat` are aliases for two of them. " +
        "`find` does NOT exist — use `Get-ChildItem`. " +
        "Quote paths in single quotes. " +
        (shell.chainsWithAnd
          ? "Chain commands with `&&`."
          : "`&&` is a syntax error on this version and the whole line runs nothing — "
            + "use `;` to run the next command regardless, or `if ($?) { ... }` to stop on failure.")
      );
    case "cmd":
      return (
        "This is cmd.exe, not bash. It has no pipelines — `|` and `>` are not operators — and quoting is " +
        "\"double quotes only\". Use `dir`, `type`, `where`. Chain with `&&`; use `&` to run the next " +
        "command even when the last one failed."
      );
    case "posix":
      return (
        `This is ${shell.name}, so POSIX shell syntax applies: pipelines, \`&&\`, \`||\`, single-quoted strings, ` +
        "and `ls`, `rg`, `find`, `git` are all available as written."
      );
  }
}

/**
 * Kill the command and everything it spawned.
 *
 * `child.kill()` on Windows terminates bash.exe and nothing else — the
 * `sleep` (or build, or dev server) it started keeps the stdio pipe open, so
 * the `close` event never fires and the tool call hangs until the *command's*
 * natural end. `taskkill /T` takes the whole tree, which is what a timeout
 * or a cancelled turn means.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * What a stream has produced, and what the cap has already thrown away.
 *
 * The count is the point. `keepTail` used to work out how much had been
 * dropped from the text it was handed, which is only ever the text that
 * survived: a 160KB build log arrives here as the 34KB the accumulator kept,
 * and the notice said "4,094 earlier bytes dropped" when 130,000 had been. The
 * model reads that, concludes the log is otherwise complete, and answers from
 * output it cannot see. A truncation notice that undercounts is worse than none,
 * because it is trusted.
 */
type Output = { text: string; droppedBytes: number; droppedLines: number };

/** Newlines in a slice, which is what the notice counts in alongside bytes. */
const newlines = (text: string): number => {
  let count = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count += 1;
  return count;
};

/**
 * Keep the tail, because that is where the error is.
 *
 * A head-cap shows the model the start of a build log and throws away the
 * "ERR!" it was looking for, so it re-runs the command through `tail` — a
 * wasted round on a command that may be slow or not idempotent.
 */
function keepTail(out: Output, limit = MAX_OUTPUT_BYTES): string {
  // The final trim at render time counts too: the accumulator keeps a little
  // more than the limit so the cut lands on a line boundary, and those extra
  // bytes were dropped as surely as any other.
  const renderDrop = Math.max(0, out.text.length - limit);
  const bytes = out.droppedBytes + renderDrop;
  if (bytes === 0) return out.text;
  const lines = out.droppedLines + (renderDrop > 0 ? newlines(out.text.slice(0, renderDrop)) : 0);
  const tail = out.text.slice(-limit);
  const firstNewline = tail.indexOf("\n");
  const body = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
  // Bytes and lines both, because the reader acts on one of them and reasons
  // about the other: "1,200 lines" says how much to re-run with, and 130,000
  // says the same thing to a program.
  return (
    `[output truncated: ${bytes.toLocaleString("en-US")} earlier bytes and ` +
    `${lines.toLocaleString("en-US")} lines dropped, keeping the last ` +
    `${limit.toLocaleString("en-US")}]\n${body}`
  );
}

/**
 * Streaming accumulation that keeps the tail, and counts what it discards.
 *
 * Capping the accumulator itself caps the *head* — the end of a 160KB build
 * log never reaches `keepTail` because collection stopped 100KB ago. When the
 * buffer outgrows its slack, drop from the front so the most recent output is
 * always what survives, and count the bytes and lines that went with it.
 */
const ACCUM_SLACK = MAX_OUTPUT_BYTES + 4_096;

const emptyOutput = (): Output => ({ text: "", droppedBytes: 0, droppedLines: 0 });

function appendBounded(acc: Output, next: string): Output {
  const merged = acc.text + next;
  if (merged.length <= ACCUM_SLACK) return { text: merged, droppedBytes: acc.droppedBytes, droppedLines: acc.droppedLines };
  const kept = merged.length - ACCUM_SLACK;
  return {
    text: merged.slice(kept),
    droppedBytes: acc.droppedBytes + kept,
    droppedLines: acc.droppedLines + newlines(merged.slice(0, kept)),
  };
}

/**
 * The shell tool.
 *
 * Named `shell` rather than `bash` on purpose. A tool called `bash` is a claim
 * about the machine, and it was wrong on every Windows terminal: the model read
 * the name, wrote `ls -F` and `find`, and had no way to know those were not
 * going to work here. The name is now a fact it can check, and the description
 * says which shell this actually is.
 */
const shellTool: CliTool = {
  definition: {
    type: "function",
    function: {
      name: "shell",
      description: `Run a command in the user's shell, in the working directory. ${shellNotes(resolveShell())} Returns stdout and stderr, then the exit code on the last line. Use for git, listing, searching, package managers, test runners — everything that is not a plain read/write/edit of one file. No timeout by default; pass timeout (seconds, max 3600) for anything that could hang. Output is capped, keeping the tail where errors are.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line to run." },
          timeout: { type: "number", description: "Kill the command after this many seconds. Optional; no default timeout." },
        },
        required: ["command"],
      },
    },
  },
  label: (args) => String(args.command ?? "").replace(/\s+/g, " ").trim(),
  async run(args, ctx) {
    const command = requireString(args, "command");
    const shell = resolveShell();
    let timeoutMs: number | undefined;
    if (args.timeout !== undefined && args.timeout !== null && Number.isFinite(Number(args.timeout))) {
      const seconds = Number(args.timeout);
      if (seconds <= 0) throw new Error(`invalid timeout: ${seconds} — pass seconds, or omit for no timeout`);
      if (seconds > MAX_TIMEOUT_SECONDS) throw new Error(`invalid timeout: max is ${MAX_TIMEOUT_SECONDS} seconds`);
      timeoutMs = seconds * 1_000;
    }

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(shell.command, [...shell.prefixArgs, command], {
        cwd: ctx.cwd,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
        // Detached + a killed process group on POSIX; taskkill /T on Windows.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      // Nothing to read, said once and immediately.
      //
      // The default stdin is a pipe, and a pipe nobody writes to and nobody
      // closes never reaches EOF, so every command that reads stdin waited
      // for input that was never coming: `cat` with no arguments, `sort`,
      // a pager, anything a script would run with its stdin redirected from
      // nothing. With no default timeout on this tool that wait is an hour,
      // and the only thing that ends it is the user noticing.
      //
      // Closing the pipe is what says "no input" — not `stdin: "ignore"`,
      // which was the first thing tried and is wrong here: on Windows the
      // ignored handle is not a console and not a pipe, and `cmd /c more`
      // spins on it for over a minute instead of seeing EOF. A closed pipe is
      // EOF everywhere.
      //
      // Redirection and pipes are unaffected, because those are the shell
      // opening and connecting things: `cmd < file` and `a | b` never touch
      // this pipe.
      child.stdin?.end();

      let stdout = emptyOutput();
      let stderr = emptyOutput();
      let settled = false;
      let timedOut = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        killTree(child);
        finish(() => reject(new Error("cancelled")));
      };
      const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs);
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk.toString("utf8"));
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => {
        finish(() => {
          if (timedOut) {
            // Both streams' discards are counted together: the model is being
            // shown one joined blob, and the notice has to be about that blob.
            const partial: Output = {
              text: [stdout.text.trimEnd(), stderr.text.trimEnd()].filter(Boolean).join("\n\n"),
              droppedBytes: stdout.droppedBytes + stderr.droppedBytes,
              droppedLines: stdout.droppedLines + stderr.droppedLines,
            };
            const body = partial.text ? `\n${keepTail(partial)}` : "";
            reject(new Error(`Command timed out after ${Math.round((timeoutMs ?? 0) / 1_000)} seconds.${body}`));
            return;
          }
          // stdout first, stderr second, exit code last: the model reads the
          // failure at the end of the result, next to where it decides what
          // to do about it.
          const parts: string[] = [];
          const out = (value: Output): Output => ({ ...value, text: value.text.trimEnd() });
          if (stdout.text.trim()) parts.push(keepTail(out(stdout)));
          if (stderr.text.trim()) parts.push(`stderr:\n${keepTail(out(stderr))}`);
          const body = parts.length > 0 ? parts.join("\n\n") : "(no output)";
          resolve(code === 0 ? body : `${body}\n\nCommand exited with code ${code ?? "unknown"}`);
        });
      });
    });
  },
};

const TOOLS: CliTool[] = [readTool, writeTool, editTool, shellTool];
const BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.function.name, tool]));

/** A `ToolHost` backed by the CLI's own tools. */
export function createToolHost(options: { cwd: string }): ToolHost {
  return {
    definitions: () => TOOLS.map((tool) => tool.definition),

    async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
      const tool = BY_NAME.get(call.function.name);
      if (!tool) {
        throw new Error(
          `unknown tool "${call.function.name}". Available: ${[...BY_NAME.keys()].join(", ")}`,
        );
      }

      let args: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("arguments must be a JSON object");
        }
        args = parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error(`invalid arguments for ${call.function.name}: ${(error as Error).message}`);
      }

      if (signal.aborted) throw new Error("cancelled before the tool ran");
      return tool.run(args, { cwd: options.cwd, signal });
    },
  };
}

/** The verb shown on the activity line. The target is shown next to it. */
/**
 * Did this shell result end in a non-zero exit?
 *
 * A command that fails is not a tool that failed: `shell` ran, captured the
 * output and returned it, so the harness sees a result and the transcript
 * row is drawn as a success. The exit code is the only channel a failing
 * command has, and it is the last line of the text by a decision that is
 * pinned by a test — the model decides what to do next right there.
 *
 * So the row has to read it back. The match is the tool's own line — its
 * own text, preceded by the blank line the tool puts there — and nothing
 * else, because a command whose output happens to end with those words has
 * not exited non-zero and must not be painted as a failure. Only the `shell`
 * row is asked at all, so a `read` that contains the words is left alone.
 */
export function exitedNonZero(output: string): boolean {
  const match = /\n\nCommand exited with code (\d+|unknown)$/.exec(output.trimEnd());
  if (!match) return false;
  return match[1] !== "0";
}

export function toolLabel(name: string): string {
  switch (name) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "shell":
      return "$";
    default:
      return name;
  }
}
