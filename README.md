# Actor0

Actor0 is a small, auditable **agent harness** for any OpenAI-compatible Chat Completions endpoint.

An LLM supplies reasoning. The harness supplies the reusable runtime around it: conversation state, streaming, bounded retries, partial-attempt rewind, status and plan extraction, reasoning summaries, tool-call rounds, usage events, completion detection, and safety hooks.

Actor0 is TypeScript-first so its runtime can be extracted from the current application and imported back into its server later. The Rust project is only the terminal client.

## Workspace

- `packages/harness` — transport-neutral TypeScript runtime and protocol types.

The public project contains no product provider registry, fallback routing, built-in model catalog, proprietary tool implementation, memory/storage subsystem, billing code, or application prompt library.

## Install and verify

```bash
npm install
npm run check:boundaries
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
npm run typecheck
npm test
npm run lint
npm run build
```

## License

MIT
