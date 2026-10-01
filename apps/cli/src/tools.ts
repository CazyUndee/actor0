import type { ToolCall, ToolDefinition, ToolHost } from "@actor0/harness";
import { readFile, readdir, realpath, stat, writeFile, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname, sep } from "node:path";
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
  /**
   * What the tool is for, in one clause, for the prompt's tool-choice sentence.
   *
   * Required rather than optional, so that a new tool cannot be registered
   * without saying what it is for. That sentence used to be written out by
   * hand in the prompt, which is how it came to say four tools after a fifth
   * was added, and to keep routing searching to the shell after a tool was
   * added to do exactly that.
   */
  hint: string;
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
 * Bytes examined when deciding whether a file is binary.
 *
 * Git uses 8000 and so does this: the answer is settled long before it, and
 * reading the head means a 400MB video costs one small read instead of the
 * whole thing decoded to a string.
 */
const BINARY_SNIFF_BYTES = 8_000;

/**
 * Why `path` cannot be read as text, or undefined when it can.
 *
 * A NUL byte in the first few KB is the same test git uses, and it is the one
 * that matters here because of what it does to UTF-16: that encoding puts a NUL
 * between every ASCII character, so a perfectly readable file decodes to
 * `h\0e\0l\0l\0o\0` — which looks like text to a model and is read as if it
 * were. Refusing it with a message that names the possibility is strictly better
 * than returning that.
 *
 * Claude Code makes the same call, by file extension instead, and with the same
 * result: a picture is refused before it is read rather than returned as
 * `\ufffdPNG\r\n\u001a\n`. The extension test misses every binary with no
 * extension and every text file that merely looks binary; this one needs no
 * list to rot.
 */
async function binaryReason(target: string, asked: string): Promise<string | undefined> {
  const handle = await open(target, "r");
  try {
    const head = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, (await handle.stat()).size || BINARY_SNIFF_BYTES));
    const read = await handle.read(head, 0, head.length, 0);
    const at = head.subarray(0, read.bytesRead).indexOf(0);
    if (at === -1) return undefined;
    return (
      `${asked} is not text: a NUL byte at offset ${at}. That is what a binary looks like ` +
      `decoded as UTF-8, and it can also mean the file is UTF-16. This tool returns UTF-8 text. ` +
      `Use the shell tool instead — \`file ${asked}\` to identify it, or \`iconv -f UTF-16 ${asked}\` to convert it.`
    );
  } finally {
    await handle.close();
  }
}

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
  hint: "reading a file (paged; it names the offset to continue at)",
  async run(args, ctx) {
    const target = await within(ctx.cwd, requireString(args, "path"));
    const info = await stat(target);
    if (info.isDirectory()) throw new Error(`${target} is a directory — list it with the shell tool, or read a file inside it`);
    const asked = String(args.path ?? target);
    const notText = await binaryReason(target, asked);
    if (notText) throw new Error(notText);

    const raw = await readFile(target, "utf8");
    // An empty file is a fact, not a failure. Returning nothing here makes an
    // empty file indistinguishable from a read that produced no output, and a
    // model that cannot tell those apart either retries it or invents contents.
    if (raw.length === 0) return "(the file is empty: 0 bytes)";
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
  hint: "a new file, or a whole-file rewrite",
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
  hint: "changing part of an existing file (exact string match; it fails loudly rather than clobbering)",
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
    // The replacement is data, not a replacement pattern. `replace`
    // with a plain string reads $$, $&, $' and $` in the new text as
    // its own syntax and rewrites them — a shell script's `echo $$`
    // would land as `echo $`, a regex's `$&` as the text that was
    // matched, and the file would be wrong with no error anywhere.
    // Splitting on the needle and joining on the new text inserts it
    // verbatim, and in this branch there is exactly one occurrence, so
    // the two are the same replacement. Claude Code's edit wraps its
    // replacement in `() => replace` for the same reason.
    const updated = content.split(before).join(after);
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
  hint: "everything else — git, test runners, package managers",
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

/**
 * A string that may be absent.
 *
 * `requireString` rejects an empty value, which is right for a path and wrong
 * for a parameter the caller may legitimately omit or send as `""`. Used by
 * `grep`, whose `path`, `include` and `output_mode` are all optional.
 */
function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`parameter "${key}" must be a string`);
  return value;
}

// --- grep -------------------------------------------------------------------

/**
 * Directories a search never descends into.
 *
 * `node_modules` and `.git` are the two that are both enormous and never what
 * was asked for. Everything else — `dist`, `build`, `target` — is left alone,
 * because sometimes the answer really is in the build output, and a tool that
 * quietly hides directories is worse than one that searches too much.
 */
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

/**
 * How many files to open before giving up, and say so.
 *
 * A search over a home directory or a filesystem root has no natural end, and
 * a tool that can be made to hang is a tool the model will eventually hang on.
 */
const MAX_SEARCH_FILES = 20_000;

/** Results before the answer is cut, unless the caller asked for more. */
const DEFAULT_HEAD_LIMIT = 250;

/** What `grep` was asked to hand back. */
type GrepMode = "files_with_matches" | "content" | "count";

/**
 * Translate a glob into a regular expression.
 *
 * A doubled star followed by a slash crosses directories; a single star and a
 * question mark do not. Everything else is literal — so this cannot be the
 * glob with its stars left in place, because the dot in `*.ts` has to stay a
 * dot.
 *
 * The result is always anchored, because both callers hand it a whole name or
 * a whole path and ask whether that is the thing. It was not, and the
 * unanchored form quietly matched inside longer names: `*.ts` included
 * `parts.tsx`, and a test pinned that as correct, so a model asking for the
 * TypeScript was handed the JSX too.
 *
 * Whether a slashless glob is matched against the file name as well as the
 * path is the caller's business, and it is why the caller's second pattern
 * exists at all. That is the reading ripgrep and gitignore both use, and the
 * only one under which the `*.ts` that everybody actually writes reaches
 * `apps/cli/ui/parts.tsx`.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** One file to search, and the path to show the model for it. */
type SearchFile = { abs: string; rel: string };

/**
 * Every file under `dir`, each with its path relative to `base`.
 *
 * The absolute path is carried alongside the display path rather than being
 * reconstructed by joining the two: `base` and `dir` need not share a prefix
 * once the caller has scoped the search to a subdirectory, and a path built by
 * joining is then a path to some file that does not exist.
 */
async function* eachFile(dir: string, base: string): AsyncGenerator<SearchFile> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* eachFile(full, base);
      continue;
    }
    // A symlink can point at its own ancestor, so following one turns a search
    // into an infinite walk — and it can also step outside the directory the
    // caller confined the search to.
    if (!entry.isFile()) continue;
    yield { abs: full, rel: relative(base, full).split(sep).join("/") };
  }
}

/**
 * A NUL in the first chunk of a file means it is not text.
 *
 * The test git uses, for the same reason: UTF-16 text is full of them and would
 * otherwise match a pattern often enough to look like a real hit. `read`
 * refuses these by extension and by content; a search has no extension list to
 * go on, so it is the content test alone.
 */
function looksBinary(head: string): boolean {
  return head.includes("\0");
}

/**
 * What a search owes the model when it did not look at everything.
 *
 * An empty result meaning "I read 4,000 files and nothing matched" is a
 * different instruction to the model than one meaning "I could not read
 * anything", and collapsing them into a bare "no matches" is how a model
 * answers from its own memory with total confidence. So the number of files
 * actually searched is stated on the empty case, and the count of binary files
 * skipped is stated always — a pattern that only occurs inside a compiled
 * binary has to read as not-found rather than as not-looked-at.
 */
function grepScope(scanned: number, binary: number, limited: boolean): string {
  const bits = [`searched ${scanned.toLocaleString("en-US")} file${scanned === 1 ? "" : "s"}`];
  if (binary > 0) bits.push(`skipped ${binary} binary file${binary === 1 ? "" : "s"}`);
  if (limited) bits.push(`stopped at the ${MAX_SEARCH_FILES.toLocaleString("en-US")}-file limit`);
  return `[${bits.join(", ")}]`;
}

const grepTool: CliTool = {
  definition: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents with a regular expression and get back the matching paths, the matching lines with context, or the match counts. Prefer this to grep, rg or find in the shell: the same search then behaves identically on every platform, needs no quoting, and cannot stall behind a shell that has no grep at all. The pattern is a JavaScript regular expression rather than a glob or a literal, so escape what is only special to regex (write \\{ for a literal brace). An include glob with no slash in it matches the file name, so *.ts reaches apps/cli/ui/parts.tsx. With multiline set, a match is reported at the line it starts on. Skips .git and node_modules.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression to search for." },
          path: { type: "string", description: "A file or directory to search. Defaults to the whole working directory." },
          include: { type: "string", description: "Only search paths matching this glob, e.g. \"*.ts\" or \"apps/**/test.ts\"." },
          output_mode: {
            type: "string",
            enum: ["files_with_matches", "content", "count"],
            description: "What to return: matching paths (the default), matching lines with context, or the number of matching lines per file.",
          },
          context: { type: "number", description: "Lines to show either side of each match, for output_mode \"content\". Defaults to 0." },
          case_insensitive: { type: "boolean", description: "Match without regard to case. Defaults to false." },
          multiline: {
            type: "boolean",
            description: "Let the pattern cross line ends, and make ^ and $ match at line boundaries. Defaults to false.",
          },
          head_limit: { type: "number", description: `Stop after this many results. Defaults to ${DEFAULT_HEAD_LIMIT}.` },
        },
        required: ["pattern"],
      },
    },
  },
  label: (args) => `grep ${String(args.pattern ?? "")}`,
  hint: "searching inside files",
  async run(args, ctx) {
    const pattern = requireString(args, "pattern");
    const scope = optionalText(args, "path") || ".";
    const root = await within(ctx.cwd, scope);
    const mode = (optionalText(args, "output_mode") || "files_with_matches") as GrepMode;
    if (!["files_with_matches", "content", "count"].includes(mode)) {
      throw new Error(`output_mode must be files_with_matches, content or count, not ${mode}`);
    }
    const context = Math.max(0, Math.floor(Number(args.context ?? 0)) || 0);
    const caseInsensitive = args.case_insensitive === true;
    const multiline = args.multiline === true;

    // `g` only when the pattern may cross lines, because a global regex is
    // stateful and `test()` on one advances `lastIndex` — which turns a
    // line-by-line scan into one that silently matches every other line.
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern, `${caseInsensitive ? "i" : ""}${multiline ? "gm" : ""}`);
    } catch (error) {
      throw new Error(
        `pattern is not a valid regular expression: ${pattern} (${(error as Error).message})`,
      );
    }

    const glob = optionalText(args, "include");
    const wholePath = glob === undefined ? undefined : globToRegExp(glob);
    const fileNameOnly =
      glob !== undefined && !glob.includes("/") ? globToRegExp(glob) : undefined;
    const inScope = (rel: string): boolean => {
      if (!wholePath) return true;
      if (wholePath.test(rel)) return true;
      if (!fileNameOnly) return false;
      const slash = rel.lastIndexOf("/");
      return fileNameOnly.test(slash === -1 ? rel : rel.slice(slash + 1));
    };

    const asked = Math.floor(Number(args.head_limit ?? DEFAULT_HEAD_LIMIT));
    const headLimit = Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_HEAD_LIMIT;

    // Real paths, or the display paths come out as a chain of `../..`. The
    // temp directory is the usual culprit: it is a symlink on macOS, so `cwd`
    // and the path `within` resolved are different strings for one folder.
    const base = await realpath(ctx.cwd).catch(() => ctx.cwd);
    const rootIsDirectory = await stat(root)
      .then((info) => info.isDirectory())
      .catch(() => {
        throw new Error(`path does not exist: ${scope}`);
      });

    const seen: SearchFile[] = [];
    if (rootIsDirectory) {
      for await (const file of eachFile(root, base)) seen.push(file);
    } else {
      seen.push({ abs: root, rel: relative(base, root).split(sep).join("/") });
    }
    const files = seen.filter((file) => inScope(file.rel));

    const out: string[] = [];
    const notes: string[] = [];
    const cutLines: number[] = [];
    let scanned = 0;
    let binary = 0;
    let limited = false;
    let stopped = false;

    for (const file of files) {
      if (out.length >= headLimit) {
        stopped = true;
        break;
      }
      if (scanned >= MAX_SEARCH_FILES) {
        limited = true;
        break;
      }
      scanned += 1;
      let text: string;
      try {
        text = await readFile(file.abs, "utf8");
      } catch {
        // A file that vanished between listing and reading is not a failure of
        // the search, and reporting it as one would be noise.
        continue;
      }
      if (looksBinary(text.slice(0, 8_000))) {
        binary += 1;
        continue;
      }

      const lines = text.split("\n");
      /** The lines a match starts on. */
      const matched = new Set<number>();
      /** Matches counted apart, because two of them can start on one line. */
      let found = 0;

      if (multiline) {
        for (let m = matcher.exec(text); m !== null; m = matcher.exec(text)) {
          found += 1;
          matched.add(text.slice(0, m.index).split("\n").length - 1);
          // A zero-width match would otherwise spin on one index for ever.
          if (m[0].length === 0) matcher.lastIndex += 1;
        }
      } else {
        for (let i = 0; i < lines.length; i += 1) {
          if (!matcher.test(lines[i]!)) continue;
          found += 1;
          matched.add(i);
        }
      }
      if (found === 0) continue;

      if (mode === "files_with_matches") {
        out.push(file.rel);
        continue;
      }
      if (mode === "count") {
        out.push(`${file.rel}:${found}`);
        continue;
      }

      const shown = new Set(matched);
      for (const i of matched) {
        for (let near = i - context; near <= i + context; near += 1) {
          if (near >= 0 && near < lines.length) shown.add(near);
        }
      }
      // Sorted, because a Set iterates in insertion order — every match would
      // print before any of its own context.
      for (const i of [...shown].sort((a, b) => a - b)) {
        const isMatch = matched.has(i);
        // `path:12:text` for a match and `path-12-` for a context line: the
        // separator carries the line number either way, so a context line can
        // never read as a match by looking at the text alone.
        out.push(`${file.rel}${isMatch ? ":" : "-"}${i + 1}${isMatch ? ":" : "-"} ${lines[i] ?? ""}`);
      }
    }

    if (out.length === 0) {
      if (seen.length === 0) {
        return (
          `[searched 0 files] there is nothing to search at ${scope}, so nothing can ` +
          `match ${pattern}. Check that path names a real file or directory.`
        );
      }
      if (files.length === 0) {
        return (
          `[searched 0 files] include: ${glob} excluded all ${seen.length} file${seen.length === 1 ? "" : "s"} ` +
          `under ${scope}. Widen the glob or drop it.`
        );
      }
      return `No matches for ${pattern}. ${grepScope(scanned, binary, limited)}.`;
    }

    if (stopped) {
      notes.push(
        `[showing the first ${headLimit} of ${files.length.toLocaleString("en-US")} candidate files; ` +
          `raise head_limit, narrow the pattern, or set include to filter]`,
      );
    }
    const { text, lines: cut } = cutLongLines(out.join("\n"));
    cutLines.push(...cut);
    if (limited) notes.push(grepScope(scanned, binary, true));

    let body = text;
    if (body.length > MAX_OUTPUT_BYTES) {
      // The head, not the tail. A shell log puts its error last, so the tail is
      // the useful half; but a search is aimed at the *first* matches — the ones
      // nearest the pattern — and the tail of a grep is the alphabetically last
      // file in the tree.
      const cut = body.slice(0, MAX_OUTPUT_BYTES);
      const at = cut.lastIndexOf("\n");
      body = at > 0 ? cut.slice(0, at) : cut;
      notes.unshift(
        `[output truncated: kept the first ${body.length.toLocaleString("en-US")} of ` +
          `${text.length.toLocaleString("en-US")} characters, because the first matches are the ones ` +
          `the pattern was aimed at]`,
      );
    }
    if (cutLines.length > 0) notes.push(cutNotice(cutLines, "the file"));
    return notes.length > 0 ? withNotice(body, notes.join("\n")) : body;
  },
};

// --- glob -------------------------------------------------------------------

/** Results before the answer is cut, unless the caller asked for more. */
const DEFAULT_GLOB_LIMIT = 100;

/** One thing a walk found. `rel` is bare; the slash is added when printing. */
type Entry = { abs: string; rel: string; dir: boolean };

/**
 * The directory a pattern can only match inside.
 *
 * `apps/cli/*.ts` has an answer only under `apps/cli`, so the walk starts
 * there and the rest of the tree is never touched — on a repository with a
 * build output in it that is the difference between a few hundred directories
 * and a hundred thousand. This is the one part of Claude Code's implementation
 * worth carrying over, and it carries over whole because it is pure string
 * work: it reads the pattern, not the filesystem.
 *
 * It narrows the walk and nothing else. The pattern is still matched whole,
 * against the path the model is shown, because matching the shortened form
 * would turn `apps/cli/*.ts` into a match for `cli/*.ts` anywhere in the tree.
 */
function staticBase(pattern: string): string {
  const special = pattern.search(/[*?[{]/);
  const head = special === -1 ? pattern : pattern.slice(0, special);
  const cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  if (cut === -1) return ".";
  return pattern.slice(0, cut) || "/";
}

/**
 * Listing order: by path, case-insensitively, with the exact path as a
 * tie-break.
 *
 * Not by modification time, which is what Claude Code does, and the reason is
 * that a listing is a set the model then reasons over and narrows. Sorted by
 * time, the same call returns a different order on the next run — two files
 * swapped places because something touched them — and there is no way for the
 * model to tell a reordering from a different answer. Case-insensitive first
 * because a plain code-unit sort puts `README.md` above `apps/` and `bin/`
 * above `Commands/`, which is not how anyone reads a directory.
 */
function byPath(a: string, b: string): number {
  const folded = a.toLowerCase().localeCompare(b.toLowerCase());
  return folded !== 0 ? folded : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What a listing owes the model when it did not look at everything.
 *
 * The same rule as a search, and for the same reason: a capped list handed
 * over as if it were complete is how a model concludes a file does not exist
 * when it was below the cut. So the total is stated whenever the list is short
 * of it, and the number walked is stated when nothing matched at all — those
 * are different sentences and the model acts on them differently.
 */
function globScope(walked: number, matched: number, limited: boolean): string {
  if (matched === 0) {
    const seen = `${walked.toLocaleString("en-US")} entr${walked === 1 ? "y" : "ies"}`;
    return `[walked ${seen} under the search root, none matched]`;
  }
  const bits = [`${matched.toLocaleString("en-US")} path${matched === 1 ? "" : "s"} matched`];
  if (limited) bits.push(`stopped at the ${MAX_SEARCH_FILES.toLocaleString("en-US")}-entry walk limit`);
  return `[${bits.join(", ")}]`;
}

const globTool: CliTool = {
  definition: {
    type: "function",
    function: {
      name: "glob",
      description:
        "List files and directories by name pattern, without reading any of them. Prefer this to ls, dir, fd or find in the shell: it is the same listing on every platform, it needs no quoting, and it starts the walk at the fixed part of the pattern instead of at the whole tree. Directories come back with a trailing slash, so a bare name lists what is in a directory. A doubled star crosses directories and a single star does not; a pattern with no slash in it also matches the file name, so *.ts reaches apps/cli/ui/parts.tsx. Results are sorted by path, and the number matched is always reported, so a capped list cannot read as a complete one. Skips .git and node_modules.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob to match paths against, e.g. \"*.ts\", \"**/*.test.ts\" or \"apps/cli/src\".",
          },
          path: { type: "string", description: "A directory to search. Defaults to the whole working directory." },
          head_limit: { type: "number", description: `Stop after this many paths. Defaults to ${DEFAULT_GLOB_LIMIT}.` },
        },
        required: ["pattern"],
      },
    },
  },
  hint: "listing files by name",
  label: (args) => `glob ${String(args.pattern ?? "")}`,
  async run(args, ctx) {
    const pattern = requireString(args, "pattern");
    const scope = optionalText(args, "path") || ".";
    const root = await within(ctx.cwd, scope);

    const asked = Math.floor(Number(args.head_limit ?? DEFAULT_GLOB_LIMIT));
    const limit = Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_GLOB_LIMIT;

    // Real paths, for the same reason `grep` resolves them: `within` resolves
    // and `ctx.cwd` does not, so a display path built from the raw cwd is a
    // chain of `../..` on any tree whose root is a link.
    const base = await realpath(ctx.cwd).catch(() => ctx.cwd);
    const searchRoot = staticBase(pattern);
    const start = await within(root, searchRoot);
    const startIsDirectory = await stat(start)
      .then((info) => info.isDirectory())
      .catch(() => {
        throw new Error(
          `${pattern} names a directory that does not exist: ${searchRoot}`,
        );
      });
    if (!startIsDirectory) {
      throw new Error(
        `${searchRoot} is a file, not a directory, so ${pattern} has nothing to list. `
        + `Use read for a file.`,
      );
    }

    // Directories are matched on their bare path and printed with a slash. The
    // slash is a display convention and nothing else: `apps/cli` asked for as
    // a path is the directory, and an anchored match against `apps/cli/`
    // misses every directory in the tree.
    const bare = pattern.replace(/\/+$/, "");
    const wholePath = globToRegExp(bare);
    const fileNameOnly = bare.includes("/") ? undefined : globToRegExp(bare);
    const inScope = (rel: string): boolean => {
      if (wholePath.test(rel)) return true;
      if (!fileNameOnly) return false;
      const slash = rel.lastIndexOf("/");
      return fileNameOnly.test(slash === -1 ? rel : rel.slice(slash + 1));
    };

    const found: string[] = [];
    let walked = 0;
    let matched = 0;
    let limited = false;
    /** Directories the walk listed but did not look inside. */
    const skipped = new Set<string>();

    // The walk starts inside the pattern's own directory, so that directory is
    // never yielded to itself and `glob("apps/cli")` finds nothing — which is
    // the most natural listing there is, and the one a model reaches for first
    // when it has just been told where a file is. It is tested here instead.
    const selfRel = relative(base, start).split(sep).join("/");
    if (selfRel !== "" && inScope(selfRel)) {
      matched += 1;
      found.push(`${selfRel}/`);
      if (start !== base && SKIP_DIRECTORIES.has(selfRel.split("/").pop() ?? "")) {
        skipped.add(`${selfRel}/`);
      }
    }

    const walk = async function* (dir: string): AsyncGenerator<Entry> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Listed, and then not descended into. A search can hide a directory
          // with nothing lost: the answer is a match list, and a dependency
          // tree in it is noise. A listing cannot hide one, because the listing
          // is the answer — and one that omits `node_modules/` tells the model
          // the tree has no such thing. So the skip stops the descent, not the
          // existence, and the note below is what stops `node_modules/` from
          // reading as an empty folder.
          if (SKIP_DIRECTORIES.has(entry.name)) skipped.add(`${entry.name}/`);
          else yield* walk(full);
          // A directory is a result in its own right: a bare name listing is
          // how a model asks what is in a directory, and a listing with no
          // directories in it cannot answer that.
          yield { abs: full, rel: relative(base, full).split(sep).join("/"), dir: true };
          continue;
        }
        // A symlink can point at its own ancestor, so following one turns a
        // listing into an infinite walk, and it can also step outside the
        // directory the search was confined to.
        if (!entry.isFile()) continue;
        yield { abs: full, rel: relative(base, full).split(sep).join("/"), dir: false };
      }
    };

    for await (const entry of walk(start)) {
      walked += 1;
      if (walked > MAX_SEARCH_FILES) {
        limited = true;
        break;
      }
      if (!inScope(entry.rel)) continue;
      matched += 1;
      found.push(entry.dir ? `${entry.rel}/` : entry.rel);
    }

    if (matched === 0) {
      if (walked === 0) {
        return (
          `[walked 0 entries] there is nothing under ${scope}, so nothing can match ` +
          `${pattern}. Check that path names a real directory.`
        );
      }
      return `No path matches ${pattern}. ${globScope(walked, matched, limited)}.`;
    }

    found.sort(byPath);
    const shown = found.slice(0, limit);
    const notes: string[] = [];
    if (matched > shown.length) {
      notes.push(
        `[showing ${shown.length} of ${matched.toLocaleString("en-US")} matches; narrow the ` +
          `pattern, or set path to the subtree you meant]`,
      );
    }
    // Only the ones that are actually in the answer. A note about a
    // directory this result does not contain makes the output depend on the
    // rest of the tree rather than on the question, so `glob("README.md")`
    // would come back with a footnote about node_modules.
    const listed = [...skipped].filter((path) => shown.includes(path)).sort(byPath);
    if (listed.length > 0) {
      notes.push(
        `[listed but not searched: ${listed.join(", ")}; `
          + `set path to one of them to look inside]`,
      );
    }
    if (limited) notes.push(globScope(walked, matched, true));

    const body = shown.join("\n");
    return notes.length > 0 ? withNotice(body, notes.join("\n")) : body;
  },
};

const TOOLS: CliTool[] = [readTool, writeTool, editTool, grepTool, globTool, shellTool];

/**
 * How many tools the CLI offers, for the prompt to count out loud.
 *
 * The prompt is the one place a model is told what it has, so a count written
 * there is a claim about the registry, and it was written by hand. Adding a
 * tool and not editing that number leaves the prompt asserting something false
 * about the thing the model has to decide with, and nothing fails: the tool
 * is in the request, the tests are green, and the model believes it has four.
 */
export const TOOL_COUNT = TOOLS.length;

/**
 * One sentence naming every tool and what it is for, in the registry's order.
 *
 * The registry is the only list of tools there is, so this is derived from it
 * rather than transcribed. The hand-written version had drifted in two ways at
 * once — it named four tools when there were five, and it told the model to
 * use the shell for searching after a tool had been added to do exactly that.
 * A sentence assembled from the registry cannot describe a set of tools that
 * does not exist.
 */
export function toolChoiceSentence(): string {
  const each = TOOLS.map((tool) => `\`${tool.definition.function.name}\` for ${tool.hint}`);
  return `Tool choice: ${each.join(", ")}.`;
}

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
