#!/usr/bin/env node
import { render } from "ink";
import { createElement } from "react";
import { ConfigError, loadConfig } from "./config.js";
import { latestSession, loadSession } from "./session.js";
import { App } from "./ui/App.js";

/**
 * Entry point.
 *
 * Everything interesting happens in `ui/App`; this file's job is to decide what
 * to render and to fail legibly when the terminal cannot host a TUI.
 */

const HELP = `actor0 — a terminal client for the Actor0 harness

Usage
  actor0                 start a conversation, resuming the last session
  actor0 --new           start a fresh session
  actor0 --session <id>  resume a specific session
  actor0 --sessions      list saved sessions
  actor0 --cwd <path>    run with tools rooted at <path>
  actor0 -p <prompt>     run one turn, print the answer, exit (no TUI)
  actor0 --version       print the version
  actor0 --help          print this

The endpoint is fixed and needs no API key, so there is nothing to configure
but the model. ACTOR0_MODEL overrides the model for one run. Config lives in
$XDG_CONFIG_HOME/actor0; sessions in $XDG_DATA_HOME/actor0.
`;

type Flags = {
  new: boolean;
  help: boolean;
  version: boolean;
  sessions: boolean;
  session?: string;
  cwd?: string;
  print?: string;
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { new: false, help: false, version: false, sessions: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--new") flags.new = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (arg === "--sessions") flags.sessions = true;
    else if (arg === "--session") flags.session = argv[++i];
    else if (arg === "--cwd") flags.cwd = argv[++i];
    else if (arg === "--print" || arg === "-p") flags.print = argv[++i];
  }
  return flags;
}

async function readVersion(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }
  if (flags.sessions) {
    const { listSessions } = await import("./session.js");
    const sessions = listSessions();
    if (sessions.length === 0) {
      process.stdout.write("no saved sessions\n");
      return;
    }
    for (const session of sessions.slice(0, 20)) {
      process.stdout.write(`${session.id}  ${session.updatedAt}  ${session.messages.length} messages  ${session.model}\n`);
    }
    return;
  }

  if (!process.stdout.isTTY && flags.print === undefined) {
    process.stderr.write("actor0 needs an interactive terminal. Run it directly, or use -p <prompt> for one turn.\n");
    process.exitCode = 1;
    return;
  }

  const cwd = flags.cwd ? (await import("node:path")).resolve(flags.cwd) : process.cwd();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const restored = flags.new
    ? undefined
    : flags.session
      ? loadSession(flags.session)
      : latestSession();

  if (flags.session && !restored) {
    process.stderr.write(`no saved session with id ${flags.session}. Try: actor0 --sessions\n`);
    process.exitCode = 1;
    return;
  }

  if (flags.print !== undefined) {
    const { runPrintTurn } = await import("./print.js");
    const code = await runPrintTurn({ prompt: flags.print, cwd, config, messages: restored?.messages ?? [] });
    process.exitCode = code;
    return;
  }

  const instance = render(
    createElement(App, {
      cwd,
      config,
      version: await readVersion(),
      ...(restored
        ? { resumed: { id: restored.id, updatedAt: restored.updatedAt, messages: restored.messages } }
        : {}),
    }),
    // Ctrl+C is handled in the app: it cancels a running turn first and only
    // exits when there is nothing to cancel.
    { exitOnCtrlC: false },
  );

  await instance.waitUntilExit();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
