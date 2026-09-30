# Working in this repository

Notes for agents and for anyone auditing the harness. The project is small; the
traps below are the parts that are not obvious from the code.

## Layout

- `packages/harness/src` — the runtime. `harness.ts` owns the turn loop,
  retries, rewind, abort and the event stream; `model-client.ts` owns the
  OpenAI-compatible transport; `answer-filter.ts`, `tool-call-block.ts`,
  `protocol.ts` and `plan-prefix.ts` own what the model writes being turned
  back into events.
- `apps/cli/src` — the terminal client that exists to prove the boundary is
  real. `ui/` holds the Ink rendering.

The harness imports nothing from the CLI and `npm run check:boundaries` fails
the build if that ever changes. Do not "helpfully" import a CLI type into the
harness.

## Verify

One file, while iterating:

```bash
cd packages/harness && node --import tsx --test src/<file>.test.ts
cd apps/cli      && node --import tsx --test src/<file>.test.ts
```

Everything, before committing — **all six**, in this order:

```bash
npm run check:boundaries
npm run check:theme
npm run typecheck
npm test
npm run lint
npm run build
```

`npm test` is **one item on that list, not the list**. It runs the two
workspace suites and nothing else: no `tsc`, no eslint, no boundary check.
CI runs each of those as its own job, so an error in any of them is green
locally for as long as you keep running `npm test`, and red in CI eighteen
seconds after the push. That is not hypothetical — it is how a one-line
observer that returned an array length shipped.

The suites are `&&`-joined and stop at the first failure, so a red suite means
the ones after it never ran. Run them individually before believing that
something is broken.

## The CLI resolves the harness to `dist/`, not to `src/`

After changing anything under `packages/harness/src`, run
`cd packages/harness && npm run build` before running a CLI test by hand, or
the CLI throws `does not provide an export named ...` for a symbol that is
plainly there. `npm test` builds first, so the full suite is safe; a bare
`node --import tsx --test src/turn.test.ts` in `apps/cli` is not.

The same trap sits underneath the check that matters most: **proving a new
test fails without the fix.** Reverting the harness source and re-running a
CLI test proves nothing — the CLI is still running the `dist/` built from the
fixed source, so the new tests pass against the bug they were written for.
That happened on 2026-09-29 and it is the kind of green that ships. Rebuild
the harness between the revert and the run:

```bash
npm --workspace @actor0/harness run build   # after reverting, and after restoring
```

A test that passes both with and without the fix is not automatically wrong —
a guard test ("a clean `finish_reason` is not mistaken for a cut-off answer")
is *supposed* to pass on the old code. Check which kind each one is before
concluding the fix is untested.

## The working tree is CRLF

There is no `.gitattributes`, and the checkout is CRLF on disk. Two
consequences:

- A patch applied with `\\n` anchors will silently match nothing. Either
  normalise the file, or detect the file's own ending and apply the anchor
  with it.
- A heredoc written through a Windows shell can arrive truncated or with a
  literal `\\r` at the terminator. Long scripts are safer written with a real
  file-writing tool and then `cp`-ed into place. Verify the file's byte count
  and its tail before running it.
- Git stores LF and the checkout is CRLF, and `git add` does not reliably
  reconcile the two: a file rewritten by a script can land in the index with
  CRLF still in it, after which **every line** differs from HEAD and the diff
  reads as a whole-file rewrite. Check `git diff --cached --numstat` before
  committing anything a script touched. If the numbers are the whole file,
  rewrite it with LF endings and add it again.

## Do not overwrite a file you have not read

`wc -l src/*.ts | sort -n | tail -20` hides every short file, and a short
test file is exactly the one that gets clobbered by "there is no such test
file, I will create it". `git show HEAD:<path>` before creating anything that
`git status` does not already call untracked, and check `git diff` for deleted
tests before committing — a rewrite of an existing test file reads as a
mostly-additive diff, which is easy to skim past.

## Test-authoring traps

- An `AbortSignal` that is already aborted never dispatches to a listener
  added afterwards. Add the listener before calling `abort()`, or the test
  hangs rather than failing.
- Monkey-patching `process.stdout.write` inside `node:test` intercepts the
  runner's own reporter, and the output becomes megabytes of mojibake. Use an
  injected sink instead.
- `AbortSignal.any()` returns a bare signal, not a controller. Anything that
  reads `.signal` off the result downstream gets `undefined`.
- `node --import tsx --input-type=module -e` is fine for pure code and hangs
  on anything that awaits a real async generator. Write a real test file.
- A const annotated as a domain type inside a spread chain will widen `kind`
  to `string` and fail against the interface (TS2345). Annotate the const.
- **A test's hang-breaker timeout must sit well above the bound it asserts.**
  They are two different timers and only one of them is the test's. `tools.test.ts`
  set `timeout: 5` and then asserted `elapsed < 5_000` on the same command, so
  on a loaded machine the tool killed the process first and its rejection escaped
  the test — one red run out of two, on code that had not changed. The breaker's
  only job is to end a hang, so it has an order of magnitude of headroom (30s
  timeout, 10s assertion). This is the second timeout flake here; the first was
  `d2339f4`. When a timing test is red once and green once, look for the two
  clocks before you look at the code.

## The TUI preview can lie to you

`npm run check:tui` is a viewing aid as much as a test, and it has three
ways of showing a bug that is not in the app. All three bit during the
resize frames, and all three are fixed — the point is to recognise them
next time rather than to go looking in `ui/`.

- **A missing escape sequence reads as a layout bug.** `Screen` ignored the
  parameter on `K`, so `ESC[2K` (erase the whole line — what log-update emits
  to repaint every row) was treated as "erase up to the cursor" and kept
  whatever was to the right of it. That manufactured the stale rows a
  resize is supposed to remove. It now models `0K`/`1K`/`2K` and `0J`/`1J`/
  `2J`/`3J`, and any sequence it still cannot model is counted in
  `unhandled` and fails the run, while attribute-only ones (`m`, `h`, `l`) are
  counted in `ignored` so the two are never confused.
- **A capture mid-repaint is a frame nobody will ever see.** Ink repaints in
  several writes, so a `show()` can land between them and record half the
  old layout over half the new one. The signature is a row that is there on
  one run and not the next. `show()` now waits for the screen to stop
  changing first.
- **Changing two axes at once makes a frame unattributable.** A 44-column,
  30-row frame is short enough for Ink to abandon its incremental path and
  repaint with `clearTerminal`, and the residue afterwards could have come
  from either the width or the height. Width and height now have separate
  frames (`narrowTerminal`, `shortTerminal`).

Before believing anything a frame shows, check it against a control: the
same resize applied to a plain two-`<Text>` Ink app, whose correct output
is easy to reason about. That is what separated the emulator's bug from
Ink's behaviour here.

- **`show()` is async, so every call site must `await` it — and nothing else
  catches a missing one.** A frame capture that does not await pauses in
  `settle()`, the driver keeps typing, and the frame records the screen as it
  was after the *next* thing happened. `eslint` has no type-aware rules on
  `apps/cli/scripts`, and the repeated-frame check cannot see it because the
  content genuinely changed. The driver counts frames started against frames
  finished and fails on a difference, which is the only thing that catches it.
  Four call sites lost their `await` when a later patch renumbered labels
  with `sed`; a floating frame is silent, so assume it happened.
- **A frame that resizes _after_ the answer has committed is testing
  nothing.** The transcript is `<Static>`, so a finished answer is written
  once and never re-laid-out. Narrow the terminal after an answer lands and
  only the live region re-renders: the committed answer stays exactly as
  it was. The frame reads plausibly — it has the new width, the new
  prompt, the old content — and it asserts nothing about the new width.
  The order has to be **resize, then ask**. Frame 22 was wrong this way
  first: captioned "too narrow for a grid" over a wide grid, exit 0,
  no failure. A frame's caption is a claim; check that the content
  actually contradicts the previous frame.

## The prompt promised markdown the renderer never did

`turn.ts` tells the model *"GitHub markdown renders: fenced code blocks with a
language tag"*, and for the whole life of the CLI every answer went through one
word wrapper — fences, tables, headings and all. A fenced command was folded at
whatever column the wrap landed on, which is neither runnable nor readable.

Two things follow, and both are traps for the next person:

- **A prompt is a specification, not decoration.** When one names a rendering
  behaviour, go check that the renderer does it. Nothing else in the repo will
  tell you: no test renders an answer, and the model produces perfectly good
  markdown that quietly loses half its meaning on the way to the screen.
- **The row budget has to be counted in rendered rows, not lines of input.**
  `fitTail` cannot "wrap, then slice the last N lines" once code exists, because
  a line of code costs exactly one row however long it is while prose costs as
  many as it wraps into. Segments carry their fences so a tail can be flattened,
  budgeted, and rejoined without losing one.

Both halves are independently load-bearing, and the suite proves it: neutering
`segments()` fails all seven fence tests, while putting `fitTail` back to
wrap-then-slice fails only the row-budget one. An unterminated fence is the
streaming case, not an edge case — for most of a streaming answer the closing
fence has not arrived yet, so treating it as prose wraps exactly the content
that is about to become code.

A table goes through the same trap one step further on, and it is worth
knowing the shape of it because it is a **data-loss** bug, not an ugly
one. Folded by the word wrapper, the `| --- |` delimiter row prints as
literal dashes and each value separates from its own row: at 44 columns
`20s` arrives as a row by itself, and the reader is left to guess which
command it belonged to. So a table is now a segment of its own and is
never re-wrapped.

**Size against `proseWidth(columns)`, never against `columns`.** Prose is
wrapped to two columns short of the terminal and never narrower than 20,
because Ink's `trim: false` leaves the break space on the next line.
Anything that measures itself against raw `columns` is measuring a width
no line will ever be — that is how the rule under a narrow table came to
overflow its own budget by one. The grid is the one exception: it is
sized to its content, so it is checked against `columns` because what it
must not exceed is the terminal. Both are right, and mixing them up is
the bug.

## Adding a tool touches four places, and two of them are tripwires

`grep` was the fifth tool. Registering it was one line in the `TOOLS` array;
everything else was found by a test failing and is easy to miss:

1. **`TOOLS`** in `tools.ts`. The array order *is* the order the
   unknown-tool error lists, so a test asserts that whole string.
2. **"the five tools are advertised, and nothing else"** — the count is in
   the test's own name, so it fails when the tool set changes, which is
   the point. Keep the name honest.
3. **"every tool verb in the prompt is a real tool"** — the list is written
   out separately from `TOOLS`, so a new tool is a prompt lie until both
   are updated.
4. **The system prompt itself.** A tool the prompt never mentions is a
   tool the model does not reach for, and nothing fails: the definition is
   in the request, the tests are green, and the model goes back to
   shelling out. This is the same trap as the markdown line below, in a
   different place.

Two things that bit while writing it, both worth not rediscovering:

- **A relative path needs a resolved base.** `relative(cwd, file)` where
  `cwd` is still unresolved produces a chain of `../..` for every result —
  and `within()` resolves paths while `ctx.cwd` does not, so the two are
  different strings for one directory. That is invisible on a normal
  checkout and total on a temp dir, which is a symlink on macOS. Build
  the display path from `realpath(cwd)` and carry the absolute path
  alongside it rather than joining the two back together.
- **Never write `*/` inside a doc comment.** A JSDoc that explains a glob
  with the obvious example — `**/` crosses directories — ends at the
  `*/` and the rest of the sentence parses as TypeScript. It surfaced as
  four unrelated syntax errors hundreds of lines from the cause.

## Behaviour worth knowing before changing it

- A shell command has **no** default timeout, deliberately: a 120s default
  killed real installs. The ceiling is an hour. Three tests in `tools.test.ts`
  pin this; they are not stale.
- Tool calls run in sequence, in the order the model asked for them.
- History compaction only ever clears tool *payloads*. It never drops a
  message, never reorders, and never cuts mid-conversation-unit — a cut there
  produces an orphaned `tool` result, which the provider rejects on every
  subsequent request and which no amount of retrying will fix.
- The project context a session sends is bounded; a cut file says in its own
  text that it was cut, because a model told to follow half a rules file will
  follow it as if it were all of them.
