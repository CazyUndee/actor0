# Production harness roadmap — opinionated but grounded

Mined from `D:\projects\codex\codex-rs` (core/tasks, execpolicy, protocol/error,
rollout, sandboxing) and
`C:\Users\roone.DESKTOP-QK3UG2M\Downloads\claude-code-main\claude-code-main\src`
(Tool.ts, permissions/, Task.ts, FileEditTool applyEditToFile). This doc is the
plan; the phases below are the work.

## Opinions (defaults that ship)

1. **Bounded by default.** Unbounded `maxToolRounds`, no turn deadline, and no
   tool timeout is an incident, not a feature. Production default: 24 rounds,
   10-min turn deadline, 120s tool timeout — all raisable, none removable
   silently (a raise emits an event).
2. **Fail closed, resume open.** Config drops what it cannot validate; sessions
   repair what they can and refuse to send what they cannot. A resumed session
   never fails on every request because of shape.
3. **Compaction is a harness port, not CLI policy.** Codex compacts inside the
   loop (`CompactTask`, rollout summarization); Claude Code clears payloads but
   keeps structure. Here: harness owns repair + clear-only compaction behind a
   `CompactionPolicy` port; CLI supplies clearable tools and budgets.
4. **Errors are data.** Codex `CodexErr{details, retry_after}` classifies
   retriable vs fatal once. Here: `HarnessError` carries `code`, `retriable`,
   `retryAfterMs`, `contextWindowTokens` — hosts branch on codes, humans read
   messages.
5. **Tools are parallel-safe by declaration.** Claude `isConcurrencySafe`,
   Codex tool router. Sequential stays the default (ordering is a feature);
   hosts opt tools into parallel batches explicitly.
6. **No silent loss.** Every destructive step (compaction, repair, truncation,
   overwrite) leaves a marker or an event a host can surface.

## What stays where (boundary)

- Harness: turn state machine, retry classification, rewind, abort, tool
  sequencing, repair, compaction, budgets, structured errors, usage ledger,
  event stream.
- CLI/host: tool implementations, approval UX, sandbox enforcement, prompts,
  config/storage/UI, cost pricing, skills/MCP wiring.

## Phase 1 — Reliability (this pass)
- [x] `HarnessError` taxonomy (`model-client.ts` + `harness.ts`): codes
      `rate_limited/quota/context_overflow/auth/config/network/timeout/aborted/tool_failed`,
      unwrap `cause` chains, keep messages human-first.
- [x] Turn + tool budgets (`HarnessConfig`): `maxTurnMs`, `maxToolMs`,
      `maxToolRounds: 24` default; `needs_user` reasons grow
      `deadline|tool_timeout|budget` — never a throw for a budget.
- [x] Transcript repair + compaction move into harness (`transcript.ts`):
      `repairTranscript` (keep-valid-units), `compactTranscript` (clear-only,
      marker-prefixed, keepRecent floor); CLI `history.ts` becomes the policy
      supplier. Overflow recovery retries once through the port.
- [x] Session versioning + atomicity (version field, fsync, backward-compat load) (`session.ts`): `version: 1`, fsync before
      rename, corrupt-vs-missing distinguished on load.
- [x] Golden-trace evals (`packages/harness/src/evals/`): scripted
      ModelClient traces — retry/rewind, cancel mid-tool, error-streak stop —
      asserting event order + transcript validity. The overflow→compact→retry
      trace is **host-owned** by design ("recovery is not the transport layer's
      job"), and its five cases live in `apps/cli/src/turn.test.ts`.
- [x] Usage ledger (`packages/harness/src/usage-ledger.ts`): `sumUsage` is a
      lossless turn total (preserves `cached_tokens`/`reasoning_tokens` the old
      CLI reducer dropped — CLI `totalUsage` now delegates to it), plus
      `createUsageLedger` with a per-model cost hook the host prices. The harness
      totals; it never invents a price.

## Phase 2 — Safety (done)
- [x] Secret redaction on tool results (`redact.ts`): `redactSecrets` replaces
      credentials (API-key prefixes, `NAME=value` secret assignments, bearer
      tokens) in tool output *before* it enters the transcript or the event
      stream, so a secret is never saved to a session or shown twice. On by
      default via `HarnessConfig.redactToolOutput`; the assignment rule skips an
      existing `[redacted:` marker so it never re-redacts its own output. Wired
      once at the harness tool-result seam (success + failure paths), so both
      sinks cannot disagree; an integration test proves a leaked secret is
      redacted in both the stored transcript and the emitted event, and that
      `redactToolOutput: false` disables it.
- [x] Audit trail (`audit.ts`): `auditEntries(events)` folds the `HarnessEvent`
      stream into structured entries; the harness returns them on
      `RunResult.audit` via a single-exit observer wrapper. The CLI persists
      them with `recordAudit`/`readAudit` (`usage.ts`) on the same seam as the
      usage log, wired in the TUI host — reachable, not fully-built-but-unused.
- [x] **No approval gate — deliberate, load-bearing.** The harness has no
      `requestApproval` port and the CLI has no destructive-command gate. A
      prompt that is always approved is not a control (`tools.ts`), and a gate
      the CLI already removed on purpose is not a gap to re-add. Enforcement
      that *is* worth having — the sandbox (Codex seatbelt/bwrap/Windows
      restricted-token as reference) — stays host-side, since the harness is
      transport-neutral and has no OS context to enforce a policy against.

## Phase 3 — Extensibility (in progress)
- [x] Parallel tool batches for `concurrencySafe` tools:
      `ToolHost.concurrencySafe?(name)` is the declaration port (`types.ts`);
      `planSafeBatches` (`safe-batch.ts`) groups consecutive read-only calls and
      isolates every mutating call. The round loop fires a batch only when it
      reaches that batch's first member — never earlier — so a batch never begins
      until every batch ahead of it has finished and a read still sees the write
      before it. Only the *executions* overlap: event order, message order, the
      redaction seam, abort slicing and the error counter are untouched, and a
      host that declares nothing takes the sequential path byte-for-byte. The CLI
      declares `read`/`grep`/`glob` safe and `shell`/`write`/`edit` unsafe *on the
      tool entry itself*, so the classifier and the registry cannot drift. Four
      harness tests pin the contract (overlap proven by barrier, positional commit
      order, batch boundaries, sequential default); proven to fail without the
      wiring. Design principle 5 is this item.
- [x] Plugin `ToolHost` composition (`tool-host.ts`): `compositeToolHost`
      merges several hosts behind one port (first-wins by name, unknown names
      throw, `concurrencySafe` answers from the owning host); `namespacedToolHost`
      prefixes one host (`ns__name`) for MCP/skill servers. The harness composes;
      servers stay host-side.
- [x] Sub-agent `Task` tool as a host tool, not harness core (`task.ts` +
      `subagent.ts`): `task` delegates one prompt to `runAgentTurn` with a
      read-only tool surface (`read`/`grep`/`glob`), depth 1 by shape (no `task`
      inside), capped prompt and tail-kept answer, always serial. Wired in the
      TUI and `-p` hosts through the parent's own provider; without a delegate
      it explains itself. No approval gate — delegation is execution, covered
      by the deliberate no-approval decision.
- [x] Streaming protocol hardening (frame-tolerant SSE parser) (`sse.ts`):
      CRLF/mixed boundaries, multi-`data:` join, `flushSse` for an unterminated
      final frame.
- [ ] MCP/skill server wiring (host-side transport + registration).
