# actor0 — CLI

A terminal client for the [Actor0](../../README.md) harness. It is a *consumer*
of the harness, not part of it: it supplies the four ports (tool host,
observer, round policy, config) and owns everything a human touches.

```bash
npm install
npm run build
node apps/cli/dist/index.js
```

## Providers

BYOK only. There is no baked-in host and no credential of our own — the user
supplies the connection. Four kinds, in the order the wizard offers them:

| Kind                 | Transport         | Auth            |
| -------------------- | ----------------- | --------------- |
| `claude`         | Anthropic Messages | OAuth or API key |
| `chatgpt`            | OpenAI Responses   | OAuth           |
| `openai-compatible`  | Chat Completions   | API key         |
| `anthropic-key`      | Anthropic Messages | API key         |

The first run walks through the wizard: pick a provider, sign in (OAuth opens
a browser loopback; an API key is read from the environment or entered), verify
it actually answers, and it is stored. `/provider` switches, signs in again,
adds another, or removes one. Subscription plans are read from the token at
sign-in and shown as labels, never hard-coded.

Custom endpoints fit the `openai-compatible` kind — any host that speaks
Chat Completions. The three first-party kinds are parameterised by the
constants in `src/provider-presets.ts`, whose header explains why a value that
merely looks plausible is worse than one that is obviously missing.

## Commands

```bash
actor0                  # resume the most recent session
actor0 --new            # start fresh
actor0 --session <id>   # resume a specific one
actor0 --sessions       # list what is saved
actor0 --cwd <path>     # root the built-in tools at <path>
actor0 -p "<prompt>"    # one turn, answer on stdout, no TUI
```

`-p` is the scriptable mode. The answer goes to stdout and progress goes to
stderr, so `actor0 -p "…" > answer.md` captures the answer and nothing else. It
shares the reducer, the tool host and the turn runner with the TUI, which makes
it the only way to check the live endpoint from CI — the TUI needs a terminal,
and "it renders" says nothing about whether the endpoint answers. The tools
behave exactly as they do in the TUI, because there is nothing about them that
needs a terminal.

## Configuration

| Setting   | File      | Environment      |
| --------- | --------- | ---------------- |
| Model     | `model`    | `ACTOR0_MODEL`   |
| API keys  | `providers[].apiKey` | `ACTOR0_API_KEY` (and provider-scoped keys) |

`config.json` is `0600` and lives next to the session store. OAuth tokens are
stored there too; a lone legacy `provider` block from an older build is read and
migrated into the `providers` list on first load, so an existing install keeps
working without anyone hand-editing a file. A legacy `baseUrl` no longer sends
traffic anywhere on its own — the endpoint is chosen by the active provider.

## Slash commands

Eight, with one-letter aliases.

| Command        | Alias | Effect                          |
| -------------- | ----- | ------------------------------- |
| `/provider`    | `/p`  | switch, sign in, add or remove  |
| `/setup`       | `/s`  | re-run the setup wizard         |
| `/model`       | `/m`  | list used models, switch model  |
| `/thinking`    | `/t`  | reasoning effort                |
| `/clear`       | `/c`  | start a new conversation        |
| `/usage`       | `/u`  | tokens and quota                |
| `/help`        | `/h`  | show commands and key bindings  |
| `/quit`        | `/q`  | exit — `Ctrl+D` does the same   |

`Esc` cancels a running turn. `Ctrl+C` cancels a turn, and exits when there is
nothing to cancel. `↑`/`↓` walk input history.

## Built-in tools

Eight, and none of them ask. Paths are relative to the working directory, and
shell commands run there.

| Tool    | Notes                                                                 |
| ------- | --------------------------------------------------------------------- |
| `read`  | `offset`/`limit` for paging; caps at 2000 lines / 50 kB and names the offset to resume at |
| `write` | creates parent directories, replaces the whole file without asking       |
| `edit`  | replaces one exact string; CRLF and BOM handled; fails on 0 or ambiguous matches |
| `shell` | runs a shell command; output capped keeping the tail; no timeout unless asked (seconds, max 3600) |
| `rg`    | ripgrep-backed; matching paths, matching lines with context, or per-file counts; `include`/`exclude` globs |
| `glob`  | lists a directory without descending into `node_modules`; a note names what it left alone |
| `task`  | runs a nested agent turn with its own tool rounds                    |
| `skill` | runs an LLM skill (frontmatter + body in `.claude/skills/`)          |

There is no approval dialog. There was one, and it was removed on purpose: a
gate that every command and every whole-file overwrite trips is a prompt the
user learns to dismiss without reading, which is worse than no gate at all.
What replaces it is containment, and it is enforced in code rather than
promised in a prompt —

- every path is resolved and refused if it leaves the working directory,
  including a sibling directory that merely shares a name prefix;
- `edit` refuses an ambiguous match instead of guessing which occurrence was
  meant, and refuses to write at all when the text is not found;
- results are capped, keeping the tail of shell output where errors are; a
  command runs to completion unless you pass `timeout`, and cancelling the
  turn kills the whole process tree it started;
- `rg`/`glob` do not descend into `node_modules` and `glob` says so, because
  an answer's shape must be a function of the question, not of the tree;
- the system prompt tells the model that `shell` can do anything the user can,
  and that a destructive or outward-facing command is not something it may
  infer from the general shape of the task.

That is a real trade, and it is a trade: run it where the blast radius is one
directory you can throw away.

## Project context

If an `AGENTS.md` (or `CLAUDE.md`) sits in the working directory or any
ancestor, it is loaded once at startup and appended to the system prompt as a
`<project_context>` block, nearest file first. That is the project's own
memory — where tests live, which package manager, what not to touch — and it
costs the model nothing to follow because it is already in context.

## Theming

**The UI is Ink; the palette is CronixUI's.** Two separate facts, often
conflated.

Ink (React for terminals) renders every component — there is no DOM, no CSS.
CronixUI is a React/CSS toolkit for the web and publishes no terminal
primitive, so it contributes *no* components. What it does publish is a real
design language: the dark base, the crimson accent, four surface steps, a
nine-step type scale, and a spacing rhythm, all as design tokens.

So `scripts/generate-theme.mjs` reads the **installed** package's
`variables.css`, composites every translucent token onto `--cn-bg` (a terminal
cell cannot be translucent, and this is what makes `rgba(255,255,255,0.08)`
look the same here as it does on the web), and writes
`src/theme.generated.ts`. CI runs the generator in `--check` mode, so a
CronixUI release that moves the palette fails the build instead of drifting
silently.

No literal colour appears anywhere in the UI source; components reference
semantic roles from `src/theme.ts`, which is the only file that maps a token to
a meaning. Two known packaging problems in `cronixui@1.1.5`, worth fixing at
the source:

- the root export's `types` points at `packages/web/src/cronixui.d.ts`, which is
  not published, so `import "cronixui"` has no types;
- `cronixui/react` and `cronixui/tokens` point at build output absent from the
  tarball, and the root `exports` map also blocks `cronixui/package.json`, so
  those subpaths cannot be resolved at all.

The CLI works around both by locating the package on disk rather than through
the resolver.

## Development

```bash
npm run dev -w @actor0/cli        # run from source
npm run preview -w @actor0/cli    # drive the TUI headlessly, no network needed
npm run gen:theme -w @actor0/cli  # regenerate the palette
```

`preview` renders the real app against a simulated TTY and a scripted mock
model, then prints the reconstructed screen at each step. It is how the
ungated tool rounds, `/clear`, transcript overflow, HTTP failure reporting, and
the retry rewind were verified without a live endpoint.

## Tests

`npm test -w @actor0/cli` covers:

- the conversation reducer, including that a `reset` clears streamed text so a
  retry never double-writes (the one piece of harness behaviour that is
  invisible unless the UI gets it exactly right);
- the tool host's containment — `../` escapes and prefix-sharing siblings are
  refused by all three file tools, and there is no approval path left to test;
- config precedence, `0600` permissions, session round-tripping;
- the transcript's layout arithmetic — path shortening and the row budget that
  decides which entries fit, both of which fail silently if wrong;
- end-to-end turns against a mock OpenAI-compatible SSE server, covering
  streaming, tool rounds, retry after a 500, and mid-stream cancel.

The POSIX-permission assertions skip on Windows, which has no POSIX mode bits;
CI runs them on Linux.
