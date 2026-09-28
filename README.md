# Actor0

Actor0 is a small, auditable **agent harness** for any OpenAI-compatible Chat Completions endpoint.

An LLM supplies reasoning. The harness supplies the reusable runtime around it: conversation state, streaming, bounded retries, partial-attempt rewind, status and plan extraction, reasoning summaries, tool-call rounds, usage events, completion detection, and safety hooks.

Actor0 is TypeScript-first so its runtime can be extracted from the current application and imported back into its server later. A TypeScript terminal client lives in `apps/cli`; the Rust project remains available for a native client.

## Workspace

- `packages/harness` — transport-neutral TypeScript runtime and protocol types.
- `apps/cli` — a terminal client that consumes the harness, and exists to prove
  the extraction boundary holds. See [apps/cli/README.md](apps/cli/README.md).

The public project contains no product provider registry, fallback routing, built-in model catalog, proprietary tool implementation, memory/storage subsystem, billing code, or application prompt library.

## The CLI

`apps/cli` is a working agent in a terminal: streamed output, tool activity,
cancellation, slash commands, and session persistence across launches. It talks
to any OpenAI-compatible endpoint and hard-codes no provider.

It is a consumer, not a component. It supplies a `ToolHost`, an `HarnessObserver`,
a `ToolRoundPolicy` and configuration, and it uses the harness's own
`OpenAiCompatibleModel`. The harness has no idea it exists. That is the point:
if a program outside `packages/harness` can build a usable agent from the public
API alone, the boundary in [ARCHITECTURE.md](ARCHITECTURE.md) is real.

## Install and verify

```bash
npm install
npm run check:boundaries
npm run check:theme
npm run typecheck
npm test
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

## Verify

```bash
npm run check:boundaries
npm run check:theme
npm run typecheck
npm test
npm run lint
npm run build
```

## License

MIT
