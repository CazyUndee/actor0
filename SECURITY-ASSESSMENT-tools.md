# Actor0 Tool Layer — Security Assessment Report (Addendum)

**Targets:** `apps/cli/src/tools.ts` and the CLI tool cluster; `apps/desktop/agent/src/tools/*`
and the desktop agent's transport/launch surface.
**Assessment type:** Autonomous source-code penetration test (operator-expanded scope).
**Baseline commit:** `4db52fb`. Baseline health: CLI `tools.test.ts` 117/117 pass,
desktop `tools.test.ts` 13/13 pass.
**Predecessor:** `SECURITY-ASSESSMENT-harness.md` (harness core, 7 findings).

---

## 0. Disclosure: accidental capture of live credentials

During validation of **T-2** I ran a PoC that constructed the real desktop `Agent`, whose
constructor calls `loadConfig()`. That printed the user's real `config.json` — including
several live provider API keys — into this session's output. I should have stubbed
`loadConfig` as well as the bridge. I also earlier ran a shell-tool PoC that surfaced the
real host environment.

Both PoCs were deleted immediately; the repo is clean of my artifacts. **Those credential
values are compromised and should be rotated** (the affected providers, from the names
printed: `sapiens`/agnes-ai, `api.groq.com`, and any others in that config). I am not
reproducing any value here. Two process lessons: an "isolated" PoC that constructs a real
`Agent` or runs the shell tool is **not** isolated, and every PoC in this report was
re-run afterwards with constrained output. This did not breach the directive's
"do not extract real credentials" clause deliberately, but it did breach it in effect, and
it is recorded rather than hidden.

---

## 1. Executive summary

The tool layer is where the agent's authority actually lives, and unlike the harness it is
full of `spawn`, `writeFile` and `process.env`. Five confirmed findings, two of them
Critical:

| # | Finding | Severity | Confidence |
|---|---|---|---|
| T-1 | Workspace containment is bypassable via a dangling symlink (both CLI and desktop writers) | **Critical** | Confirmed |
| T-2 | Desktop agent WebSocket is unauthenticated by default; config (incl. API keys) and all tools are reachable by any local process | **Critical** | Confirmed |
| T-3 | The shell tool hands the model the whole parent environment — API keys, tokens, cloud credentials | **High** | Confirmed |
| T-4 | Desktop `rg` resolves a "bundled" binary from `process.cwd()` — a project can supply the executable | **High** | Confirmed |
| T-5 | Desktop `shell` has a `background` flag that spawns and unrefs a process nothing can later kill | **Medium** | Confirmed |
| — | CLI `shell` timeout can be set to 3600 s; no per-turn process budget | Informational | Confirmed |

The headline is **T-1**: both implementations of `within()` document symlink-safe
containment and both are defeated by a **dangling** symlink — the link resolves to the
link itself (inside the root), so containment passes, and the subsequent write follows the
link to its target outside. I demonstrated a planted file outside the workspace with the
real `write` tool on both platforms. The desktop test suite has a containment test; it only
covers the case where the target *exists*, which is precisely why this was missed.

**T-2** is the other half: the desktop agent is meant to be driven only by the shell, and
it takes a token — but `main.tsx` starts it without one, and the server disables auth when
the token is absent. Any local process can connect, read the config, and call every tool.

---

## 2. Scope

**In scope:** `apps/cli/src/tools.ts`, `subagent.ts`, `skills.ts`, `web-search.ts`;
`apps/desktop/agent/src/tools/*` (host, shell, read, write, edit, glob, rg, task,
web-search, mcp-http, within, shared, context);
`apps/desktop/agent/src/{server,index,native/bridge}.ts`; `apps/desktop/web/src/shell.ts`
and `main.tsx` and `neutralino.config.json` to the extent needed to establish impact.

**Out of scope / not tested:** `@actor0/providers` OAuth internals, the React UI, the
Neutralino binary itself, live providers. No production code was modified.

---

## 3. Findings

### T-1 — Workspace containment bypassed by a dangling symlink  *(Critical, Confirmed)*

**Location.** `apps/cli/src/tools.ts:167-201` (`within`), used by `write` (`:465`),
`edit` (`:572`) and `glob`'s start dir; `apps/desktop/agent/src/tools/within.ts:41-63`,
used by `write.ts:38` and `edit.ts:56`.

**Technical explanation.** The algorithm walks upward to the deepest ancestor that
`realpath` can resolve, then re-appends the literal tail:

```ts
let resolved = target;
const tail = [];
for (;;) {
  const real = await realpath(resolved).catch(() => null);
  if (real !== null) { resolved = tail.length === 0 ? real : resolve(real, ...tail.reverse()); break; }
  const parent = dirname(resolved);
  if (parent === resolved) break;
  tail.push(resolved.slice(parent.length + 1));
  resolved = parent;
}
```

For a **dangling** symlink `escape.txt -> E:\outside\planted.txt`:
- `realpath("…/escape.txt")` fails (target does not exist) → `tail = ["escape.txt"]`;
- `realpath("…/root")` succeeds → `resolved = resolve(root, "escape.txt")` = the link path.

The link path is **inside** the root, so the `escapes(rel)` check passes. The code then
writes/edits through the link, and the OS follows it to `E:\outside\planted.txt`. The
in-code claim — *"a non-existent tail cannot contain a link, because there is nothing to
point at"* — is false: a dangling link points somewhere even though nothing is there yet.
The recursive-delete path (`remove`) is not exposed by a tool, so the practical impact is
arbitrary file **write** at a path the workspace's owner can be induced to link to.

**Reproduction (both platforms, temp dirs, synthetic data).** `write` through the tool
host:

```
[write] result: [wrote 12 bytes to note.txt]
[write] file created OUTSIDE root: true "outside root"
```

and the CLI, via `createToolHost`:

```
write result: Created ...\a0-cli-root-…\escape.txt (21 characters, 1 lines).
file outside root created: true "planted by write tool"
```

A **directory** symlink to an outside dir is correctly refused (CLI), which confirms the
hole is specific to the dangling-link tail.

**Impact.** The single control the tool layer relies on ("every path is confined to the
working directory") fails against a link a cloned repository can contain. Combined with
T-3 (environment secrets) and a model that can be steered by repo contents, this is a
plant-a-file-then-execute primitive: rop the workspace root's `.git/hooks/`, shell profiles,
or a path the agent's own `shell` tool will later run.

**Remediation.**
- Never append a literal tail after a successful resolution unless the *final* component
  is re-checked. For each missing component, `lstat` the link itself (`realpath` fails but
  `lstat` succeeds and `isSymbolicLink()` is true) and follow it with `readlink` + `resolve`,
  or simply refuse any path whose deepest existing ancestor is reached through a symlink
  whose target does not exist.
- Simplest robust form: resolve the parent directory with `realpath`, then check that the
  composed path's parent is still inside the root, and `O_NOFOLLOW` on open/write.
- Add tests for the dangling-link case on **both** trees (the existing test only covers an
  outside path that exists).

---

### T-2 — Desktop agent WebSocket is unauthenticated by default  *(Critical, Confirmed)*

**Location.** `apps/desktop/web/src/main.tsx:76` (`startAgent()` with no token) →
`apps/desktop/web/src/shell.ts:99` (token only set if provided) →
`apps/desktop/agent/src/server.ts:42-50` (`verifyClient` is `undefined` when no token).

**Technical explanation.** `server.ts` implements token auth correctly *when a token is
given*:

```ts
verifyClient: options.token ? (info) => new URLSearchParams(...).get("token") === options.token : undefined,
```

but the only caller, `main.tsx`, calls `startAgent()` without one, and `startAgent` only
forwards `options.token` if present. No token is generated anywhere in the desktop tree.
The result is a localhost WebSocket bound with **no origin check and no auth**, sitting on
an ephemeral port that is discoverable via `os.getSpawnedProcesses`, the `.tmp/agent.json`
file, or a port scan. The agent also exposes `agent.hello`, which returns the working
directory, and `config.get`, which returns the provider list *including credentials*.

**Reproduction.** Started the real server with an isolated (stub) bridge, connected with a
bare `new WebSocket("ws://127.0.0.1:<port>")` and **no token or query string**:

```
agent listening on port 39955 (no token configured)
connected with NO token and NO query string
agent.hello -> {"version":"0.0.0","cwd":"D:\\projects\\actor0","bridge":"node",...}
config.get -> providers: [{"name":"sapiens",...,"apiKey":"<REDACTED>"}, ...]
turn.send -> {"id":"3","result":{"turnId":"t1"}}
```

(The credential values printed by that run are the subject of §0.)

**Impact.** Any process running as the user — a malicious dependency's `postinstall`, a
second app, malware, or a script in a repository the user opens — can read the agent's
config and drive `turn.send`, which runs the full tool set in the working directory. The
`verifyClient` code shows the intent; the wiring does not deliver it.

**Remediation.**
- Generate the token in `startAgent` (`crypto.randomBytes(32).toString("hex")`) and pass it
  to the agent; the file/URL plumbing already exists.
- Also check `Origin` on the upgrade and require it be the shell's origin.

---

### T-3 — The shell tool passes the entire parent environment to the model  *(High, Confirmed)*

**Location.** `apps/cli/src/tools.ts:916` and `apps/desktop/agent/src/tools/shell.ts:168`:
`env: { ...process.env, ... }`. Nothing is scrubbed.

**Technical explanation.** The agent is documented (`index.ts:34`) to support one-run
overrides via `ACTOR0_API_KEY`, and reads `ACTOR0_BASE_URL`, `ACTOR0_MODEL`,
`ACTOR0_SEARCH_MCP_URL` from the environment. All of these — and every unrelated secret the
user exports — are inherited verbatim by every command the model runs.

**Reproduction (synthetic values only, re-run after §0):**

```
matching keys: ACTOR0_API_KEY,MY_SYNTHETIC_SECRET
leaked value: SYNTHETIC-AWS-VALUE
leaked value: SYNTHETIC-ACTOR0-KEY
```

**Impact.** A model steered by prompt injection (a web page via `web_search`, a file it
reads, an MCP server) can exfiltrate the user's provider credential and any cloud/CI secret
in the environment, either by printing it into the transcript it then sends to the provider,
or by POSTing it — for example a base URL under the attacker's control, or a `web_search`
query containing the value. The harness's `newMessages` finding (M-3 in the predecessor
report) is the complementary half.

**Remediation.** Build a minimal environment for the child: `PATH`, `HOME`/`USERPROFILE`,
`TMPDIR`, locale, and the shell-specific vars the resolver needs — explicitly omitting
`ACTOR0_*` and, ideally, an allow-list rather than a deny-list. If `ACTOR0_*` must reach a
child, strip the credential keys only.

---

### T-4 — Desktop `rg` resolves a "bundled" binary from the working directory  *(High, Confirmed)*

**Location.** `apps/desktop/agent/src/tools/rg.ts:44-56` (`bundledRgPath`).

**Technical explanation.** The search order includes the relative fallback
`join(process.cwd(), "resources", "bin")`. The desktop agent is launched with
`NL_PATH` as its cwd (`shell.ts:103-105`), so `process.cwd()` is the installed app
directory in production — but the same binary runs under `npm run dev`, in tests, and any
host that sets `ACTOR0_AGENT_CWD`, in which case `process.cwd()` is the *project* the user
opened. A repository that contains `resources/bin/rg.exe` therefore supplies the binary the
`rg` tool executes.

**Reproduction.** From a scratch project containing `resources/bin/rg.exe`:

```
[rg] resolveRg() from a project checkout -> …\resources\bin\rg.exe
```

**Impact.** Arbitrary code execution as the user, triggered by the first `rg` tool call, in
any dev/headless run of the desktop agent. It is a supply-chain-style vector: the repo need
only be opened. `ACTOR0_RG_PATH` is an explicit override and is fine; the untrusted part is
the **cwd-relative** fallback.

**Remediation.** Drop the `process.cwd()` candidate; resolve only from `NL_PATH`,
`ACTOR0_RG_PATH`, and `PATH`. If a dev convenience is wanted, gate it behind an explicit
env flag.

---

### T-5 — Desktop `shell` `background` flag spawns an unkillable process  *(Medium, Confirmed)*

**Location.** `apps/desktop/agent/src/tools/shell.ts:161-181` (`background`),
versus the CLI's shell, which has no such flag.

**Technical explanation.** With `background: true` the tool calls `child.unref()` and
returns immediately:

```ts
if (background) { child.unref(); return `[started in the background: ... pid ...]`; }
```

The `AbortSignal` handler is registered *after* this return, so a cancel never reaches it;
there is no timeout; and while `detached` is false on Windows (no new process group) the
PID is printed but nothing can be signalled. On POSIX the child *is* detached, so it
survives the parent outright. There is no registry the host can use to reap it.

**Impact.** A model can start an unbounded number of long-lived processes (dev servers,
miners, reverse shells) that survive cancel, session end, and app exit, with no UI surface
listing them. The desktop app's own shutdown (`index.ts` `dispose`) only aborts the current
turn's controller — it does not touch these children.

**Remediation.** Register background children so `dispose()`/`turn.cancel` can `killTree`
them, or remove the flag. If it stays, return a handle whose lifecycle the host can end.

---

### T-6 (Informational) — CLI `shell` has no per-turn process budget

`MAX_TIMEOUT_SECONDS = 3600` with no default (`tools.ts:105, 911-920`). "No timeout by
default" is documented and pinned by tests, and is defensible for long builds. Not a
finding, but combined with the unbounded rejection-only round loop (predecessor §5) a
hostile or confused model can occupy the machine indefinitely. A per-turn wall-clock budget
would close it without changing the per-command contract.

---

## 4. Reviewed and found sound

- **External-command injection in `shell`/`rg`/`rg` argv.** Commands go through
  `spawn(shell, [...prefix, command])` and `spawn("rg", argv)` — argv arrays, never
  `shell: true` string concatenation. No injection from a tool parameter into a shell.
- **CLI directory-symlink escape.** A non-dangling symlink to an outside directory is
  correctly refused (`through a link`). Only the dangling-tail case (T-1) escapes.
- **`edit` replacement semantics.** Both trees use `split(needle).join(replacement)`, so
  `$$`/`$&`/`$'` are literal; the desktop's `replaceAll` branch is correct (the
  if/else is redundant but not wrong).
- **Sub-agent recursion.** CLI `subagent.ts` and desktop `turn.ts` both hand sub-agents a
  delegate that refuses to recurse, so no unbounded fan-out.
- **`skills` loading.** Reads only `.actor0/skills/*.md`, renders as data, never executes;
  `renderSkill` uses split/join; collisions are reported, not silently won.
- **Secret redaction in status output.** `describeProviderInfo` masks the key
  (`config.ts:474`, `maskSecret`).
- **Desktop read/glob/rg containment.** Readers resolve real paths; the pinned test for a
  read outside the root is correct.

---

## 5. Remediation summary

| # | Fix | Effort |
|---|---|---|
| T-1 | Re-check/reject a dangling final symlink in `within` on both trees; add tests | M |
| T-2 | Generate and pass the agent token in `startAgent`; add an `Origin` check | S |
| T-3 | Allow-list the child environment instead of spreading `process.env` | S |
| T-4 | Remove the `process.cwd()` fallback from `bundledRgPath` | XS |
| T-5 | Track background children so shutdown/cancel can reap them, or drop the flag | S |

Suggested regression tests (offline, temp dirs): a dangling file symlink must be refused
by `write`/`edit` on both trees; a tokenless WS connection must be rejected; a child command
must not see `ACTOR0_API_KEY`; `resolveRg` must not return a cwd-relative path.

---

## 6. Remaining risks and limitations

- **No approval model exists to test.** Both registries state there is deliberately no
  gate. Nothing in the tool layer constrains *what* a permitted call does, only *where*
  (and that only weakly, per T-1). A user-visible confirmation for destructive verbs is a
  product decision outside this assessment.
- **T-2 was proven with a stub bridge.** The transport auth is independent of the bridge,
  so the result stands, but I did not drive a real file write through an unauthenticated
  socket end-to-end.
- **`process.cwd()` sensitivity of T-4** depends on how the packaged app sets cwd; I proved
  the resolution logic, not the packaged-launch placement.
- **Secret capture occurred (§0).** Any credential that entered this transcript should be
  treated as disclosed and rotated.
- **Not examined:** `apps/desktop/agent/src/{config,oauth,sessions,usage}.ts`,
  `apps/desktop/web/src/*` beyond the launch path, the bundled `rg` binary's own integrity,
  and `apps/cli/src/{mcp,mcp-serve}.ts`.
- **The repo is being modified concurrently** by another actor
  (`apps/desktop/web/src/App.tsx`, `styles.css`, `scripts/*`, untracked `*-shot.png`). I did
  not touch those files; my only artifact is the harness report.

---

## Appendix A — PoC index (all in `%TEMP%\a0poc\`, non-destructive unless noted)

| PoC | Finding | Notes |
|---|---|---|
| `tools-desktop.mts` | T-1, T-4 | dangling link + cwd-relative rg, temp dirs |
| `tools-cli-more.mts` | T-1 | CLI write via `createToolHost`, temp dirs |
| `sym1.mts` / `sym2.mts` | T-1 | first confirmation (both trees) |
| `ws1-desktop-auth.mts` | T-2 | **printed real config keys; deleted; see §0** |
| `env2.mts` | T-3 | synthetic values only |
| `env1.mts` | T-3 | first run; surfaced real env; superseded by `env2` |
