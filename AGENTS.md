# Working in this repository

Notes for agents and for anyone auditing the harness. The project is small; the
traps below are the parts that are not obvious from the code.

## Read CLAUDE.md too — even if you are not Claude

This repository's working manual is split across two files and both are mandatory reading, regardless of which agent or tool is operating here:

- `AGENTS.md` (this file) — commit discipline, traps, the six-check verification order, behaviour worth knowing.
- `CLAUDE.md` — the repository's other working manual: the commit-message format, the commands, the architecture, the CI contract, the UI preview failure modes, and the release notes at the top (with a pointer to `v0.2.0.md` for the full engineering record).

`CLAUDE.md` is not Claude-specific despite the name. It is the project's second manual and an agent that reads only this file will miss the commit-message format, the build traps, and the release notes. Read both before touching anything. If the two disagree, AGENTS.md wins on process and CLAUDE.md wins on architecture and release notes.

## Commit every change. Every time. No exceptions.

The working tree is not storage. In one session the entire `apps/cli/src` and
`packages/harness/src` trees were deleted from the checkout by something
external — not a reset, not a checkout, just gone. Everything committed came
back with `git checkout HEAD -- ...`; everything sitting uncommitted (a whole
subagent / MCP / usage-audit refactor) did not, and was not recoverable from
git at all. That is the difference between a bad afternoon and a lost feature.
The recovery is commit `7f54249`.

So: **commit the moment a change is in a coherent state.** Not at the end of
the task, not "once it is all working," not at the end of the session. A
half-finished but self-consistent edit gets its own commit. If you are about
to start something that moves or rewrites files, commit what already exists
first. The only safe place for work to live is in a commit.

Two disciplines keep "commit constantly" from decaying into "commit garbage":

- **Stage your own paths; never `git add -A` or `git commit -a`.** Another
  agent may have dirty files in the tree, and sweeping them in is how `HEAD`
  once came to depend on an uncommitted `subagent.ts` and stopped building.
  Stage the specific files you touched (`git add path/to/file ...`).
- **Do not knowingly commit a red tree.** Run the checks that apply to what
  you changed (see Verify below) before committing. A commit that builds is
  one you can always get back to; one that does not is a trap for the next
  person and for you.

Small, frequent, each-one-builds commits. That is the whole policy.

## Push once it is verified. Every time. No exceptions.

Committing is not the end of the loop. A commit that only exists locally is
one bad afternoon away from being lost (see the opening of this file), and a
green local tree that never reaches `origin/main` is invisible to CI, to the
next agent, and to anyone else.

So: **push the moment the change is verified to be working.** Not at the end of
the session, not "once everything is done," not after a batch of commits. Once
the applicable checks from Verify have passed on the commit you intend to ship,
push it. A half-verified commit sitting in the working tree is not progress;
it is a liability.

Discipline:

- **Push after every verified commit, or at most after a short run of them.**
  Do not accumulate a pile of local commits waiting for "the right moment."
  The right moment is when the checks are green.
- **Run the checks that apply before pushing.** A push is a publication: the
  same six-check bar from Verify (boundaries, theme, typecheck, tests, lint,
  build) applies, in that order, to whatever you are about to send. Pushing a
  red tree is pushing a trap.
- **A push is not done until its CI run is green.** After pushing, check the
  run (`gh run list`, then `gh run view <id>` / `gh run view <id> --log-failed`).
  If it is red, **fix the cause before doing anything else** — do not leave a
  red CI run behind and do not move on to the next task. Read the failed step
  first; the failure is usually environmental (clean-checkout assumptions), not
  in the diff, and the fix is to make the clean checkout reproduce locally.
  A red run you walked away from is a trap for the next person and for you.
- **Never force-push a shared branch, and never push over someone else's work.**
  `main` is shared. If the push is rejected, pull/rebase and re-verify before
  pushing again; do not `--force`.
- **Stage and commit only your own paths** (see above); the same rule applies
  to what you push. Do not sweep in another agent's dirty files to make a
  push "clean."

The only safe place for verified work to live is on `origin`. Local commits are
a staging area, not storage.

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

## Adding a tool touches five places, and three of them are tripwires

`grep` (now `rg`, backed by ripgrep) was an early tool. Registering it was one
line in the `TOOLS` array; everything else was found by a test failing and is
easy to miss:

1. **`TOOLS`** in `tools.ts`. The array order *is* the order the
   unknown-tool error lists, so `tools.test.ts` asserts that whole string
   verbatim. `glob` was a later tool and this was the place AGENTS.md
   had not counted, which is how a green suite still shipped a tool the
   error message did not offer.
2. **"the eight tools are advertised, and nothing else"** — the count is in
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

Three things that bit while writing it, all worth not rediscovering:

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
- **A test can pin the bug, and then fixing the bug looks like a
  regression.** `include: "*.ts"` was asserted to return `parts.tsx`,
  because the basename glob was unanchored and `[^/]*\.ts` matches
  inside `parts.tsx`. The test was green, the assertion read as a
  deliberate decision, and the tool was handing a model the JSX every
  time it asked for the TypeScript. When a fix breaks a test that
  *states* the old behaviour in its own name, that is the finding, not
  the obstacle — read what the test claims before you change it.

## The endpoint is the only source of truth about the endpoint

`OVERFLOW_TEXT` in `packages/harness/src/model-client.ts` lists the ways a
provider can say "this conversation does not fit". Its first four clauses were
written against Anthropic-shaped prose, four tests fed exactly those strings,
and all four passed. None of them was a string this CLI's endpoint had ever
sent.

The endpoint says something else entirely, and this was measured against it
rather than assumed:

    POST https://aestral-chat.vercel.app/api/chat
    400  {"error":"Message too large (50k char limit)"}

Not a code, not prose, and — the part that matters — **50,000 characters per
message**, not per request and not in tokens. Two messages of 25,000 each are
accepted; 50,001 characters in one message is refused.

So the whole overflow recovery path — `OVERFLOW_RECOVERY_TOKENS`,
`recoveryHistory`, the "four things have to hold" logic, the tests for all of
it — was fully built, fully green, and **unreachable**. A real request that
did not fit came back to the user as:

    Message too large (50k char limit). Retrying will not help — check the URL,
    the key, and the model name.

All three of which were fine. Worth knowing when the next thing is written
against a provider that does not exist: **a parser tested only on strings you
invented has proved nothing about the wire.** The fix is a real request against
the real host, which costs one round trip and settles it.

Two things the measurement changed, beyond the pattern:

- `message too large`, and **not** a bare `too large`. "Output too large" is
  a truncated answer, not a conversation that does not fit, and reading it as an
  overflow compacts the transcript of a conversation that fitted perfectly.
- `read` is safe at the limit by luck rather than by design: its 50,000
  **byte** cap lands at ~43,600 characters once a cut notice is appended.
  Bytes and characters are not the same unit, and the one that is enforced is
  characters.

## The two upstream CLIs are local paths, not links

`PRODUCTION.md` opens by saying the port was mined from two trees, and it names
both by absolute path:

    D:\projects\codex\codex-rs
    C:\Users\roone.DESKTOP-QJ3UG2M\Downloads\claude-code-main\claude-code-main\src

Codex contributed the design — `core/tasks`, `execpolicy`, `protocol/error`,
rollout, sandboxing — and `docs/skills.md` cites `skills/{selection,mentions,
invocation}.rs` out of the same tree. Claude Code contributed `Tool.ts`,
`permissions/`, `Task.ts` and `applyEditToFile`, and `provider-presets.ts`
cites `src/constants/oauth.ts` plus `src/services/oauth/`.

One asymmetry is worth keeping straight: **the ChatGPT OAuth values did not come
out of `codex-rs`.** They were read as strings from the shipped `codex.exe`
(`chatgpt-client.ts`, `provider-presets.ts`), because the binary is where the
live endpoint, headers and event names are actually true. No file says where
either copy came from and no URL in the repo points at either one, so a fresh
checkout cannot re-derive a single constant here.

Which is the point: those constants are **evidence, not configuration.** A
`client_id` that merely looks plausible is the most dangerous thing in
`provider-presets.ts`, and the next person tidying it is how one gets invented.
When a provider changes its flow, the fix is to obtain the source or the binary
again and read the constants off it — that file is the one place to update, and
its header says so.

## Neutering across a package boundary needs a rebuild

The harness is consumed by the CLI through its built `dist/`, not its source.
Reverting a harness file and re-running the CLI suite proves **nothing** — the
CLI keeps loading the built copy, and a test that should have failed passes.

So after changing anything under `packages/harness/src/`:

    npm --workspace @actor0/harness run build

before running `apps/cli` tests to check it. `npm run typecheck` does this
via `pretypecheck`, which is why the defect only shows up when the suites are
run directly — which is exactly how they get run while iterating.

## A listing cannot hide what a search may hide

`rg` skips `.git` (hidden) and `node_modules` (an explicit glob) outright, and
that is right: the answer is a match list, and a dependency tree in it is noise.
`glob` was written the same way at first and a test caught it — a
listing that omits `node_modules/` tells the model the tree has no such
thing, and the model will say so.

So `glob` lists the directory and does not descend into it, and a note
names the ones it left alone. The note is scoped to the answer: attached
to every result, it made `glob("README.md")` come back with a footnote
about a directory nowhere in the reply, so the output depended on the
tree rather than on the question. **An answer's shape must be a function
of the question.**

## A replacement is data, not a pattern

`String.prototype.replace` reads `$$`, `$&`, `$'` and `` $` `` in a
plain string *replacement* as its own syntax, even when the search is
a plain string: `$$` collapses to one `$`, `$&` becomes the text that
matched, `$'` the text after it. An `edit` built on it writes a shell
script's `echo $$` as `echo $` and a regex's `$&` as whatever happened
to match — silently, no error anywhere, and the model cannot see the
difference between what it asked for and what landed. Claude Code's
edit wraps its replacement in `() => replace` for exactly this reason
(`applyEditToFile` in `FileEditTool/utils.ts`); the plain form in its
validation path only simulates content, it never writes a file. `edit`
now goes through `split(before).join(after)`, which is literal by
construction and, with exactly one occurrence, the same replacement.
The tests write `$$`, `$&` and `$'` into a file and read it back.

## Behaviour worth knowing before changing it

- A shell command has **no** default timeout, deliberately: a 120s default
  killed real installs. The ceiling is an hour. Three tests in `tools.test.ts`
  pin this; they are not stale.
- **Change a pinned dependency version only when it is worth it.** A bump for
  its own sake is churn: a bigger diff to review, a new binary to re-verify,
  and a chance to reintroduce a bug that was not there. Bump when there is a
  reason — a fix you need, a feature you are using, a security patch — and say
  which in the commit. This matters most for the external binaries the CLI
  spawns (`mst`, `webclaw`), whose versions are pinned in `web-search.ts` and
  SHA256-verified on install: leave them where they are unless a concrete need
  says otherwise.
- Tool calls run in sequence, in the order the model asked for them.
- History compaction only ever clears tool *payloads*. It never drops a
  message, never reorders, and never cuts mid-conversation-unit — a cut there
  produces an orphaned `tool` result, which the provider rejects on every
  subsequent request and which no amount of retrying will fix.
- The project context a session sends is bounded; a cut file says in its own
  text that it was cut, because a model told to follow half a rules file will
  follow it as if it were all of them.
## The benchmark variant must resolve, or the loop measures its own bug

The tool-interface benchmark (`apps/cli/scripts/benchmark/`) measures model
turns through a dispatcher that turns a candidate’s tool calls into
underlying operations. `resolve()` in `dispatch.ts` switches on the
candidate id, and it only knew the six static ids (A, B, C, C2, D, E). Every
dynamically built variant id (the g-* grouped variants, the cat-* catalog
presets) fell through to "no dispatcher for candidate <id>".

That was silent in two ways. First, the error surfaced *inside the tool result
the model sees*, so the model dutifully reported "my tools are broken" and the
turn recorded a failure that looked like model behaviour. Second, the
verifier’s bad-patch detector (retry storm: many calls, none valid)
did not fire, because most of these turns failed in 2-3 calls — under the
storm threshold — so the garbage was **comparable**. The optimization loop
therefore collected two providers’ worth of runs that measured the
dispatcher, not the interface.

Two disciplines keep this class of bug from recurring:

- **A plan-coverage test.** `dispatch.test.ts` runs *every candidate the loop
  plans to measure* through a real dispatcher and asserts none falls through.
  Add a variant family and that test fails immediately, offline, for free —
  instead of after a 12-variant sweep of contaminated data.
- **Record the failure at the source.** `TaskResult.harnessError` is set from
  the dispatcher’s own records, not from pattern-matching the model’s
  paraphrase, and `verify-results.ts` has a harness-error category that
  excludes such turns from comparison and lets `--clean` + `--resume`
  re-run exactly them.

The commit that found and fixed this is `14c3df2`; the 34 surviving loop
turns are the ones that were never contaminated.


## A new model gets a battery, not a sweep

The benchmark measures model turns on a fixed task set, and the cost of a
full answer per model (one-shot reference + the whole optimization loop) is
~480 turns — the same number against every model we ever add, which is not
sustainable. So a new model is onboarded with the *breadth* question only:

1. `battery.ts --provider <name>` — 24 turns. The battery tasks are selected
   from the committed reference sweep as the tasks where candidates actually
   disagree; selection is data, not taste.
2. `verdict.ts --provider <name>` — states the breadth decision, and its
   decisiveness is gap-aware: two completed tasks apart decides at any repeat
   count; a one-task gap or a completion tie needs 3 repeats before the cost
   column can choose.
3. The optimization loop (grouped-family knobs, 11 tasks x 3 repeats) runs
   **only for the family that survives**, so most models never pay for the
   search they do not need.

The two invariants that keep this honest: verdicts are per-model, never
averaged across models, and a verdict states its own sample ("1/3 repeats,
directional") instead of presenting one draw as settled.

## Versioning

Versions live in three places and all three must move together: `apps/cli/package.json`,
`packages/harness/package.json`, and `packages/providers/package.json`, plus the
hardcoded fallback strings in `apps/cli/src/mcp.ts` and `apps/cli/src/ui/parts.test.ts`.

- **Bump only on patch-class changes.** A version bump is warranted when a
  commit meaningfully changes the way the user interacts with the application
  or how it responds — a new command, a reworked UI surface, a changed input
  gesture, a different error or status message, a removed or relocated surface.
  "Does it change the user's experience?" is the test. Build-class changes — a
  dependency bump, a CI workflow edit, a test-only change, an internal refactor
  with no externally visible behaviour change, a fix that never reaches the
  user — are **build releases, not patches**, and do **not** bump the version.
  `[chore]` and `[misc]` commits never bump unless they touch runtime behaviour
  that the user experiences.
- **How much to bump.** Versions are `MAJOR.MINOR.PATCH`. Bump exactly one
  component per commit, never two, and reset the lower ones to 0:
    - `PATCH` (0.2.0 -> 0.2.1): a `[fix]` or `[feat]` that meaningfully changes
      how the user interacts with the CLI and how it responds — e.g. a new
      command, a reworked menu or picker, a changed click/hover/key gesture, a
      removed or relocated UI surface, a different error or status message. This
      is the default for a normal user-facing commit.
    - `MINOR` (0.2.0 -> 0.3.0): a new **top-level capability** — a new tool,
      a new provider transport, or an entirely new subsystem the user could
      point to and name. Most `[feat]`/`[upgrade]` commits are *not* this;
      a menu, picker, renderer, or mouse change is a patch even when tagged
      `[feat]`. Resets patch to 0.
    - `MAJOR` (0.3.0 -> 1.0.0): only when the user explicitly says to bump
      major. Never infer a major bump from the code alone. Resets minor and
      patch to 0. Needs a migration note in the commit body.
  When in doubt between patch and minor, pick **patch** — the bar for minor
  is a genuinely new capability, not any user-facing change, and a string of
  over-bumped minors (0.2.0 -> 0.5.0) is version churn that buries the
  versions that mattered. When in doubt between minor and major, pick minor —
  major is a promise you cannot easily take back.
- **Keep the three in sync.** The CLI reads its own version from its
  `package.json` at runtime, so a stale package.json prints a stale `--version`;
  the harness/providers versions are consumed by dependents and by the MCP
  clientInfo fallback. Never leave one behind.
- **No silent versions.** If a commit touches behaviour, the version field in
  the same commit's diff is the evidence it was considered. A review that sees
  a behaviour change with no version change should flag it.
- **Tag and release every version bump.** A version bump is not done when the
  `package.json` changes; it is done when there is a git tag `vX.Y.Z` on that
  commit *and* a GitHub release at that tag carrying detailed release notes.
  A version that landed without its tag/release is a gap to backfill before
  doing anything else. Release notes are written **for the GitHub release**
  (the rendered release body), not committed into the repo as a `vX.Y.Z.md`
  file — the release is the source of truth, and the in-repo `v0.2.0.md` is a
  historical artefact, not the pattern to copy.
  Detailed means: for the version's range of commits, list the feature / fix /
  infra commits and, for each user-facing one, what it changes and why; a
  `[fix]` release still names what was broken and what now works. Write it
  for the next person auditing the version, not for the changelog skimmer.

## Publishing to npm

OIDC trusted publishing only, no token. `publish-libraries` in `release.yml`
is bound to an npm trusted publisher (GitHub App `GitHub Actions`, workflow
`release.yml`, job `publish-libraries`, event `workflow_dispatch`) and
authenticates through `id-token: write` — there is no registry key in the
repo secrets, and there must never be one: npm is deprecating direct
publish via 2FA-bypass granular tokens (effective ~Jan 2027) and the token
surface is shrinking, not growing; a long-lived key in a secret is exactly
the credential class that leaks. Re-drive a publish with
`gh workflow run release.yml -f tag=vX.Y.Z`. The `release: published`
trigger now drives only the asset-attach job, because a published release
cannot be re-run and that is precisely when a publish most needs a
re-drive.

The binding lives on the package side: the registry verifies the claim
per package, so every published package page (npmjs.com → Packages →
Settings → Trusted publishing) carries its own trusted-publisher entry for
this workflow — `@actor0/harness`, `@actor0/providers` and `@actor0/cli`,
and a new one the moment a new package is added to the publish job. Adding
a binding is web-UI only; there is no registry API for it, so a publish
that starts failing with `ENEEDAUTH` at every step has a missing binding,
not a broken workflow. `@actor0/cli` is published through the same job
(`npm i -g @actor0/cli` gives the `actor0` binary); its bundle inlines
every dependency, so the tarball is self-contained and the `engines`
field is what tells the user which Node it needs.

## CI

Always check CI after pushing, and fix it if it is broken. Do not move on
to the next task while a CI run is red.
