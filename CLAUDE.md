@AGENTS.md


# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ground rules

The `@AGENTS.md` import above is the repository's working manual — commit
discipline, traps, and the six-check verification order. Follow it; it is
already in context, no need to go look for it.

## Commit messages

Every commit is exactly this shape:

```
[tag] one sentence: the impact, and how the commit achieves it

Body: the engineering detail, not a surface re-statement of the title.
Explain WHY the decision was made — the failure it prevents, the trap it
closes, the tradeoff taken. No verbosity: say the reasoning, not the
anecdote.

Co-Authored-By: Claude Code <noreply@anthropic.com>
Component: CLI          # or: Desktop
Model: <model id>      # the model that wrote the commit
```

- **Tag** (in front of the title, square brackets): `[fix]`, `[chore]`,
  `[feat]`, `[upgrade]`, or `[misc]` when none of the first four fit.
- **Title**: one sentence, exactly the impact + how — no "improve", no
  "update", no hedging.
- **Body**: WHY, at the engineering level. Why this shape and not the
  obvious alternative; what breaks if the decision is reversed later.
- **Trailer lines**: the co-author line always, then `Component:` naming
  which app the change is for (CLI or Desktop), then `Model:` with the
  exact model id that made the change.

Example:

```
[fix] stop() kills the detached watchdog first so a stop cannot be undone by its own timer

stopWatchdog() existed but was never wired: stop() brought the tunnel down,
the still-running watchdog saw the grace period elapse, and restarted the
tunnel within seconds. Calling it before stopTunnel() closes that loop.
Deleting the function instead would have made the watchdog un-stoppable,
which is the opposite of what `stop` means.

Co-Authored-By: Claude Code <noreply@anthropic.com>
Component: CLI
Model: agnes-3.0-flash
```

## Commands

npm workspaces: root + `packages/harness`, `packages/providers`, `apps/cli`.
Node >= 22.

```bash
npm run build                 # builds harness, providers, then cli (in order)
npm test                      # node --test suites for all three workspaces
npm run typecheck             # builds deps first (pretypecheck), then tsc -noEmit
npm run lint                  # eslint . (flat config)
npm run check:boundaries      # fails if packages/harness imports from the CLI
npm run check:theme           # verifies apps/cli/src/theme.generated.ts is in sync with cronixui
npm run check:tui             # renders a preview frame of the CLI TUI (a viewing aid, not a test)
```

Single test files:

```bash
cd packages/harness && node --import tsx --test src/harness.test.ts
cd apps/cli      && node --import tsx --test src/ui/tui.test.tsx
```

**Trap:** the CLI resolves `@actor0/harness` to its built `dist/`, not to
source. After changing anything under `packages/harness/src`, run
`npm --workspace @actor0/harness run build` before running CLI tests by hand,
or the CLI throws "does not provide an export named …" for a symbol that is
plainly there. `npm test` at the root builds first, so the full suite is safe.

Run the CLI itself with `npm run dev --workspace @actor0/cli`
(`tsx apps/cli/src/index.ts`), or the built `apps/cli/dist/cli.mjs`.

The working tree is CRLF on disk with no `.gitattributes`; the repo
conventions about that live in AGENTS.md (patch anchors, script rewrites,
`git diff --cached --numstat` before committing script-touched files).

## Architecture — the big picture

A terminal AI agent in three packages with a strict one-way boundary:

```
packages/harness    transport-neutral runtime: the turn loop, streaming,
                    bounded retries, partial-attempt rewind, tool rounds,
                    completion detection. Imports NOTHING from the CLI.
packages/providers   the three transports (OpenAI-compatible, Anthropic
                    Messages, ChatGPT/Codex), one shared auth shape.
apps/cli             the terminal client: Ink/React UI, the eight tools,
                    BYOK config, session persistence. Consumes the harness.
```

- `check:boundaries` enforces the harness→CLI import ban. Do not "helpfully"
  import a CLI type into the harness.
- The harness owns events; the host fills four ports — `ModelClient`,
  `ToolHost`, `HarnessObserver`, `ToolRoundPolicy` (see `ARCHITECTURE.md`).
  `apps/cli` exists to prove the boundary is real: it supplies those ports and
  nothing else.
- `packages/harness/src/harness.ts` is the turn loop; `model-client.ts` the
  OpenAI-compatible transport and the overflow-detection prose
  (`OVERFLOW_TEXT` — written against a provider that does not exist; see the
  AGENTS.md section "The endpoint is the only source of truth about the
  endpoint").
- `apps/cli/src/ui/` is the Ink rendering: `term.ts` owns the alternate
  screen, mouse tracking (mode 1002 for button-event so drags work), and the
  grid; `render.ts` is pure row-producing functions (`box`, `panel`,
  `providerPanelRows`, `modelPickerRows`, …) that map state to `Seg[][]`;
  `App.tsx` wires keys/modes to those rows. `theme.ts` maps the generated
  `cronixui` design tokens onto semantic names — components never touch
  `cronix.color.*` directly.
- Tools live in `apps/cli/src/tools.ts` (the `TOOLS` array order *is* the
  order the unknown-tool error lists) and `turn.ts`; adding one touches the
  system prompt too (AGENTS.md, "Adding a tool touches five places").
- `PRODUCTION.md` documents what was ported from two upstream CLIs and where
  each constant came from — treat those constants as evidence, not
  configuration.

## CI

One GitHub Actions workflow (`.github/workflows/ci.yml`) runs all six checks
plus the TUI preview on every push. The local run of a check is not the CI
run: CI checks out a clean tree, so anything that passes locally on top of
stale build artifacts (a built `dist/`, a warm `node_modules`) can still be
red there — that is exactly how the `pretypecheck` fix in
`packages/providers` was found, after a typecheck that passed locally had been
CI-red for months.

After pushing:

```bash
gh run list --limit 3          # find the run for your commit
gh run view <id>               # watch it
gh run view <id> --log-failed  # read the failing step's log
```

A push is not done until its CI run is green. When a run is red, read the
failed step before touching code — the failure is usually environmental
(clean-checkout assumptions), not in the diff.

## UI preview

`npm run check:tui` renders a frame to a file for eyeballing menu/picker
layout. AGENTS.md ("The TUI preview can lie to you") lists its failure
modes; when a frame looks wrong, check the frame's claims against a control
before blaming `ui/`.
