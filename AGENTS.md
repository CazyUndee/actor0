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

Everything, before committing:

```bash
npm test     # typecheck + lint + boundaries + every suite, &&-joined
```

It stops at the first failure, so a red suite means the ones after it never
ran. Run them individually before believing that something is broken.

## The CLI resolves the harness to `dist/`, not to `src/`

After changing anything under `packages/harness/src`, run
`cd packages/harness && npm run build` before running a CLI test by hand, or
the CLI throws `does not provide an export named ...` for a symbol that is
plainly there. `npm test` builds first, so the full suite is safe; a bare
`node --import tsx --test src/turn.test.ts` in `apps/cli` is not.

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
