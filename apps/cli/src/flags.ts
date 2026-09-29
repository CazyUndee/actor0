/**
 * Command-line parsing.
 *
 * This lives apart from `index.ts` for one reason: the entry point runs `main`
 * on import, so a parser sitting in it could not be unit tested at all — which
 * is the reason it went unnoticed that every malformed invocation did
 * something *other* than what was asked, quietly.
 *
 * The rule throughout is that a flag either does what it says or stops the
 * program. `actor0 --session` with no id used to resume the most recent
 * session instead of failing, so a user who mistyped one character got a
 * different conversation and no indication of it. `--modle gpt` was discarded
 * without a word, and `hello` — a stray word, almost certainly a forgotten
 * prompt — launched a TUI that looked like it had ignored them.
 */
import { resolve } from "node:path";

export type Flags = {
  new: boolean;
  help: boolean;
  version: boolean;
  sessions: boolean;
  session?: string;
  cwd?: string;
  print?: string;
};

export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagError";
  }
}

/** Flags that take a value, and what to call it when the value is missing. */
const TAKES_VALUE: Record<string, string> = {
  "--session": "an id",
  "--cwd": "a path",
  "--print": "a prompt",
  "-p": "a prompt",
};

/**
 * Parse `argv` (without the node/script prefix).
 *
 * Throws `FlagError` rather than guessing. Every fallible case here is one
 * where a reasonable-looking default would be a *different* conversation, a
 * different directory, or a different model than the one that was asked for,
 * and the user would have no way to tell.
 */
export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { new: false, help: false, version: false, sessions: false };

  // Everything after `--` is the prompt, verbatim. Without this there is no way
  // to send a prompt that starts with a dash, which is a quiet failure of its
  // own: the command errors and the user has no idea why.
  const separator = argv.indexOf("--");
  if (separator !== -1) {
    const rest = argv.slice(separator + 1).join(" ").trim();
    if (rest) flags.print = rest;
    argv = argv.slice(0, separator);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg in TAKES_VALUE) {
      const value = argv[i + 1];
      // A missing value, or one that is really the next flag, means the
      // command line was cut short. Both used to fall through to a default.
      if (value === undefined || value.startsWith("-")) {
        throw new FlagError(`${arg} needs ${TAKES_VALUE[arg]}. Try: actor0 --help`);
      }
      if (arg === "--session") flags.session = value;
      else if (arg === "--cwd") flags.cwd = value;
      else flags.print = value;
      i += 1;
      continue;
    }

    switch (arg) {
      case "--new":
        flags.new = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--version":
      case "-v":
        flags.version = true;
        break;
      case "--sessions":
        flags.sessions = true;
        break;
      case "--":
        // Unreachable: the separator is consumed before this loop.
        break;
      default:
        // A near-miss on a real flag gets a suggestion; a stray word gets
        // told what to do with it. Both used to vanish.
        throw new FlagError(unknownMessage(arg, [...Object.keys(TAKES_VALUE), "--new", "--help", "-h", "--version", "-v", "--sessions"]));
    }
  }

  // These both pick a conversation, and picking both is ambiguous: whichever
  // won would be decided by code the user cannot see.
  if (flags.new && flags.session !== undefined) {
    throw new FlagError("--new and --session contradict each other. Pick one.");
  }
  if (flags.new && flags.print !== undefined) {
    throw new FlagError("--new and --print contradict each other. Pick one.");
  }

  return flags;
}

/** The nearest real flag, by edit distance, or undefined if nothing is close. */
export function nearestFlag(arg: string, known: string[]): string | undefined {
  const distance = (a: string, b: string): number => {
    const rows: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = rows[0]!;
      rows[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const temp = rows[j]!;
        rows[j] = Math.min(
          rows[j]! + 1,
          rows[j - 1]! + 1,
          previous + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        previous = temp;
      }
    }
    return rows[b.length]!;
  };
  const bare = arg.replace(/^-+/, "");
  if (!bare) return undefined;
  let best: { flag: string; score: number } | undefined;
  for (const flag of known) {
    const score = distance(bare, flag.replace(/^-+/, ""));
    if (!best || score < best.score) best = { flag, score };
  }
  // Two edits, and no more. Every real typo found so far is one transposition
  // or one dropped character; at three, `--zzz` starts matching `--new`, and
  // a confident wrong suggestion is worse than saying "unknown".
  return best && best.score <= 2 ? best.flag : undefined;
}

function unknownMessage(arg: string, known: string[]): string {
  if (!arg.startsWith("-")) {
    return `unexpected argument ${JSON.stringify(arg)}. To send it as a prompt, use: actor0 -p ${JSON.stringify(arg)}`;
  }
  const near = nearestFlag(arg, known);
  return near
    ? `unknown flag ${arg}. Did you mean ${near}?`
    : `unknown flag ${arg}. Try: actor0 --help`;
}

/** The directory tools are rooted at, resolved and absolute. */
export function resolveCwd(flag: string | undefined): string {
  if (!flag) return process.cwd();
  return resolve(flag);
}
