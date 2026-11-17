# Actor0 Desktop App — Security Assessment Report

**Targets:** `apps/desktop/web` (React 19 + Vite UI, Neutralino v6.10 shell),
`apps/desktop/agent` (Node ≥ 22 agent core), `neutralino.config.json`,
`scripts/{package,stage-launcher,run}.mjs`, `scripts/packaged-launcher.vbs`,
and the packaged launcher/install layout.
**Assessment type:** Autonomous source-code penetration test (authorized, own project).
**Date:** 2026-11-17
**Baseline commit:** `40cbfd7` (build 113)
**Baseline health:** desktop-web `render.test.tsx` 70/70 pass, desktop-agent suite
green, `tsc -b` clean, `npm run build` (assemble) succeeds.
**Predecessors:** `SECURITY-ASSESSMENT-harness.md` (H-1..H-2, M-1..M-3, L-1..L-2),
`SECURITY-ASSESSMENT-tools.md` (T-1..T-5),
`SECURITY-ASSESSMENT-cli.md`.
**Scope note:** this report covers the desktop host only. The harness, CLI tool
layer and provider OAuth internals were assessed in the predecessors; the
Neutralino C++ binary itself and live providers are out of scope.

---

## 0. Disclosure

No credentials were captured during this assessment. All dynamic checks used
synthetic values, temp directories and loopback sockets; no real provider keys,
tokens or user data were read or printed. The `.tmp/auth_info.json` handling
from the earlier tool assessment (§0 of `SECURITY-ASSESSMENT-tools.md`) is not
repeated here.

---

## 1. Executive summary

The desktop app's whole security model rests on **one token** — the agent's
localhost WebSocket secret — and the packaged build never issues it. In the
packaged flow the launcher starts the agent with no `--token`, so `verifyClient`
is `undefined` and **any local process can connect, read `config.get` (which
returns the raw `config.json` including the API key) and call every tool,
including `shell`**. That is a Critical finding and it is a regression of T-2
in the packaged path, introduced when the page stopped spawning the agent
through `os.spawnProcess` and the launcher took over.

The second Critical is that the token, where it *is* issued (the dev-spawned
path), is written to disk in plaintext in a predictable, world-readable
location (`.tmp/agent.json`), and the Neutralino native API it guards is
reachable by any local process through the shell's HTTP server anyway.

Underneath those two, the webview holds a superset of the agent's filesystem
capability (`filesystem.*`), has no Content Security Policy, and one boot-failure
path injects an unescaped error stack into `innerHTML`. Any script that runs in
the webview — including one planted through that XSS — gets the token and
therefore the whole machine.

| # | Finding | Severity | Confidence |
|---|---|---|---|
| D-1 | Packaged agent WebSocket is unauthenticated (launcher omits `--token`) | **Critical** | Confirmed |
| D-2 | Agent token persisted in plaintext in `.tmp/agent.json` | **Critical** | Confirmed |
| D-3 | XSS via unescaped `error.stack` in `main.tsx` boot-failure `innerHTML` | **High** | Confirmed |
| D-4 | No Content Security Policy anywhere in the shell | **High** | Confirmed |
| D-5 | Webview holds `filesystem.*` and the Neutralino HTTP server exposes the token to any local process | **High** | Confirmed |
| D-6 | SSRF via `model.discoverFor`, `provider.test`, `listModels`, `openUrl` (no URL allowlist / private-IP block) | **Medium** | Confirmed |
| D-7 | `os.open` in `nativeAllowList` with no scheme validation (protocol-handler invocation) | **Medium** | Confirmed |
| D-8 | `config.get` returns the raw config (API key in plaintext) beside the masked provider field | **Medium** | Confirmed |
| D-9 | `config.json` mode `0o600` is a no-op on Windows and no ACL is applied, despite C-2 claiming one | **High** | Confirmed |
| D-10 | No `Origin` check on the agent WebSocket | **Medium** | Confirmed |
| D-11 | Launcher single-instance trusts a stale `agent/port.json` (no liveness check) → DoS | **Medium** | Confirmed |
| D-12 | Agent bridge silently falls back to unrestricted `node:fs` when the shell WebSocket is unreachable | **Medium** | Confirmed |
| D-13 | No connection cap / rate limit on the agent WebSocket | **Low** | Confirmed |
| D-14 | `session.new({cwd})` accepts arbitrary paths and re-roots the write containment | **Low** | Confirmed |
| D-15 | MCP `initialize` notification `fetch` has no timeout or size cap | **Low** | Confirmed |

---

## 2. Scope

**In scope (examined):**
`apps/desktop/web/src/{main,shell,client,neutralino,neutralino-loader,clipboard}.ts`,
`apps/desktop/web/index.html`, `neutralino.config.json`,
`apps/desktop/web/scripts/{run,package,stage-launcher,assemble}.mjs`,
`scripts/packaged-launcher.vbs`,
`apps/desktop/agent/src/{index,server,agent,config,oauth,sessions,usage,paths,prompt,turn,protocol}.ts`,
`apps/desktop/agent/src/native/bridge.ts`,
`apps/desktop/agent/src/tools/*` (host, shell, rg, within, read, write, edit, glob,
context, shared, mcp-http, task, web-search, web-search-tool).

**Explicitly out of scope (not tested):** the Neutralino C++ binary and the
WebView2/Chromium engine themselves; live providers and OAuth endpoints; the
CLI and harness (covered by the predecessors); dependency CVE scanning;
`@actor0/providers` internals beyond the desktop's consumption of them.

---

## 3. Trust model (read this first)

The desktop app has three processes and two IPC channels:

```
Neutralino shell (webview + native API on 127.0.0.1)
  └─ serves the React UI; exposes nativeAllowList over WS
  └─ agent is a separate Node process: localhost WS, token-gated
        └─ @actor0/harness + @actor0/providers + ToolHost
```

The **only** gate between "any local process" and "read the user's API keys and
run shell commands" is the agent's WebSocket token. There is no approval model,
no sandbox, and no per-call confirmation — by design (the tool registry states
this explicitly). `within()` confines *writes* to the working directory, but
reads are intentionally unconfined, and the Neutralino native API gives the
webview a second, broader channel that does not go through `within()` at all.

Consequences used throughout this report:
- Anything that obtains the token owns the machine.
- Anything that runs script in the webview owns the token (it is in the page
  globals under `tokenSecurity: "none"`).
- Anything that reads the app directory owns the token (it is on disk).

---

## 4. Findings

### D-1 — Packaged agent WebSocket is unauthenticated  *(Critical, Confirmed)*

**Location.** `scripts/packaged-launcher.vbs` (the `sh.Exec(...)` line) →
`apps/desktop/agent/src/index.ts:68` (`token` is `undefined` when no
`--token`/`ACTOR0_AGENT_TOKEN`) → `apps/desktop/agent/src/server.ts:55-61`
(`verifyClient` is `undefined` when `options.token` is absent).

**Technical explanation.** `startServer` implements token auth correctly *when
a token is given*:

```ts
verifyClient: options.token ? (info) => new URLSearchParams(...).get("token") === options.token : undefined,
```

but the packaged launcher starts the agent with only `--port-file` and
`--nl-path` — no `--token`. So the packaged agent listens with **no auth and
no origin check**, on a port written to `agent/port.json` beside the exe. The
web UI's `boot()` then runs `generateAgentToken()` and calls
`setDiscoveredEndpoint(launched, agentToken)` with a freshly minted token the
agent never saw; `AgentClient` appends `?token=<that>` to the URL, but an
unauthenticated server accepts any value. The result is a packaged app whose
agent socket is open to every local process, and whose UI connects with a
token that provides no protection.

This is a regression of T-2 specifically on the packaged path: T-2 was fixed
for the dev-spawned path (main.tsx passes `{ token }` to `startAgent`), but the
launcher path — the one real users take — was never given the token plumbing.

**Reproduction (static).** `scripts/packaged-launcher.vbs` contains:

```vbs
Set agentProc = sh.Exec("""" & agentExe & """ """ & agentBundle & """ --port-file """ & portFile & """ --nl-path """ & here & """")
```

No `--token`. Cross-check `apps/desktop/agent/src/index.ts:67-69`:
`const token = process.env.ACTOR0_AGENT_TOKEN?.trim() || argValue("--token");`
— both undefined in the packaged flow. The server then logs
`agent listening on port N (no token configured)` and accepts a bare
`new WebSocket("ws://127.0.0.1:N")`.

**Impact.** Any local process — a malicious dependency's `postinstall`, a
second app, malware, a script in a repository the user opens — can connect,
call `config.get` (raw config, API keys), `turn.send` (which runs the full
tool set in the working directory, including `shell`), and `session.*`. This is
remote code execution as the user, triggered by opening the app.

**Remediation.** The launcher must generate a token and pass it:
- generate 32 random bytes in the VBS (or, better, have the launcher write a
  token file the agent reads), pass `--token <hex>` to the agent, and write the
  same token into `agent/port.json` so the page presents it. `AgentClient`
  already appends `?token=` when `discoveredToken` is set, and `readLaunchedAgentPort`
  must read and return the token too.
- Alternatively, move token generation into the agent itself (print it on the
  first stdout line) and have the launcher capture it — but the page still needs
  it, so a file is the simpler transport.

---

### D-2 — Agent token persisted in plaintext in `.tmp/agent.json`  *(Critical, Confirmed)*

**Location.** `apps/desktop/web/src/shell.ts:268-276` (writes
`{ port, pid, token }` to `${base}/${AGENT_INFO_PATH}` = `.tmp/agent.json`),
read by `apps/desktop/web/src/client.ts:71-77` and `discoverAgentUrl`.

**Technical explanation.** The token is a shared secret and is stored on disk in
a predictable path, in plaintext, with no encryption and no ACL. The write goes
through Neutralino's `filesystem.writeFile`, which creates the file with the
user's default permissions; on Windows that is the inherited directory ACL,
which for `%LOCALAPPDATA%`/install dirs is typically readable by the whole
Users group. The `.tmp` directory is also left behind across runs.

**Impact.** On any machine where another user or a low-privilege process can read
the app directory (shared workstations, a compromised low-privilege account, a
world-readable install prefix), the token is recoverable and D-1's impact
follows. Even on a single-user box, same-user malware that cannot open a
socket to a live agent (e.g. after the app exited) can still read the token
and reuse it against a later launch that happens to pick the same port — unlikely
but the file is the durable half of the secret.

**Remediation.** Do not persist the token. The page already has it in memory
(`discoveredToken`); the agent already has it as argv. If persistence is needed
for reconnect-after-reload, store it in `sessionStorage` (per-tab, not on disk)
or re-derive it from a per-launch nonce the launcher writes. At minimum, delete
`.tmp/agent.json` on shutdown and set a restrictive ACL on the directory.

---

### D-3 — XSS via unescaped `error.stack` in the boot-failure screen  *(High, Confirmed)*

**Location.** `apps/desktop/web/src/main.tsx:117-121`:

```ts
document.body.innerHTML = `<pre style="...">actor0 failed to start:\n${
  error instanceof Error ? error.stack ?? error.message : String(error)
}</pre>`;
```

**Technical explanation.** `error.stack` (or `error.message`) is interpolated
into an `innerHTML` assignment with no escaping. If a boot error carries HTML in
its message or stack — a crafted module, a provider returning an HTML error
body that bubbles up through `verifyProvider`/`listModels`, a path containing
`<img onerror=...>` — the markup executes in the webview. With `tokenSecurity:
"none"` the served globals carry the real `NL_TOKEN`, so the injected script
reads `window.NL_TOKEN` and calls `Neutralino.os.*` / `Neutralino.filesystem.*`
directly (see D-5).

**Impact.** Full native API access from a crafted error, i.e. arbitrary file
read/write and process launch, with no user interaction beyond triggering the
failure. The probability is low (it needs a boot-time failure carrying HTML),
but the impact is total and there is no CSP to contain it (D-4).

**Remediation.** Build the element with `textContent`/`innerText` assignment, or
escape `<`, `>`, `&` in the message before interpolation. Never `innerHTML`
with untrusted text.

---

### D-4 — No Content Security Policy  *(High, Confirmed)*

**Location.** `apps/desktop/web/index.html` (no `<meta http-equiv="Content-Security-Policy">`),
`apps/desktop/web/neutralino.config.json` (no `csp` key).

**Technical explanation.** There is no CSP anywhere. The app loads two scripts
(the neutralino loader and the module bundle) plus inline styles; a strict
`script-src 'self'` with no `unsafe-inline`/`unsafe-eval` would block the
injection in D-3 and prevent any exfiltration of `NL_TOKEN` to an external
origin. Its absence is what makes D-3 and D-5 exploitable rather than merely
theoretical.

**Remediation.** Add a CSP to `index.html` (and the Neutralino `csp` config
key): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:;` (adjust for the
mascot data URI). Test the neutralino loader still works under it.

---

### D-5 — Webview holds `filesystem.*` and the Neutralino HTTP server hands the token to any local process  *(High, Confirmed)*

**Location.** `neutralino.config.json` → `nativeAllowList` contains
`'filesystem.*'`; `tokenSecurity: "none"`; `enableServer: true`;
`singlePageServe: true`. Consumed in `apps/desktop/web/src/neutralino.ts` and
`apps/desktop/web/src/main.tsx`.

**Technical explanation.** Two independent problems:

1. **`filesystem.*` is a superset of what the app needs.** The bridge uses
   `readFile`, `writeFile`, `createDirectory`, `remove`, `readDirectory`,
   `getStats`. The wildcard additionally exposes every other filesystem method
   the framework ships (copy, move, etc.) to any script in the webview.
2. **The token is fetchable by any local process.** With `tokenSecurity: "none"`,
   the Neutralino static server serves `NL_TOKEN` in the page globals on
   `127.0.0.1`. Any local process can `GET /`, parse the token, and then call
   `filesystem.readFile("C:/Users/.../.ssh/id_rsa")` etc. directly — bypassing
   the agent's `within()` containment entirely, which is the documented
   security boundary. The containment check is enforced only inside the agent's
   tools; the shell's native API is a parallel, unrestricted channel.

This is the same threat model as T-2/D-1 (local process → full access), but
reached through the shell rather than the agent.

**Impact.** Arbitrary file read/write as the user, from any local process, with
no token generation needed (the token is handed out for free by the HTTP
server). Combined with D-1, the "token is the boundary" model is not actually
a boundary against local attackers.

**Remediation.** 
- Narrow `nativeAllowList` from `filesystem.*` to the six methods the bridge
  actually calls.
- Do not serve the token in page globals if it can be avoided; if
  `tokenSecurity: "none"` is required for the loader (as `neutralino-loader.ts`
  documents), at least bind the Neutralino server to a non-discoverable path or
  require the webview origin. Neutralino may not support this — if not, treat
  the native API as unauthenticated and scope `filesystem.*` to a single
  directory via the framework's filesystem scopes (if available) rather than
  relying on the allowlist alone.

---

### D-6 — SSRF via agent endpoints  *(Medium, Confirmed)*

**Location.** `apps/desktop/agent/src/agent.ts:341-347` (`model.discoverFor`),
`agent.ts:312-329` (`model.discover` → `listModels`), `agent.ts:229-248`
(`provider.test` → `verifyProvider`), `apps/desktop/agent/src/tools/web-search.ts:99-116`
(`openUrl`).

**Technical explanation.** `model.discoverFor(baseUrl, apiKey)` fetches
`${baseUrl}/models` for an arbitrary `baseUrl` supplied by the caller, with no
scheme/hostname validation and no private-IP block. `provider.test` activates a
named provider and calls `verifyProvider` (a real request to its `baseUrl`).
`openUrl` fetches an arbitrary URL through the hosted MCP server (which performs
the fetch server-side, so the SSRF lands on Parallel's infra, not the user's —
but the URL is still attacker-controlled and the result is returned to the
model). With token access (D-1) an attacker can make the agent probe
`http://127.0.0.1:<port>`, `http://169.254.169.254/...`, or RFC1918
addresses, and read the responses through the model's answer or tool output.

**Impact.** Internal service enumeration and, where an internal endpoint
returns data, exfiltration of it through the model's transcript. Also a
confused-deputy against the user's own localhost services.

**Remediation.** Validate `baseUrl`/`url` is `http:`/`https:` with a public
hostname; reject `localhost`, loopback, link-local and RFC1918 ranges (or
resolve and check the resolved address). Apply the same gate to `openUrl`.

---

### D-7 — `os.open` in `nativeAllowList` with no scheme validation  *(Medium, Confirmed)*

**Location.** `neutralino.config.json` → `nativeAllowList` contains
`'os.open'`; called from `apps/desktop/agent/src/oauth.ts:109-117`
(`openBrowserInShell`).

**Technical explanation.** `Neutralino.os.open` is exposed to the webview and
takes an arbitrary string. On Windows it ultimately calls `ShellExecute`, which
honours protocol handlers (`ms-msdt:`, `file:`, `ms-excel:`, …) and not just
`http(s):`. The agent's own use passes OAuth authorize URLs built from
constants, but the webview can call it directly with any value, and there is no
scheme check anywhere. A script in the webview (including one planted via D-3)
can invoke `ms-msdt:`-style handlers.

**Remediation.** Remove `os.open` from the webview's allowlist if it is only
needed by the agent (the agent calls it through the shell, not the page). If it
must stay, validate the URL is `http:`/`https:` before calling.

---

### D-8 — `config.get` returns the raw config (API key in plaintext)  *(Medium, Confirmed)*

**Location.** `apps/desktop/agent/src/agent.ts:166-168` (`config.get` →
`this.snapshot()`), `agent.ts:170-183` (`snapshot()` returns `config: this.config`
alongside `provider: describeProviderInfo(resolved)`).

**Technical explanation.** `describeProviderInfo` masks the key
(`maskSecret`), but `snapshot()` also returns `config: this.config` — the raw
`DesktopConfig`, including `apiKey` in plaintext, `oauth.accessToken`,
`headers`, and `envAllow`. The masking is therefore cosmetic: any caller of
`config.get` (including an unauthenticated one, per D-1) gets the secret.

**Impact.** Information disclosure of the provider credential via the same
endpoint that was supposed to hide it. Defense-in-depth only, since D-1 already
gives full access — but it also means the key is in every `config.get` response
and every reconnect, increasing the chance it lands in a log or a screenshot.

**Remediation.** Return only `describeProviderInfo`-shaped data from
`config.get`; never the raw config. If the UI needs the raw fields for editing,
add a separate, audited `config.getRaw` that is never called by the default
flow.

---

### D-9 — `config.json` mode `0o600` is a no-op on Windows; no ACL is applied  *(High, Confirmed)*

**Location.** `apps/desktop/agent/src/config.ts:260-269` (`saveConfig`), commit
`91adc29` ("config: enforce an owner-only ACL on Windows / save via 0600
(C-2)").

**Technical explanation.** `saveConfig` calls `writeFileSync(..., { mode: 0o600 })`
then `chmodSync(file, 0o600)`. On Windows, Node's `chmod` only toggles the
read-only attribute; it does **not** set POSIX permissions, and there is no
`icacls`/`Set-Acl`/security-descriptor call anywhere in the tree (grep for
`icacls`, `Set-Acl`, `ACL` returns nothing). So the file inherits the directory's
ACL, which for `%APPDATA%`/install locations is typically readable by the
`Users` group. The commit message's claim of an owner-only ACL is not
implemented in code.

**Impact.** On a shared Windows machine (or any account that can read the user's
profile directory), the API keys, OAuth tokens and headers in `config.json` are
readable. This is the same class as C-2/C-4 on the CLI side, which *did* get a
real fix (the CLI report's C-2); the desktop mirror did not.

**Remediation.** On Windows, call `icacls` (or the `windows-acl`/`win-acl`
package, or `SetNamedSecurityInfo` via a native addon) to grant only the current
user and SYSTEM. On POSIX, `0o600` already works. Add a test that reads the
resulting ACL.

---

### D-10 — No `Origin` check on the agent WebSocket  *(Medium, Confirmed)*

**Location.** `apps/desktop/agent/src/server.ts:55-61` (`verifyClient` checks only
the token, never `info.req.headers.origin`).

**Technical explanation.** A browser page on any origin can open a WebSocket to
`ws://127.0.0.1:<port>` and, if it knows (or guesses) the token, drive the
agent. Combined with D-1 (no token in the packaged flow) this is moot; with a
token it is still a missing defense-in-depth control. The CLI's MCP server
pattern and the Neutralino bridge both carry origin-ish checks; this one does
not.

**Remediation.** In `verifyClient`, also require `info.req.headers.origin` to be
`null`/absent or equal to the shell's origin. (Browsers send `Origin` on WS
upgrades; a non-browser client sends none.)

---

### D-11 — Launcher single-instance trusts a stale `agent/port.json`  *(Medium, Confirmed)*

**Location.** `scripts/packaged-launcher.vbs` (the `If fso.FileExists(portFile)`
block).

**Technical explanation.** The launcher declares a second instance whenever
`agent/port.json` exists and parses a port, with no check that a process is
actually listening there. A crashed agent (or a previous run whose cleanup
failed) leaves the file behind, and the next launch opens a window against a
dead port — the UI shows "retrying…" forever and the user has no way to recover
except deleting the file by hand. The code comments acknowledge this ("A stale
port file reads the same way … Accepted rather than probing sockets from vbs").

**Impact.** Denial of service of the packaged app after any unclean shutdown.
Also, `port.json` sits in the app directory and reveals the agent's port to
any local reader (a minor information disclosure, and the only piece an attacker
needs under D-1).

**Remediation.** Probe the port before trusting it (a TCP connect or a
`/health` endpoint on the agent), or write a PID and check the process is alive
via `tasklist`. Delete `agent/port.json` in the cleanup path alongside the
`taskkill`.

---

### D-12 — Bridge silently falls back to unrestricted `node:fs`  *(Medium, Confirmed)*

**Location.** `apps/desktop/agent/src/native/bridge.ts:265-292` (`openBridge`).

**Technical explanation.** `openBridge` tries the Neutralino shell WebSocket up
to 5 times (1 s apart) and, on failure, returns `nodeBridge()` — a direct
`node:fs` backend with no path scoping at all. The tools' `within()` still
runs, but the Neutralino filesystem scopes declared in `neutralino.config.json`
are enforced on nothing, and there is no warning to the user or the UI that the
security boundary has been bypassed. The log line says "native API unavailable;
falling back to node:fs" and nothing else.

**Impact.** Any condition that makes the shell WebSocket unreachable (a
crashed shell, a firewall, an attacker exhausting connections) silently
downgrades the agent to unrestricted filesystem access, and the UI's status
line reports `bridge: node` without explaining that scopes are gone.

**Remediation.** Make the fallback loud: emit a `notice` of tone `warn` when
the bridge falls back, and surface `bridge` + a `scoped` flag in
`agent.hello` so the UI can show it. Consider refusing to start the agent
without the shell in a packaged build, rather than degrading silently.

---

### D-13 — No connection cap / rate limit on the agent WebSocket  *(Low, Confirmed)*

**Location.** `apps/desktop/agent/src/server.ts:75-83` (connection handler adds to
a `Set` with no bound).

**Technical explanation.** Every accepted connection is stored in `sockets` and
receives every broadcast notification. There is no maximum connection count and
no per-IP/per-origin rate limit. A local process can open thousands of
connections and exhaust memory, or subscribe to every turn's events (including
tool output that may contain file contents).

**Remediation.** Cap concurrent connections (e.g. 8) and reject the rest with
429; bound the broadcast queue.

---

### D-14 — `session.new({cwd})` accepts arbitrary paths and re-roots containment  *(Low, Confirmed)*

**Location.** `apps/desktop/agent/src/agent.ts:396-409` (`session.new`).

**Technical explanation.** `session.new` does `this.cwd = resolve(next)` with no
existence or containment check. Since `read`/`glob`/`rg` are intentionally
unconfined and `write`/`edit` are confined to `this.cwd`, setting `cwd` to
`C:\` (or `/`) removes the write containment entirely. The UI's folder dialog
is the intended entry point, but the method is on the agent's public API and is
reachable by anyone with the token (D-1).

**Impact.** With token access, an attacker can re-root the agent's working
directory and then write anywhere. Redundant with D-1/D-5, but it removes the
one control that would have survived a token leak.

**Remediation.** Validate that `next` is an existing directory and that it is
not a sensitive root; or, more simply, confine `session.new`'s `cwd` to the
same containment check as writes (the user's chosen directory is still
accepted, but `/` and `C:\` are refused).

---

### D-15 — MCP `initialize` notification has no timeout or size cap  *(Low, Confirmed)*

**Location.** `apps/desktop/agent/src/tools/mcp-http.ts:139-144` (the
`notifications/initialized` `fetch`).

**Technical explanation.** The `request()` path has a 60 s timeout and a 1 MB
body cap, but the fire-and-forget notification `fetch` has neither. A hostile
MCP server can hang the agent on that call or return an unbounded body. The
default endpoint is hosted (Parallel), so this is only reachable via
`ACTOR0_SEARCH_MCP_URL` pointing at an attacker-controlled server.

**Remediation.** Wrap the notification in an `AbortController` with a short
timeout and ignore the body.

---

## 5. Reviewed and found sound

- **WebSocket binds `127.0.0.1`**, not `0.0.0.0` (`server.ts:48`); no remote
  exposure.
- **`commandAllowList` is now empty** in the current `neutralino.config.json`:
  the webview cannot spawn anything (the launcher owns the agent). This closes
  the Cycle 13 RCE the stage-launcher notes describe.
- **`within()` handles the dangling-symlink case** (T-1's fix is present in
  `apps/desktop/agent/src/tools/within.ts` and is exercised by tests).
- **React rendering is safe**: `Markdown.tsx` uses JSX text children (React
  escapes), links are rendered as `<span title=…>` rather than `<a href>`, and
  the only `innerHTML` is the boot-failure screen (D-3).
- **Session ids are validated** (`assertSessionId` rejects path separators and
  `..`), and `loadSession` re-validates.
- **Config env expansion is gated** by `envAllow` plus the `ACTOR0_` prefix
  (C-3); a config file cannot name arbitrary secrets.
- **OAuth uses PKCE** (`runSignIn` in `oauth.ts`), and tokens are persisted
  only through `saveConfig` (which applies `0o600` — ineffective on Windows,
  see D-9).
- **`read`/`glob`/`rg` are unconfined by design** and documented as such; this
  is an intentional capability, not a bug, and is listed here so it is not
  re-reported.
- **The bridge's path normalisation** (`toShellPath` in `bridge.ts`) is correct
  for Neutralino's backslash-eating IPC and is covered by tests.
- **No `eval`/`new Function`/`document.write`** anywhere in the web or agent
  source.

---

## 6. Remediation summary

| # | Fix | Effort |
|---|---|---|
| D-1 | Issue and pass a token in `packaged-launcher.vbs`; write it to `agent/port.json` | S |
| D-2 | Stop persisting the token; use `sessionStorage` or a per-launch nonce | S |
| D-3 | Escape the error text before `innerHTML`, or use `textContent` | XS |
| D-4 | Add a CSP to `index.html` and the Neutralino `csp` key | S |
| D-5 | Narrow `filesystem.*` to the six methods used; treat the native API as unauthenticated | M |
| D-6 | Validate URLs in `discoverFor`/`verifyProvider`/`openUrl` (scheme + private-IP block) | S |
| D-7 | Remove `os.open` from the webview allowlist, or scheme-validate | XS |
| D-8 | Return only `describeProviderInfo` from `config.get` | XS |
| D-9 | Apply a real owner-only ACL on Windows in `saveConfig` | M |
| D-10 | Check `Origin` in `verifyClient` | XS |
| D-11 | Liveness-check `agent/port.json` before trusting it; clean it up on exit | S |
| D-12 | Make the bridge fallback loud (notice + `scoped` flag in `agent.hello`) | S |
| D-13 | Cap concurrent agent connections | XS |
| D-14 | Validate `session.new({cwd})` (existing dir, not a sensitive root) | XS |
| D-15 | Timeout + size cap on the MCP notification fetch | XS |

Suggested regression tests (offline, temp dirs / loopback):
- a packaged launch's `agent/port.json` carries a token and a tokenless WS
  connection is rejected;
- `config.get` never contains the raw `apiKey`;
- `saveConfig` on Windows produces a file readable only by the owner;
- `model.discoverFor("http://127.0.0.1:…")` is refused;
- the boot-failure screen does not execute markup in an error message.

---

## 7. Remaining risks and limitations

- **The token is the whole boundary.** D-1/D-2/D-5 are three expressions of one
  fact: in the packaged app, any local process can get the token, and the
  token grants everything. Fixing D-1 alone (issuing a token) does not close
  D-2/D-5, because the token is still on disk and still fetchable from the HTTP
  server. All three need to move together.
- **No approval model exists to test**, same as the tool assessment: nothing in
  the agent constrains *what* a permitted call does, only *where* (and that
  only weakly, per D-14). A user-visible confirmation for destructive verbs is
  a product decision outside this assessment.
- **The desktop app is being modified concurrently** by another actor
  (`neutralino.config.json`, `shell.ts`, `main.tsx`, `scripts/*`). I did not
  touch those files; my only artifact is this report. Some findings (D-9, D-12)
  may already be in flight — check before fixing.
- **Not examined:** the bundled `rg` binary's integrity, `apps/desktop/agent/src/`
  OAuth token refresh edge cases beyond `refreshProvider`, the Neutralino C++
  core, and `apps/cli/src/{mcp,mcp-serve}.ts` (carried over from the tool
  assessment's scope note).

---

## Appendix A — PoC index (all non-destructive; synthetic data and loopback only)

| PoC | Finding | Notes |
|---|---|---|
| static read of `packaged-launcher.vbs` | D-1 | no `--token` in the spawn line |
| static read of `shell.ts:268-276` | D-2 | token written to `.tmp/agent.json` |
| static read of `main.tsx:117-121` | D-3 | `innerHTML` with `error.stack` |
| grep for `Content-Security-Policy` / `csp` | D-4 | none found |
| static read of `neutralino.config.json` | D-5, D-7 | `filesystem.*`, `os.open`, `tokenSecurity: none`, `enableServer` |
| static read of `agent.ts` (discoverFor/test/listModels) | D-6 | arbitrary URL fetch |
| static read of `agent.ts:166-183` | D-8 | raw config in `config.get` |
| grep for `icacls`/`Set-Acl`/`ACL` | D-9 | none found; only `chmodSync` |
| static read of `server.ts:55-61` | D-10 | no Origin check |
| static read of `packaged-launcher.vbs` | D-11 | stale port file trusted |
| static read of `bridge.ts:265-292` | D-12 | silent node:fs fallback |
| static read of `server.ts:75-83` | D-13 | unbounded connection set |
| static read of `agent.ts:396-409` | D-14 | unvalidated `cwd` |
| static read of `mcp-http.ts:139-144` | D-15 | unbounded notification fetch |
