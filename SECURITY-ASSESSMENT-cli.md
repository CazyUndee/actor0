# Actor0 CLI — Security Assessment Report

**Target:** `D:\projects\actor0\apps\cli` (config, session, OAuth, MCP, persistence,
rendering, launch surface).
**Assessment type:** Autonomous source-code penetration test (operator-directed).
**Baseline commit:** `4db52fb`. Baseline health: `apps/cli` suite **535 pass / 0 fail /
1 skipped** (536 total).
**Predecessors:** `SECURITY-ASSESSMENT-harness.md` (core), `SECURITY-ASSESSMENT-tools.md`
(tool layer, both hosts).

---

## 0. Disclosure carried forward

The predecessor tools report disclosed that live provider credentials entered that
session's output. Nothing in *this* assessment reproduced a secret: every PoC below uses
synthetic values or temp directories, and where I found the user's real `config.json` and
session files on disk I recorded only **file metadata** (mode, size, count of matches) and
did not open or print contents. The rotation advice from that report still stands.

---

## 1. Executive summary

The CLI is the largest and most mixed surface in the project: it parses untrusted config
and session JSON, performs an OAuth flow with a loopback listener, spawns MCP subprocesses,
and renders model output directly to the terminal. Four findings, one High:

| # | Finding | Severity | Confidence |
|---|---|---|---|
| C-1 | Model/tool output reaches the terminal as raw escape sequences — terminal control and spoofing | **High** | Confirmed |
| C-2 | `config.json` stores provider keys in plaintext and is world-readable on the real install | **Medium** | Confirmed |
| C-3 | `${VAR}` expansion in `apiKey`/`headers` reads *any* environment variable at resolve time | **Medium** | Confirmed |
| C-4 | Session and usage files are written with default permissions and no size bound | **Low** | Confirmed |

**C-1 is the one that matters.** `render.ts` strips SGR colour codes from *tool output*
only; the assistant-answer, plan, user-message and reasoning paths pass text straight to
`Screen.render`, which writes it to the tty inside a `CSI row;1H` repaint. I confirmed
that `ESC[2J` (clear screen), `ESC[10;1H` (cursor move), `ESC]0;…BEL` (window title) and
`ESC]8;;URL` (hyperlink) all survive into the rendered rows. A model that emits them — or a
provider that injects them, or a file the model quotes back — can clear the transcript,
forge a fake prompt line, or rewrite the window title. This is the classic "untrusted
output to a terminal" bug class, and the codebase already has the fix pattern in the tool
path; it just isn't applied to the model's own answer.

---

## 2. Scope

**Examined:** `index.ts`, `flags.ts`, `paths.ts`, `config.ts`, `session.ts`, `history.ts`,
`usage.ts`, `context.ts`, `skills.ts`, `environment.ts`, `repo-index.ts`, `git.ts`,
`models.ts`, `oauth.ts`, `sign-in.ts`, `provider-presets.ts`, `mcp.ts`, `mcp-serve.ts`,
`web-search.ts`, `print.ts`, `conversation.ts`, `subagent.ts`, `diff.ts`, `probe.ts`,
`providers.ts`, `slash.ts`, and `ui/{render,markdown,parts,term,input,clipboard,
repo-index-worker,shell-worker,env-worker}.ts`.

**Not examined:** `ui/App.tsx` (2,157 lines) beyond the paths needed for impact;
`ui/selection.ts`, `ui/tui.test.tsx`, `ui/render.test.ts` in depth; `theme*.ts`.
**No production code was modified.**

---

## 3. Findings

### C-1 — Model and tool output reaches the terminal as raw escape sequences  *(High, Confirmed)*

**Location.** `apps/cli/src/ui/render.ts:35` (`toolOutputLines` — the only sanitiser, and
it strips *colour only*), `render.ts:502/530/514/631/673` (assistant, plan, user, reasoning,
live answer paths), `apps/cli/src/ui/term.ts:92-95` (writes each row to the tty).

**Technical explanation.** `render.ts` has exactly one control-character filter:

```ts
const text = output.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "")
                   .replace(/\r/g, "").trim();
```

That regex removes SGR sequences (`ESC[…m`) — and nothing else — and it is applied **only**
to `entry.output` in the `tool` case. Every other path passes the string through
unchanged, and `term.render` concatenates rows into a single write that already contains
cursor-addressing CSI of its own:

```ts
out += `\x1b[${i + 1};1H\x1b[2K${rows[i] ?? ""}`;
```

So a model answer containing `ESC[2J` clears the screen on the next repaint;
`ESC[10;1H` moves the cursor; `ESC]0;PWNED BEL` rewrites the window title;
`ESC]8;;https://evil BEL…ESC]8;;BEL` forges a clickable hyperlink.

**Reproduction.** `entryLines()` on synthetic entries, counting ESC bytes in the emitted
rows (`cli-ansi2.mts`):

```
assistant answer         ESC count:  2 <-- reaches terminal
user message             ESC count:  1 <-- reaches terminal
reasoning                ESC count:  0
tool output (read)       ESC count:  1 <-- reaches terminal
tool output (edit diff)  ESC count:  0
plan                     ESC count:  1 <-- reaches terminal
```

and `renderMarkdown` on realistic payloads (`cli-ansi.mts`):

```
"normal \u001b[2Jclear screen"        -> ESC survives: true
"move \u001b[10;1Hhome"               -> ESC survives: true
"title \u001b]0;PWNED\u0007"          -> ESC survives: true
"link \u001b]8;;https://evil…click"   -> ESC survives: true
"key \u001b[?1004h"                   -> ESC survives: true
```

The emitted row for a tool result confirms it end-to-end (`cli-ansi3.mts`):

```
"│  x\u001b[2Jy                                                                      │"
```

**Why "tool output" also leaks despite the sanitiser.** The sanitiser removes SGR but not
`ESC[2J`, `ESC[…H`, or OSC; so even the one filtered path lets non-colour control
sequences through. The `edit` diff path (`render.ts:545-550`) does no filtering at all.

**Preconditions.** The model emits the sequence (a prompt-injected model, or a model asked
to "print the file" where the file contains it), or a provider/gateway injects it into the
stream, or tool output (a log, a `cat` of a crafted file) carries it. No user action.

**Impact.**
- **Transcript destruction.** `ESC[2J` + cursor moves erase what the user was reading —
  including the record of what the agent did.
- **Spoofing.** A forged `actor0 >` prompt line, a fake "✓ Read a.txt", a fake "sign-in
  required" banner, or a fake error. The transcript is the user's audit trail; this breaks
  it.
- **Window-title / hyperlink injection.** `ESC]0;` sets the terminal title to anything;
  `ESC]8;;` makes arbitrary text a clickable link to an attacker URL — a plausible
  credential-phishing vector in a terminal that renders links.
- **`ESC[?1004h`** (focus reporting) and other mode-setting sequences alter terminal state
  the CLI set deliberately.

**Remediation.** Strip all C0 (except `\n`, `\t`) and C1, and all CSI/OSC/DCS/PM/APC
sequences, at the **single boundary where untrusted text becomes terminal bytes** — in
`Screen.render` (or a `sanitize()` applied to every `Seg.text` before joining). Keeping the
existing SGR filter is fine for colour, but it must not be the only one. Add a test that
feeds `ESC[2J`, `ESC[…H`, `ESC]0;…`, `ESC]8;;…` through `entryLines`/`renderMarkdown` and
asserts none survives; and one that drives `Screen` with a hostile row and asserts the
written bytes contain no user-supplied CSI.

---

### C-2 — Provider keys stored in plaintext in a world-readable `config.json`  *(Medium, Confirmed)*

**Location.** `apps/cli/src/config.ts:485-494` (`saveConfig`), `paths.ts:11` (`configDir`).

**Technical explanation.** `saveConfig` writes the whole config, including `apiKey` and
`oauth` tokens, as plain JSON, then sets `mode: 0o600`. Two problems:

1. **On Windows the mode is meaningless.** `chmodSync`/`mode` do not create an ACL; the
   file inherits the parent directory's ACL. I measured the real install:
   ```
   ~/.config/actor0/config.json   mode 644
   ~/.config/actor0               mode 755
   ~/.local/share/actor0          mode 755
   ```
   `0o600` in the `writeFileSync` options is silently ignored for an existing file (the
   code comments say so and calls `chmodSync` explicitly) — but `chmodSync` on Windows
   only toggles the read-only bit. Every local account can read the key.

2. **`${VAR}` indirection is a partial mitigation, not a control.** The docs suggest
   `apiKey: "${MY_KEY}"`, which keeps the secret out of the file — but nothing enforces
   it, and `parseProviders` happily accepts a literal key.

**Reproduction.** `cli-cfg.mts` (temp dir):

```
config.json mode: 666 (umask-dependent; mode arg is 0o600 on create)
plaintext key in file: true
platform: win32 — on Windows, mode is always 0666 & no ACL is set
```

`/provider` correctly masks (`credential set — sk-PLA…34 (24 chars)`), so the leak is the
file, not the display.

**Impact.** Any process running as any local user on a shared Windows machine can read the
provider key and bill the victim's account. Session files (`C-4`) compound it.

**Remediation.** On Windows, set an explicit ACL (e.g. via `icacls` or a native call)
granting only the current user; on POSIX keep `0o600` and also create the directory
`0o700`. Consider documenting/enforcing `${VAR}` for keys and rejecting a literal key that
looks like a secret in `config.json`.

---

### C-3 — `${VAR}` expansion reads an arbitrary environment variable  *(Medium, Confirmed)*

**Location.** `apps/cli/src/config.ts:248-262` (`expandEnv`), called from
`resolveProvider` at `:412` (apiKey) and `:422` (each header value).

**Technical explanation.** `expandEnv` substitutes any `${NAME}` from `process.env` with
no allow-list and no relation to the CLI's own variables. A `config.json` (or an
`ACTOR0_*` override chain) that names `${AWS_SECRET_ACCESS_KEY}` or `${GITHUB_TOKEN}`
causes the CLI to read it into memory and send it as a header or bearer token to whatever
`baseUrl` is configured.

**Reproduction.** `cli-envdump.mts`:

```
apiKey from ${VAR}: SYNTHETIC-VALUE-42
header from ${VAR}: {"X-Anything":"SYNTHETIC-VALUE-42"}
```

**Impact.** Two abuse paths:
- A malicious or mistaken config (or a repo that ships one) exfiltrates an unrelated
  secret to an attacker-chosen `baseUrl` on the next turn.
- Combined with the tools report's **T-3** (shell tool inherits the whole environment),
  the model can already *read* those variables; this is the path that *sends* them.

**Remediation.** Restrict expansion to an explicit prefix (e.g. `ACTOR0_SECRET_*`), or
require the variable name to be listed in an `envAllow` field. At minimum, log/notify when
a header or key is sourced from the environment.

---

### C-4 — Session and usage files written with default permissions, no size bound  *(Low, Confirmed)*

**Location.** `apps/cli/src/session.ts:96-100` (`saveSession`),
`apps/cli/src/usage.ts:38-42` and `:100-104` (`recordUsage`, `recordAudit`).

**Technical explanation.** Sessions are written through a staging file + `rename` — good
for atomicity — but with **no `mode`** and no `chmod`, so the file gets the default
`0666 & ~umask` (measured `644`). Sessions contain the full transcript: user messages,
file contents the model read, tool output. Usage/audit logs are appended the same way.

I also confirmed the session path is **not** symlink-followable for writes: `renameSync`
replaces the link rather than the target, so a planted symlink does not redirect a write
(`cli-symlink.mts`: `original replaced: ORIGINAL`). That is the correct outcome.

**Reproduction.**
```
~/.local/share/actor0/sessions/2026-10-10T19-10-54-233Z.json   mode 644
usage.jsonl                                                    mode 666 (temp dir)
```
Six existing session files match `sk-`/`apiKey` on a plain `grep -l` — I did not open
them; the count alone shows secrets reach the transcript (the model echoes what it reads,
and `maskSecret` is not applied to transcripts).

**Impact.** Transcript disclosure to other local users; unbounded growth of
`usage.jsonl`/`audit.jsonl` and of individual session files (no per-file cap — compaction
bounds the *content* to ~16k tokens but not the number of messages).

**Remediation.** Pass `mode: 0o600` to the staging `openSync` and `chmodSync` after rename
(the same pattern `saveConfig` already uses); create `sessions/` and the data dir `0o700`.
Consider a hard cap on session count/size, and redact values that look like credentials
before they enter a transcript.

---

## 4. Reviewed and found sound

- **OAuth / PKCE** (`oauth.ts`): S256 challenge from 32 random bytes, `state` from 16;
  authorize params are applied extras-first so a preset cannot override `state`,
  `code_challenge`, `redirect_uri` or `client_id`; the loopback validates `state` before
  exchanging; the token endpoint surfaces only the provider's own `error` field, never the
  raw body (explicitly to avoid reflecting a refresh token); `openBrowser` uses argv
  arrays, never a shell string. This is a careful implementation.
- **`decodeJwtPayload`** is documented as non-authentication and used only to read a
  non-secret claim — correct.
- **`assertSessionId`** rejects `/`, `\`, `..`, `.` and `..` substrings; `--session` cannot
  traverse. Confirmed by test.
- **`readConfigFile`** rejects non-JSON and non-object; `__proto__` in JSON does not
  pollute (`JSON.parse` creates an own property; the parser copies named fields only).
  Verified: `({}).polluted === undefined`.
- **`repairHistory`** drops orphan tool results and unanswered calls rather than throwing
  on well-formed-but-broken input. It *does* throw on `null` elements, but `loadSession`
  filters through `isChatMessage` first, so the reachable path is safe.
- **`httpTransport` / `stdioTransport`** frame correctly, drop non-JSON, and correlate by
  id with timeouts; `mcp-serve.ts`'s `restrictedToolHost` is a real allow-list (both
  `definitions` and `execute` check).
- **`environment.ts` probe** is built per shell family and fails closed ("we could not
  tell" rather than "nothing installed").
- **`flags.ts`** refuses a flag with a missing value rather than defaulting — the right
  call for a CLI where a wrong default is a different conversation.
- **Clipboard** uses argv arrays and cleans up its temp file on exit; the temp name is
  PID+timestamp and it passes the path by env var rather than interpolating it.

---

## 5. Remediation summary

| # | Fix | Effort |
|---|---|---|
| C-1 | Strip all C0/C1 and CSI/OSC/DCS/PM/APC at the `Screen`/segment boundary; add hostile-input tests | S |
| C-2 | Windows ACL (`icacls`/native) on `config.json`; dir `0o700`; document `${VAR}` for keys | M |
| C-3 | Prefix/allow-list for `${VAR}` expansion; notify on env-sourced credentials | S |
| C-4 | `mode: 0o600` on session staging + `chmodSync`; `0o700` dirs; cap session count/size; redact secrets from transcripts | S |

Suggested regression tests: render `ESC[2J`/`ESC[…H`/`ESC]0;`/`ESC]8;;` through
`entryLines` and `Screen.render` and assert none survives; assert `config.json` and
`sessions/*.json` are `0o600` after save; assert `${RANDOM_HOST_VAR}` is refused unless
allow-listed.

---

## 6. Remaining risks and limitations

- **`ui/App.tsx` (2,157 lines) was not fully audited** — key handling, paste, selection,
  and the mouse layer are large and stateful; `input.ts` was read and looks careful
  (C0/C1 stripped from drafts and pastes), but the surrounding component was not.
- **C-1 was proven at the render boundary**, not through a live TTY session; a real run
  would confirm the visual effect, but the byte path (`term.render` ← `entryLines`) is
  unambiguous.
- **C-2's Windows impact** depends on the machine's ACL inheritance; I measured one
  install (mode 644, dirs 755). A hardened host may differ.
- **Not examined:** `providers.ts`, `probe.ts`, `slash.ts`, `diff.ts`, `theme*.ts`, the
  worker threads' message handling, and `web-search.ts`'s MCP client beyond what the
  tools report covered.
- **No dependency audit.** The CLI's runtime dependency set (Ink, React, chalk, ws) was
  not scanned for CVEs.

---

## Appendix A — PoC index (all in `%TEMP%\a0poc\`; synthetic data, no real secrets)

| PoC | Finding | Notes |
|---|---|---|
| `cli-ansi.mts` | C-1 | `renderMarkdown` preserves ESC/OSC |
| `cli-ansi2.mts` | C-1 | `entryLines` per-entry ESC counts |
| `cli-ansi3.mts` | C-1 | one rendered row, verbatim |
| `cli-cfg.mts` | C-2 | config mode, plaintext key, `${VAR}` behaviour |
| `cli-envdump.mts` | C-3 | arbitrary env var into apiKey/header |
| `cli-usage.mts` | C-4 | usage file mode, newline-in-model-name |
| `cli-symlink.mts` | C-4 | session write does not follow a symlink (sound) |
| `cli-surface.mts` / `cli-surface2.mts` | — | config `systemPrompt` is honoured verbatim (by design); context-path escaping verified |
| `cli-paths.mts` | — | `ACTOR0_*_DIR`/XDG overrides (documented, not a finding) |