# Actor0

Actor0 is a small, auditable **agent harness** with a terminal client. The harness
owns the reusable runtime — conversation state, streaming, bounded retries,
partial-attempt rewind, status and plan extraction, reasoning summaries,
tool-call rounds, usage events, completion detection — while a thin client
supplies the model connection, the tools, the prompts and the view.

The CLI is **bring-your-own-key (BYOK)** only and talks to whichever provider the
user picks, over three transports: OpenAI-compatible Chat Completions,
Anthropic Messages, and OpenAI Responses (ChatGPT/Codex). OAuth sign-in (Claude
Code, ChatGPT/Codex) and a first-run wizard wire the keys in. The harness ships
no host, no key, and no model catalog of its own.

## Workspace

- `packages/harness` — transport-neutral TypeScript runtime and protocol types.
- `packages/providers` — the three transports, parameterised by the same
  provider-auth shape.
- `apps/cli` — a terminal client that consumes the harness, and exists to prove
  the extraction boundary holds. See [apps/cli/README.md](apps/cli/README.md).

The public project contains no product provider registry, fallback routing,
built-in model catalog, proprietary tool implementation, memory/storage
subsystem, billing code, or application prompt library.

## The CLI

`apps/cli` is a working agent in a terminal: streamed output, tool activity,
cancellation, slash commands, and session persistence across launches. It talks
to any of the three transports and hard-codes no provider.

It is a consumer, not a component. It supplies the four harness ports — a
`ToolHost`, an `HarnessObserver`, a `ToolRoundPolicy`, and configuration — and
the harness has no idea it exists. That is the point: if a program outside
`packages/harness` can build a usable agent from the public API alone, the
boundary in [ARCHITECTURE.md](ARCHITECTURE.md) is real.

## Tools

Eight, and none of them ask. Paths are relative to the working directory and
shell commands run there; every path is resolved and refused if it leaves that
directory.

| Tool    | Effect                                                                   |
| ------- | ------------------------------------------------------------------------ |
| `read`  | `offset`/`limit` paging; caps at 2000 lines / 50 kB with a named offset  |
| `write` | creates parent directories; replaces the whole file                      |
| `edit`  | one exact string; CRLF and BOM safe; fails on 0 or ambiguous matches     |
| `shell` | a shell command; output capped to the tail; no default timeout           |
| `rg`    | ripgrep-backed search; lines or counts, with `include`/`exclude` globs  |
| `glob`  | a directory listing; does not descend into `node_modules`              |
| `task`  | runs a sub-turn of tool rounds as its own agent                          |
| `skill` | runs an LLM skill (frontmatter + body in `.claude/skills/`)             |

There is no approval dialog. What replaces it is containment enforced in code
rather than promised in a prompt — see [apps/cli/README.md](apps/cli/README.md).

## Install and verify

```bash
npm install
npm run check:boundaries
npm run check:theme
npm run typecheck
npm test
npm run lint
npm run build
```

## Harness behavior

The reusable TypeScript harness preserves behavior that was distributed through the source application:

- streamed answer and reasoning events;
- non-blocking status-line filtering;
- leading plan-block extraction;
- reasoning title/summary formatting;
- bounded exponential retries;
- visible-output rewind before retry;
- idle-stream timeout;
- bounded tool rounds with results fed back to the model;
- one empty-response continuation;
- incomplete-stream reporting;
- token usage events.

See [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and extension points.

## License

MIT
