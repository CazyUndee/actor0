# Architecture

## What a harness is

A model is a callable function from context to output. A harness is the external execution system around it: what the model sees, which actions it may request, how observations return, what state is kept, how failures are handled, when execution continues or stops, and what is observable.

Actor0 is that harness runtime, extracted from a production chat application's turn loop and stream behavior.

## Runtime

```text
Host application
  ├─ supplies ModelClient
  ├─ supplies ToolHost
  ├─ supplies conversation/history callbacks
  └─ observes normalized harness events

Actor0 harness
  ├─ streaming and answer/status/plan filtering
  ├─ reasoning accumulation and summaries
  ├─ bounded retries and partial-attempt rewind
  ├─ idle timeout and cancellation
  ├─ sequential tool rounds
  ├─ empty-response recovery
  ├─ completion and partial semantics
  └─ usage aggregation
```

The runtime is implemented in `packages/harness`. It is transport-neutral and has no host-application imports.

## Extraction boundary

Actor0 owns the behavior that was distributed through the host's execution path:

- the turn and model-round state machine;
- retry classification as supplied by the model transport;
- visible-output rewind before a retry;
- streaming status and leading-plan extraction;
- reasoning accumulation and bounded summaries;
- tool-call sequencing and tool-result feedback;
- empty response continuation;
- tool-round, idle-timeout, cancellation, and completion limits;
- usage events and normalized observer events.

The host supplies the implementations behind explicit ports:

- `ModelClient` — normalized token, reasoning, tool-call, status, provider, usage, and completion events;
- `ToolHost` — tool definitions and sequential tool execution;
- `HarnessObserver` — host updates for streaming, activity, tools, usage, resets, partials, and completion;
- `ToolRoundPolicy` — host-specific rules for stopping after a tool round and empty-response continuation text.

The policy is intentionally not a product rule inside Actor0. A host can keep housekeeping tool calls (such as conversation-title updates) out of the round budget without making that tool name part of the public harness.

## Host integration

The host's existing server remains the model transport. A typical wiring looks like:

```text
host UI state hook
  └─ Actor0 harness
      └─ host ModelClient over the host's SSE chat endpoint
          └─ host auth, context assembly, and provider transports
```

The host retains its provider registry, fallback chain, model selection, tools, prompts, memory, storage, UI, and persistence. Those are host implementations behind the ports, not Actor0 runtime behavior.

## Deliberately excluded

- provider registries, fallback routing, health checks, and model selection;
- host tool catalogs and their implementations;
- product prompts, memory, storage, billing, analytics, and UI;
- application-specific server routes and deployment architecture;
- a Rust engine, standalone server, web application, or remote-host protocol.

## Reference consumer: the CLI

`apps/cli` is a terminal client built on the public harness. It exists to prove
the extraction boundary is real: if a program outside `packages/harness` can
build a usable agent by supplying only the four ports, the boundary holds.

The CLI owns everything human-facing — rendering, input, configuration,
sessions, slash commands, and the built-in tools. The harness owns model
interaction, tool-round sequencing, retries, rewind, abort, and the event
stream. Neither reaches into the other: the CLI imports `@actor0/harness` and
the harness imports nothing from the CLI.

```text
actor0 (apps/cli)
  ├─ Ink + CronixUI tokens   rendering
  ├─ config / sessions       persistence
  ├─ ToolHost + containment  host policy
  └─ Observer                event sink
        │
        ▼
  @actor0/harness            execution system
        │
        ▼
  OpenAiCompatibleModel      transport
```

Two consequences worth stating, because they are where a boundary usually
leaks:

- **Approval is not in the harness.** `ToolHost.execute` returns a string and
  nothing more, so "may this run?" is necessarily a host question. The CLI
  answers it in `ToolHost`, and a denial *resolves* rather than throwing, so a
  user's decision never counts against `maxConsecutiveToolErrors`.
- **The system prompt is not in the harness.** It is host policy, seeded before
  a turn and stripped before persistence.

### The CronixUI relationship

The CLI's terminal palette is generated from the installed `cronixui` package
(`apps/cli/scripts/generate-theme.mjs`), and CI fails if that file drifts. See
the CLI README for why the design system is consumed as *tokens* rather than
as components.
