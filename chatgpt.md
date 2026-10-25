# ChatGPT as an Actor0 Reasoning Backend

Research, architecture, and operational notes for connecting ChatGPT's model
to Actor0's harness/tool execution layer. Live experiment state is included
at the end.

---

## 1. Verdict

**Feasible, but not through the desktop app itself.** The ChatGPT desktop app
is a user surface, not an integration surface: no documented local API,
socket, or automation interface exists for third-party drivers, and
automating its internals would violate OpenAI's Terms of Use ("Automatically
or programmatically extract data or Output"; "Attempt to … reverse engineer
… underlying components"; fetched 2026-10-24).

What works instead is treating **ChatGPT as the reasoning brain** and
**Actor0's ToolHost as the execution layer**, connected through OpenAI's
sanctioned MCP path:

- **Local (today):** Plugin marketplace + local stdio MCP server →
  ChatGPT/Codex threads that run locally.
- **Remote/cloud chat (today):** Secure MCP Tunnel (`tunnel-client`)
  fronting the same local stdio server → any ChatGPT conversation calls
  Actor0 tools on your machine.
- **Grey zone / not recommended:** The repo's existing `ChatGptModel`
  speaking `chatgpt.com/backend-api/codex` directly with OAuth — technically
  shipped and tested, but an internal third-party endpoint with no published
  ToS ruling.

**Core principle proven:** one execution layer (Actor0's `ToolHost`),
multiple brains (ChatGPT via MCP tunnel, Codex local plugin, Actor0 CLI
internally). The harness core needed **zero changes**.

---

## 2. Actor0 Architecture (verified in-repo)

| Concern | Location | Notes |
|---|---|---|
| Model port | `packages/harness/src/types.ts:123-129` | `ModelClient.stream(messages, tools, signal) → AsyncIterable<ModelEvent>`. Transport-neutral. |
| Event types | `types.ts:57-72` | `ModelEvent`: token, reasoning, tool_call, usage, status, provider, done{truncated?, reason?}. |
| Harness events | `types.ts:75-150` | `HarnessEvent` includes `tool_rejected`, `needs_user`, `error`, etc. |
| Turn loop | `packages/harness/src/harness.ts:369` | `runAgentTurn` drives rounds: model call → filter → tool execute → tool result → next round. |
| Model round | `harness.ts:128` | `runModelRound` retries with backoff; `runModelAttempt` emits `attempt_start` before streaming. |
| Tool dispatch | `harness.ts:479` | `options.toolHost?.execute(call, signal)`; results pushed as `role:"tool"` messages with `tool_call_id`. |
| Transcript repair | `harness.ts:abortTurn` / `failedTurn` | Appends API-valid tool results / markers so the next request is accepted. |
| Tool port | `types.ts:131-132` | `ToolHost.definitions(): ToolDefinition[]` + `execute(call, signal): Promise<string>`. |
| Tool host combinators | `packages/harness/src/tool-host.ts` | `compositeToolHost`, `namespacedToolHost`. |
| CLI tool registry | `apps/cli/src/tools.ts:1533` | `createToolHost({cwd, taskDelegate})`; read/write/edit/glob/shell/task/skill/rg. Args validated via `JSON.parse` → must be object (tools.ts:1547). Unknown tools throw `Available: …`. |
| Tool protocol in text | `packages/harness/src/tool-call-block.ts:285` | `parseToolCallBlock`: ```json fences and `<tool_calls>` envelopes; unoffered/invalid JSON → `RejectedBlock`. |
| Answer filter | `packages/harness/src/answer-filter.ts` | `createAnswerFilter(toolNames)` — incremental filtering; yields `toolCalls` and `rejected`. |
| SSE turn protocol | `packages/harness/src/protocol.ts` | `TurnRequest`, `encodeEvent`, `readEvents` — building block for hosting turns over HTTP. |
| Client seam (turn) | `apps/cli/src/turn.ts:424-431, 449` | `TurnOptions.client?: ModelClient` — "a seam, not a setting." `options.client ?? createModel(options.model)`. |
| Client seam (subagent) | `apps/cli/src/subagent.ts:55-61` | `TaskDelegateOptions.client?: ModelClient`. |
| Max tool rounds | `apps/cli/src/turn.ts:308` | `MAX_TOOL_ROUNDS = 24`. |
| Overflow recovery | `turn.ts` `recoveryHistory` (~470-540) + `model-client.ts` `OVERFLOW_TEXT` | Compacts tool payloads, single replay, gated by `isContextOverflowError`. |
| Idle timeout | `harness.ts` (~40-49) | Every `iterator.next()` races against `idleTimeoutMs` (default 60 s); a human bridge must emit keepalives or raise the limit. |
| Provider dispatch | `packages/providers/src/resolve.ts:14` | `createModel` dispatches on `transport`: openai / anthropic / chatgpt. |
| ChatGptModel | `packages/providers/src/chatgpt-client.ts` | Implements `ModelClient` for `chatgpt.com/backend-api/codex` Responses API. Credentials read from shipped `codex.exe` (evidence, not config — AGENTS.md). |

---

## 3. Desktop Integration Options (evidence-based)

| Option | Technically | Supported | Under ToS | Evidence |
|---|---|---|---|---|
| Desktop app local API/socket | No evidence | No | N/A | `learn.chatgpt.com/docs/app` (2026-10-24) — user surface only |
| Automating desktop app internals | Unknown / fragile | No | No (reverse-engineering) | ToU 2026-01-01 |
| Manual human transfer | Trivial | N/A | Yes | App is a user surface |
| Actor0 `ChatGptModel` → `backend-api/codex` | Yes (shipped) | No — internal backend | Unresolved grey zone | `openai/codex/discussions/8338` unanswered |
| Official OpenAI API key | Yes | Yes | Yes | `OpenAiCompatibleModel` |
| ChatGPT as MCP client → local MCP server | Yes | Yes | Yes | `developers.openai.com/api/docs/mcp`; help.openai.com/en/articles/12584461 |
| Secure MCP Tunnel | Yes (`tunnel-client`) | Yes | Yes | `developers.openai.com/api/docs/guides/secure-mcp-tunnels` |

---

## 4. Recommended Architecture (what was built)

A thin **producing MCP server** exposing Actor0's own `ToolHost` to external
MCP clients (ChatGPT, Codex, etc.). Zero harness changes.

### Files committed to the repo

| Commit | File | Role |
|---|---|---|
| `fb7caaa` | `apps/cli/src/mcp-serve.ts` | `mcpToolsFromHost` maps `ToolHost` → `McpServerTool[]`; routes `tools/call` through `ToolHost.execute`. `hostMcpServer`, `restrictedToolHost`, `serveStdio` (newline-delimited JSON-RPC over stdin/stdout; malformed lines dropped; logs on stderr). |
| `53e7d7b` | `apps/cli/scripts/mcp-serve.ts` | Entry point: `npx tsx apps/cli/scripts/mcp-serve.ts --tools read,rg,shell --cwd <dir>`. Smoke-tested against the real tool host. |

Also: `apps/cli/src/mcp-serve.test.ts` (4 tests pass — mapping/routing, error passthrough, restricted-host refusal naming, stdio framing).

### Design properties deliberately preserved

- `tools/call` goes through `ToolHost.execute` — argument validation, path confinement, error messages are exactly what the CLI's own model sees. No re-validation.
- No timeout imposed on tool runs (repo policy: shell has no default ceiling). Connector's own timeout applies.
- `shell` has no default timeout; tunnel has a hard **120 s request deadline** — long shell commands need an explicit `timeout` argument.
- Tools confined to `--cwd` (host-enforced path confinement).

### Runtime used for the live experiment (outside repo)

| Item | Location / Value |
|---|---|
| `tunnel-client.exe` v0.0.18 | `~/.cache/tunnel-client/tunnel-client.exe` (SHA256-verified vs release) |
| Tunnel ID | `tunnel_6adcfcb46ac8819182eb4da857d13458` |
| Profile | `AppData\Roaming\tunnel-client\actor0.yaml` |
| ChatGPT connector | Plugins → + → Add custom MCP server → Tunnel → `actor0` |
| Local plugin (Codex desktop) | `~/.agents/plugins/marketplace.json` → `~/plugins/actor0/{plugin.json,mcp.json}` |
| Installed cache | `~/.codex/plugins/cache/actor0-local/actor0/0.1.0/` |
| Enabled flag | `~/.codex/config.toml` `[plugins."actor0@actor0-local"] enabled = true` |

---

## 5. Minimal Proof of Concept (executed state)

### Completed
- `tunnel-client` v0.0.18 downloaded, checksum-verified, extracted.
- Tunnel created in Platform settings → Tunnels.
- Profile created via `tunnel-client init --sample sample_mcp_stdio_local --profile actor0 --tunnel-id <id> --mcp-command "..."`.
- `tunnel-client doctor --profile actor0` → all checks PASS (config, profile, tunnel_id, control_plane_api_key, mcp_target, mcp_command_executable, health_listener, ui).
- ChatGPT plugin connected via Tunnel with no auth; tool discovery ran.

### Remaining operational steps (your side, in PowerShell)

1. Stop stale daemon if present:
   ```powershell
   Stop-Process -Id 32068    # old daemon serving 2-tool config
   ```
2. Start fresh daemon:
   ```powershell
   $env:CONTROL_PLANE_API_KEY = "sk-…your-runtime-key…"
   cd C:\Users\roone.DESKTOP-QK3UG2M\.cache\tunnel-client
   .\tunnel-client.exe run --profile actor0
   ```
   → Watch for "ready"; `http://127.0.0.1:8080/ui` shows health.
3. **While daemon is up**, ChatGPT: Plugins → your `actor0` connector → **Refresh** (or delete + re-add if no Refresh control) → tool scan should list all six: `read, rg, write, edit, glob, shell`.
4. **New conversation** (installed plugins add tools to new chats):
   ```
   Use the actor0 tools to read AGENTS.md in E:\projects\actor0 and summarize its commit policy.
   ```
   → ChatGPT proposes `read`/`rg`; call tunnels to this machine; Actor0 executes; real content returns.
5. Write test:
   ```
   Use the actor0 tools to create a file proof.txt on my Desktop with today's date.
   ```
   → `write` call; ChatGPT should ask for confirmation (documented behavior for write actions).

### Known runtime snag
- Old daemon PID `32068` served the original 2-tool config (`read,rg`, cwd = repo). Profile yaml updated to six tools + home cwd (`C:/Users/roone.DESKTOP-QK3UG2M`), but daemon must be restarted for the new config to serve.
- After any `--tools`/`--cwd` change: restart daemon → Refresh connector → new conversation.
- Drive note: checkout is now `D:/projects/actor0`? No — profile and scripts reference `E:/projects/actor0`. Repo drive was **E:** at research time; `chatgpt.md` notes use `E:/projects/actor0` consistently. (User later said drive is now `D:` — see note below.)

---

## 6. Implementation Roadmap

| Order | Step | Files / Actions |
|---|---|---|
| 1 (done) | `mcp-serve.ts` + tests committed | `apps/cli/src/mcp-serve.ts`, `mcp-serve.test.ts` |
| 2 (done) | Entry script + smoke test | `apps/cli/scripts/mcp-serve.ts` |
| 3 (in progress) | Live PoC: tunnel + ChatGPT connector → verify read, then write with confirmation | daemon + chatgpt.com Plugins |
| 4 | Repo docs for the capability | `docs/mcp-serve.md` (manifest templates, path caveat, tunnel profile shape) |
| 5 (optional) | Streamable-HTTP transport for public plugin submission | New `McpTransport` implementation serving `/mcp` |
| 6 (ruled out) | Desktop-app IPC | ToS / evidence — not pursued |

No changes to `packages/harness/src`, `turn.ts`, `tools.ts`, or `mcp.ts` were needed.

---

## 7. Unresolved Questions

1. **Personal-account gating:** OpenAI's help text frames custom MCP connections under Business/Enterprise workspaces; personal-plan durability on the desktop app is unverified long-term.
2. **`source.path` resolution:** Codex resolves relative to home, not the marketplace catalog root — plugin folder lived at `~/plugins/actor0`, not `~/.agents/plugins/plugins/actor0`.
3. **`tunnel-client` lifecycle on Windows:** Foreground daemon in your terminal; durable setup would want a service or scheduled task.
4. **Rate limits:** 600 req/min, 10 MiB envelope, 120 s deadline. `read`/`rg`/`write` fine; long `shell` needs explicit `timeout`.

---

## 8. Direct Recommendation

**Smallest useful next experiment:** The tunnel exists, profile is configured, `doctor` is green. Remaining work:

1. Stop stale daemon (PID 32068 if present).
2. Start fresh: `$env:CONTROL_PLANE_API_KEY = "sk-…"` → `tunnel-client run --profile actor0`.
3. Verify `http://127.0.0.1:8080/ui` healthy.
4. ChatGPT Plugins → your `actor0` connector → Refresh → **new conversation**: *"Use the actor0 tools to read AGENTS.md in E:\projects\actor0 and summarize its commit policy."*

**Evidence justifying full implementation:** one clean cycle where ChatGPT proposes `read`, Actor0's host executes it on your machine, and real content returns in chat — plus the `write` confirmation-prompt test. That proves Actor0's harness needs no changes to serve as the execution layer for ChatGPT-driven reasoning.

If you want tools confined to a specific checkout rather than your home directory, create a **second tunnel + connector** scoped to that project's `--cwd` — same server, different confiner.

The repo side is complete and committed; nothing further is needed there unless you later want the Streamable-HTTP variant for public plugin distribution.

---

## Live Experiment Notes (as of last check)

- Tunnel: `tunnel_6adcfcb46ac8819182eb4da857d13458` (Platform → Tunnels)
- Daemon command: `tunnel-client run --profile actor0` from `~/.cache/tunnel-client`
- Env var required each new window: `$env:CONTROL_PLANE_API_KEY = "sk-…"`
- Health UI: `http://127.0.0.1:8080/ui`
- ChatGPT connector settings: `chatgpt.com/#settings/Connectors`
- Daemon config: `AppData\Roaming\tunnel-client\actor0.yaml`
- Local plugin manifests: `~/plugins/actor0/{plugin.json,mcp.json}`
- Repo checkout: `E:/projects/actor0` (drive letter may have changed since research began — confirm before pasting paths into `--cwd`)
