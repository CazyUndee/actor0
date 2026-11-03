# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ground rules (read AGENTS.md first)

`AGENTS.md` at the repo root is the repository's own working manual — commit
discipline (commit every coherent change, stage only your own paths, never
commit a red tree), the traps list, and the six-check verification order.
Read it before doing nontrivial work. The short version:

- **Commit the moment a change is in a coherent state**, with the specific
  paths you touched (`git add <path>...`, never `git add -A`).
- Before committing, run **all six, in this order**:

```bash
npm run check:boundaries
npm run check:theme
npm run typecheck
npm test
npm run lint
npm run build
```

`npm test` is one item on that list, not the list — it does not run tsc,
eslint, or the boundary check.

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

## UI preview

`npm run check:tui` renders a frame to a file for eyeballing menu/picker
layout. AGENTS.md ("The TUI preview can lie to you") lists its failure
modes; when a frame looks wrong, check the frame's claims against a control
before blaming `ui/`.
