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

A future CLI may consume the public harness types and model transport, but its protocol and host architecture are not part of this extraction.
