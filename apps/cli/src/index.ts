#!/usr/bin/env node
import { FlagError, parseFlags, resolveCwd } from "./flags.js";

/**
 * Entry point.
 *
 * Everything interesting happens in `ui/App`; this file's job is to decide what
 * to render and to fail legibly when the terminal cannot host a TUI.
 *
 * Only `flags` is imported statically. Everything heavy — the config loader,
 * the session store, the print path, and above all the TUI (App, Ink, React,
 * the harness they pull in) — is imported dynamically in the branch that needs
 * it. `--version` and `--help` return before any of it loads, so they answer in
 * the time it takes to start Node instead of paying to evaluate the whole
 * dependency tree on every invocation.
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

Bring your own provider (BYOK). On first run the CLI walks you through
adding one — sign in with Claude or ChatGPT, or paste an API key for any
OpenAI-compatible or Anthropic endpoint. Manage them any time with /provider or
/setup. For one run, ACTOR0_BASE_URL / ACTOR0_API_KEY / ACTOR0_MODEL override
the endpoint. Config lives in $XDG_CONFIG_HOME/actor0; sessions in
$XDG_DATA_HOME/actor0. Set ACTOR0_DISABLE_MOUSE=1 to turn off mouse capture
(keeps keyboard scroll, restores terminal-native copy-paste).
`;

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

  const cwd = resolveCwd(flags.cwd);

  const { ConfigError, loadConfig } = await import("./config.js");
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

  const { latestSession, loadSession } = await import("./session.js");
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
    const code = await runPrintTurn({
      prompt: flags.print,
      cwd,
      config,
      messages: restored?.messages ?? [],
      // A run against a restored session writes the exchange back to it — the
      // same contract the TUI has. Without one, the run stays stateless,
      // which is what a pipe wants.
      ...(restored ? { session: { id: restored.id, createdAt: restored.createdAt } } : {}),
    });
    process.exitCode = code;
    return;
  }

  // The TUI — the only path that needs Ink, React, the harness and the renderer.
  // Booted through its own module so the bundler can split it into one file the
  // fast paths never load (see ui/tui-bootstrap.ts).
  const { bootTui } = await import("./ui/tui-bootstrap.js");
  const waitUntilExit = await bootTui({
    cwd,
    config,
    version: await readVersion(),
    stdin: process.stdin,
    ...(restored
      ? {
          resumed: {
            id: restored.id,
            createdAt: restored.createdAt,
            updatedAt: restored.updatedAt,
            messages: restored.messages,
          },
        }
      : {}),
  });
  await waitUntilExit();
}

main().catch((error: unknown) => {
  // A bad command line is not a crash, and saying so is the whole difference
  // between a user who fixes the typo and one who thinks the tool is broken.
  if (error instanceof FlagError) {
    process.stderr.write(`actor0: ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
