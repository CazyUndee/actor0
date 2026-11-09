# Desktop Architecture — actor0 Desktop

Status: **planning** (2026-11-09). This is the architecture plan for the
desktop app, not an implementation record. The CLI remains the reference
consumer of the harness; the desktop app is the second host in the sense of
`packages/providers` ("a second host should be able to build a
`ResolvedProvider` without importing the terminal client").

## 1. Goal

A desktop client with the feel of Claude Desktop, running the same harness
the CLI runs: a native-looking window, a chat UI, BYOK providers, and
sessions that resume across the CLI and the desktop app. No Electron, no
per-platform webview divergence (the Tauri problem).

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Neutralinojs **v6.10.0** (C++/CMake core, `@neutralinojs/neu` CLI) | Native window + OS webview, or a dedicated Chromium app window; WS NativeAPI with allowlists; megabytes of framework, not ~100 MB; project is very active (last release 2026-11). Docs live at neutralino.js.org |
| UI | React 19 + Vite, dev integration through `cli.frontendLibrary` | HMR during development via `neu run` |
| Agent core | Node ≥ 22 process, own WS server on 127.0.0.1 | The harness and providers are Node; Neutralino deliberately bundles no Node runtime (that is its anti-Electron selling point), so we ship `node.exe`/`node` beside the app |
| Agent engine | `@actor0/harness` + `@actor0/providers`, untouched | The four ports (`ModelClient`, `ToolHost`, `HarnessObserver`, `ToolRoundPolicy`) were designed so a second host can drive `runAgentTurn` without importing the CLI |

Verified Neutralino facts for this design live in the agent memory
(`neutralinojs-facts-2026`); the key ones: four modes, `modes.chrome.browserBinary`
custom-Chromium hook, `os.spawnProcess`/`updateSpawnedProcess`/`spawnedProcess`
events for process supervision, `commandAllowList` (v6.10), one-time WS token +
`exportAuthInfo` for external IPC, and the updater swapping `resources.neu`
only.

## 3. Platform mode (decided 2026-11-09)

- **Windows → `window` mode.** WebView2 is Chromium (Edge's engine), built
  into Windows 11: a native app window (taskbar icon, own title — the closest
  thing to the Claude Desktop feel) with a Chromium engine and **zero browser
  bundling**.
- **Linux and macOS → `chrome` mode.** A dedicated Chromium app window (own
  `--user-data-dir`, native-like flags). The Linux OS webview is WebKitGTK —
  that is the webview divergence we are avoiding; Chromium-family is the
  consistent engine.
- **Fallback, off the critical path:** if a Linux box has no
  Chromium-family browser, chrome mode shows an "install a browser" error.
  `modes.chrome.browserBinary` (with per-OS variants) is the native hook for
  bundling a portable Chromium beside the app instead. We only add that
  weight if the "no browser" state actually bites.

Mode selection is **config-time, not launch-time**: the runtime `--mode`
flag accepts only `window`/`browser`/`cloud`. So packaging ships one build
profile per platform — Windows profile with `modes.window` enabled,
Linux/macOS profiles with `modes.chrome` — i.e. separate
`neutralino.*.json` files (or a generate step), not one config trying to be
both.

## 4. Process topology

```
actor0-desktop binary (Neutralino v6.10 core)
 ├─ static server → web/ bundle (React 19 + Vite; HMR in dev via cli.frontendLibrary)
 ├─ WS NativeAPI (one-time token; nativeAllowList: os.*, events.*, app.*, window.*)
 ├─ UI calls os.spawnProcess("<NL_PATH>/node.exe agent.bundle.mjs", {cwd, envs})
 │    └─ commandAllowList entry for node; events.on("spawnedProcess") streams
 │       stdOut/stdErr/exit → supervisor respawns on crash
 ├─ exportAuthInfo → .tmp/auth_info.json → the agent can join the native WS
 │    back (os.showNotification, os.showFolderDialog from the agent side)
 └─ node.exe + agent bundle (copyItems → release folder; NSIS via contrib/builder)

agent core (Node ≥ 22, own WS on 127.0.0.1)
 ├─ @actor0/harness + @actor0/providers       (as-is)
 ├─ ToolHost ← desktop port of CLI tools      (read/write/edit/glob/rg/shell/
 │                                              web-search; task/skill later)
 ├─ HarnessObserver → HarnessEvent stream over WS (exact event enum from types.ts)
 └─ sessions/config ← CLI's XDG paths         (same StoredSession format, same
                                                BYOK config → CLI↔desktop resume)
```

Roles: the Neutralino binary is **a shell** — it serves the UI and
supervises the agent; it does no agent work. The agent core is a **third
headless host shape**, sibling to the CLI's `print.ts` (one-shot) and
`mcp-serve.ts` (stdio MCP). All UI→agent traffic is its own localhost WS;
agent→shell traffic goes through the NativeAPI with the exported auth info.

## 5. What is reused, what is ported

- `@actor0/harness`, `packages/providers`: **untouched**.
  `npm run check:boundaries` still passes because neither imports the CLI,
  and the desktop app imports neither the CLI nor the harness's internals
  beyond the public ports.
- **ToolHost:** a desktop port of the nine tools in `apps/cli/src/tools.ts`
  (read, write, edit, glob, rg, shell, web-search + task/skill when
  `packages/tools` exists). Same containment policy the CLI has: every path
  confined to the working directory, results capped, no default shell
  timeout.
- **Turn policy / system prompt:** host policy, taken from
  `apps/cli/src/turn.ts` (`defaultSystemPrompt`).
- **Sessions and config:** the CLI's `$XDG_CONFIG_HOME/actor0` config and
  `$XDG_DATA_HOME/actor0` `StoredSession` JSON, shared at the **format**
  level, not the code level (the desktop app does not import
  `apps/cli/src/session.ts`).
- `mcp-serve.ts` stays CLI-only for now; the desktop can host MCP later via
  the same shape.

## 6. Repo layout

```
apps/desktop/
  web/      React 19 + Vite UI bundle
  agent/    Node ≥ 22 core (esbuild bundle → agent.bundle.mjs),
            node --test suite modeled on apps/cli's turn.test.ts
  neutralino.windows.json / neutralino.linux.json / neutralino.mac.json
            (copyItems: node binary; commandAllowList; tokenSecurity one-time)
```

Root `package.json` workspaces gain `apps/desktop`. The agent bundle is the
unit that ships inside `resources.neu` alongside the web bundle.

## 7. Packaging and updating

- `neu build` → platform binary + `resources.neu`. **No `--embed-resources`** —
  embedding kills resource auto-update.
- `@neutralinojs-contrib/builder` wraps the release: NSIS (Windows),
  `.deb`/AppImage (Linux), DMG (macOS).
- `node.exe`/`node` ships beside the app and is named in `commandAllowList`;
  path quoting on Windows (spaces) is a spike item.
- The built-in updater (`Neutralino.updater.checkForUpdates` against a JSON
  manifest) swaps `resources.neu` only — UI + agent code update without a new
  installer. Framework-binary updates are the only thing that needs one.

## 8. Versioning

A desktop app is a genuinely new top-level capability: it ships as a
`[feat]` **minor** bump (the rule of thumb in AGENTS.md: a new subsystem the
user could point to and name). The bump happens **only at the user-ordered
release** (releases are gated); build-class commits up to that point move
the build counter only. Commit trailers already reserve
`Component: Desktop`.

## 9. Milestones

1. **M0 — spike** (`apps/desktop/web`, a morning of work): `neu create` a
   Vite + React shell; confirm `window` mode on Windows 11; `chrome` mode on
   a Linux box; `spawnProcess` a node hello through `commandAllowList`;
   one-time token round trip; `exportAuthInfo` read from node; `NL_PATH`
   layout for placing `node.exe`; `frontendLibrary` HMR through `neu run`.
2. **M1 — agent core:** bundle harness + providers + desktop ToolHost;
   HarnessEvent stream over the localhost WS; `node --test` suite.
3. **M2 — UI shell:** chat surface streaming `HarnessEvent`s,
   provider/session pickers wired to the CLI-shared config.
4. **M3 — session sharing:** resume a CLI session in desktop and vice
   versa (StoredSession format already shared).
5. **M4 — packaging:** installer with node, updater manifest, release notes;
   the minor version bump lands here, at the user's order.

## 10. Risks and open questions

- **Linux chrome mode with no Chromium-family browser** — the "install a
  browser" error. Mitigation (bundled `browserBinary`) deferred until
  measured.
- **WebView2 on older Windows 10 images** — the Evergreen runtime is not on
  some OEM images; the installer check/bootstrap is a packaging detail.
- **Agent crash and orphan processes** — the supervisor respawns; with
  `tokenSecurity: "one-time"`, the token rotates on reload, so the auth-info
  hand-off must be part of the respawn path.
- **`commandAllowList` path quoting** — node's path on Windows may contain
  spaces; verified in M0.
- **Pinning v6.10.0** — a C++ core we did not write; track the org's
  releases, but pin the version the installer was tested with.
