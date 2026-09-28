# actor0 — CLI

A terminal client for the [Actor0](../../ARCHITECTURE.md) harness. It is a
*consumer* of the harness, not part of it: it supplies the four ports and owns
everything a human touches.

```bash
npm install
npm run build
node apps/cli/dist/index.js
```

There is nothing to set up. The CLI talks to one endpoint,
`https://aestral-chat.vercel.app/api/chat`, which holds its own credential and
expects no API key. The only thing worth remembering is the model.

## Configuration

| Setting   | File      | Environment      |
| --------- | --------- | ---------------- |
| Model     | `model`    | `ACTOR0_MODEL`   |
| Models used so far | `models` | —            |

A `config.json` written by an older build is still read: its
`provider.model` is honoured and everything else in it is ignored. That keeps
an existing install working without asking anyone to hand-edit a file, and it
means a stale `baseUrl` can no longer send traffic anywhere.

There was once a `--provider` flag, a preset table, and a setup wizard. They
are gone, and the reason is worth recording: a stored `baseUrl` for a host
that required a credential outlived the reason it had been written, a request
went to that host anyway, and every visible signal — the model name, the
footer, the absence of an error — still said the right provider was in use.
The endpoint is now a constant in `src/providers.ts`, and a test asserts that
a config file naming a different host cannot change it.

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

## Slash commands

Deliberately five.

| Command          | Effect                                   |
| ---------------- | ---------------------------------------- |
| `/help`          | list commands and key bindings           |
| `/clear`         | start a new conversation                |
| `/model`          | list the models used so far            |
| `/model <name>`  | switch to a model by name              |
| `/quit`          | exit — `Ctrl+D` does the same            |

`Esc` cancels a running turn. `Ctrl+C` cancels a turn, and exits when there is
nothing to cancel. `↑`/`↓` walk input history.

## Built-in tools

Four, and none of them ask. Paths are relative to the working directory, and
shell commands run there.

| Tool    | Notes                                                                 |
| ------- | --------------------------------------------------------------------- |
| `read`  | `offset`/`limit` for paging; caps at 2000 lines / 50 kB and names the offset to resume at |
| `write` | creates parent directories, replaces the whole file without asking       |
| `edit`  | replaces one exact string; CRLF and BOM handled; fails on 0 or ambiguous matches |
| `bash`  | runs a shell command; output capped keeping the tail; no timeout unless asked (seconds, max 3600) |

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
- the system prompt tells the model that `bash` can do anything the user can,
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

## How it uses CronixUI

**It consumes CronixUI's design tokens, not its components.** That is a
finding, not a preference, and it is worth being precise about why.

CronixUI is a React/CSS toolkit. Its published package is 136 `.tsx` components
and stylesheets against a browser bundle — there is no ANSI handling, no
`readline`, no `stdout` path anywhere in it, and no terminal primitive of any
kind. Its components render DOM nodes against a stylesheet, so they cannot
draw to a terminal.

What CronixUI *does* publish reliably is its token stylesheet, and that is a
genuine design language: the dark base, the crimson accent, four surface steps,
a nine-step type scale, and a spacing rhythm.

So `scripts/generate-theme.mjs` reads the **installed** package's
`variables.css`, composites every translucent token onto `--cn-bg` — a terminal
cell cannot be translucent, and this is what makes `rgba(255,255,255,0.08)`
look the same here as it does on the web — and writes `src/theme.generated.ts`.
CI runs the generator in `--check` mode, so a CronixUI release that moves the
palette fails the build instead of drifting silently.

No literal colour appears anywhere in the UI source; components reference
semantic roles from `src/theme.ts`, which is the only file that maps a token to
a meaning.

Two known packaging problems in `cronixui@1.1.5`, worth fixing at the source:

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
