# Desktop Architecture — actor0 Desktop

Status: **planning** (2026-11-09, updated 2026-11-10). This is the architecture
plan for the desktop app, not an implementation record. The CLI remains the
reference consumer of the harness; the desktop app is the second host in the
sense of `packages/providers` ("a second host should be able to build a
`ResolvedProvider` without importing the terminal client").

## 1. Goal

A desktop client that is **almost a perfect GUI version of the CLI app,
UI-wise** — the same framed layout, visual language, interaction model, and
conversation surfaces the TUI has, translated faithfully to a native-feeling
window — while running the same harness the CLI runs: BYOK providers, tool
use, and sessions that resume across the CLI and the desktop app.

"Claude Desktop feel" here means a polished native desktop window and UX, but
the **source of truth for the UI** is the current CLI TUI
(`apps/cli/src/ui/`), not an unrelated chat layout. Where the CLI draws with a
grid/`Seg[][]` renderer in an alternate screen, the desktop renders the
equivalent structure in React/DOM with the same theme tokens, components, and
state semantics. No Electron, no per-platform webview divergence (the Tauri
problem).

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Neutralinojs **v6.10.0** (C++/CMake core, `@neutralinojs/neu` CLI) | Native window + OS webview, or a dedicated Chromium app window; WS NativeAPI with allowlists; megabytes of framework, not ~100 MB; project is very active (last release 2026-11). Docs live at neutralino.js.org |
| UI | React 19 + Vite, dev integration through `cli.frontendLibrary` | HMR during development via `neu run`; React/DOM implementation that mirrors the CLI TUI layout and components (see §5a) |
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
- **Conversation/state logic:** the harness-event → UI reducer semantics from
  `apps/cli/src/conversation.ts` (`applyEvent`, `withUserInput`,
  `entriesFromMessages`, live/reset/partial/retry handling) are the source of
  truth for transcript state and should be reused or ported without behavior
  drift (shared pure module or a desktop copy kept equivalent).
- **Slash commands/input semantics:** command parsing/matching
  (`apps/cli/src/slash.ts`), draft/caret editing rules, and submit/cancel
  behavior follow the CLI's model; input is DOM/keyboard/mouse rather than raw
  TTY sequences, but the command set and interaction outcomes stay the same.
- `mcp-serve.ts` stays CLI-only for now; the desktop can host MCP later via
  the same shape.

## 5a. CLI UI parity (decided 2026-11-10)

The desktop UI is a **faithful GUI translation of the CLI TUI**, not a
greenfield chat surface. Reference implementation:
`apps/cli/src/ui/App.tsx` (state/modes/input/turn orchestration),
`apps/cli/src/ui/render.ts` (pure layout/row generation), `apps/cli/src/ui/term.ts`
(terminal grid/caret/mouse — replaced by DOM), `apps/cli/src/ui/input.ts` and
`selection.ts` (interaction semantics), `apps/cli/src/ui/markdown.ts`,
`apps/cli/src/ui/parts.tsx`, `apps/cli/src/conversation.ts`, and
`apps/cli/src/theme.ts` + generated `theme.generated.ts` (cronixui-derived
tokens).

### 5a.1 Layout and framing

Mirror the CLI frame:

- **Top area:** status/header info and the mascot/face state
  (`normal/startled/idle/confused/suffering/dead/happy/thinking`) as in
  `topArea`/`faceBox`, reflecting busy/blocked/notice/last-entry state.
- **Transcript region:** scrollable conversation history (windowed/virtualized
  as needed) above a pinned composer. Committed entries are stable; the live
  region updates in place during streaming (analogous to `<Static>` transcript
  + live redraw). Scrolling/offset behavior and transcript selection/copy map
  to DOM scroll and text selection while preserving the same content and
  affordances.
- **Pinned composer:** bottom input area with draft, caret, busy state, and a
  top-border notice/hint line (`composerRows` semantics: status/notice tone and
  right-aligned hints).
- **Modal/overlay panels:** menus and pickers render as centered/focused
  panels over or in place of the chat content with the same widths, search
  bars, dividers, selection/highlight, and hit-target behavior the CLI draws
  (`menuRows`/`pickerRows`/`panel`/`box`, `MENU_WIDTH`, search `⌕ … │`).

Terminal cell-grid painting (`Seg[][]` → ANSI) becomes styled DOM/React
components, but the visual hierarchy, spacing, borders, alignment, and
information density should read the same.

### 5a.2 Conversation and streaming surfaces

Render the same entry and live kinds the CLI renders:

- **User entries:** user message blocks/bubbles as in `entryLines`.
- **Assistant entries:** markdown answers with the CLI's supported structure
  and styling — fenced code blocks with language tags, tables, headings,
  lists, quotes, and inline emphasis/code/links — matching `render.ts`/`markdown.ts`
  behavior (including fence/table integrity and row-budgeting semantics where
  they affect presentation).
- **Reasoning:** collapsible/expandable reasoning blocks with duration/timer
  display; live reasoning flushed/committed per reducer semantics
  (`flushReasoning`, attempt/reset behavior).
- **Plans:** plan/title blocks as surfaced by harness `plan` events.
- **Tool calls/results:** tool boxes/lines with status glyphs
  (`ok`/`error`), tool name/target, output, and diffs where applicable
  (`parseDiffBlock`/diff rendering), matching the CLI's tool presentation.
- **Help/system notices:** help output, notices (`info`/`warn`/`error`),
  blocked/needs-user states, retry/reset and partial/cut-off markers.
- **Live region:** streaming tokens/reasoning, spinner frames and shimmer,
  elapsed/thinking timers, status text (e.g. tool executing, reading tool
  output, retrying), and attempt/partial indicators driven by the same
  harness event stream and timing (`liveLines`, `SPINNER_FRAMES`, `timing`).

### 5a.3 Modes and interaction flows

All CLI modes and their panels are present with equivalent behavior:

- **Chat** with slash command detection and popup
  (`slashPopupRows`, filtered by query, keyboard/mouse selection).
- **Menu / manage providers / add-provider flow** (kind → url → key →
  working/models/manual/error phases, OAuth/api-key paths as applicable) with
  the same navigation and validation cues.
- **Model picker, thinking/effort picker, session picker** (resume/switch,
  active marking), **usage** panel, **MCP** panel — same search, cursor,
  selection, and windowing behavior.
- **Commands:** `/clear`, `/model`, `/provider`, `/mcp`, `/setup`, `/usage`,
  `/thinking`, `/session`, `/quit` (and any aliases) behave as in the CLI.

Keyboard shortcuts, focus, submit/cancel (including turn abort), scroll/wheel
behavior, and click/hover affordances are translated to web equivalents so the
interaction feels the same (mouse reporting/drag-selection semantics from
`term.ts`/`input.ts`/`selection.ts` become native DOM selection and event
handling without losing transcript copy/selection).

### 5a.4 Theme and visual tokens

Use the same semantic theme vocabulary as the CLI (`apps/cli/src/theme.ts`,
backed by `theme.generated.ts` / cronixui): `color` roles (`text`, `muted`,
`dim`, `accent`/`accentText`, `crimson`, `success`, `warning`, `error`,
`info`, `surface`, `border`, `selectionBg`), `space`, `timing`, spinner
frames, and tool glyphs. The desktop should consume or mirror these tokens
(e.g. CSS variables derived from the same generated values) so colors,
contrast/hierarchy, borders, and motion cadence match the CLI rather than
inventing a new palette.

### 5a.5 Implementation approach

- **Share/port pure logic:** prefer reusing or faithfully porting
  `conversation.ts`, slash/command logic, and any pure layout/formatting
  helpers that are host-agnostic. Do not import CLI UI modules that depend on
  terminal/Ink/runtime specifics into the web bundle; instead extract or mirror
  the portable pieces.
- **Component parity over pixel identity:** implement React components that
  correspond to the CLI's rendered structures (`topArea`/face, transcript
  entries, live region, composer, menus/pickers, slash popup, tool/plan/reason
  blocks) so each CLI surface has an explicit desktop counterpart driven by
  the same state.
- **Segment/style mapping:** where the CLI emits `Seg` runs and box-drawn
  rows, the desktop maps those roles to styled spans/blocks (monospace where
  the CLI is monospaced, bordered panels where the CLI draws boxes) preserving
  tone (`color/bold/dim/bg`) and layout intent.
- **Parity checks:** as UI lands, compare representative states/modes against
  the CLI (including streaming, retries/resets, tool use, and all pickers) to
  catch drift; add focused UI tests/snapshots for key states where practical.

## 6. Repo layout

```
apps/desktop/
  web/      React 19 + Vite UI bundle (CLI-parity components, theme tokens/CSS,
            conversation/slash/input adapters)
  agent/    Node ≥ 22 core (esbuild bundle → agent.bundle.mjs),
            node --test suite modeled on apps/cli's turn.test.ts
  neutralino.windows.json / neutralino.linux.json / neutralino.mac.json
            (copyItems: node binary; commandAllowList; tokenSecurity one-time)
```

Root `package.json` workspaces gain `apps/desktop`. The agent bundle is the
unit that ships inside `resources.neu` alongside the web bundle. Portable
UI/state logic shared with the CLI may later be extracted to a package if it
reduces duplication without blurring host boundaries.

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
   HarnessEvent stream over the localhost WS; `node --test` suite modeled on
   `apps/cli` turn tests; session/config format compatibility with the CLI.
3. **M2 — CLI-parity UI shell:** implement the faithful GUI translation of the
   CLI TUI (§5a):
   - Frame/layout: top status area + mascot face, scrollable transcript, pinned
     composer with notice/hint border.
   - Conversation: user/assistant/reasoning/plan/tool/help entries, markdown
     (fences/tables/inline), diffs, collapsible reasoning, notices and
     blocked/retry/partial states.
   - Live streaming: tokens/reasoning, spinner/shimmer, timers/status, reset
     and attempt semantics from harness events via the conversation reducer.
   - Modes/panels: slash popup, menu/manage/add-provider flow, model/thinking/
     session/usage/MCP pickers with search/cursor/selection parity.
   - Interaction: keyboard shortcuts, submit/cancel/abort, scroll and text
     selection/copy, mouse affordances.
   - Theme: CLI semantic tokens (`color/space/timing`, glyphs) applied to the
     web UI.
4. **M3 — session sharing:** resume a CLI session in desktop and vice
   versa (StoredSession format already shared); verify conversation/history
   rendering matches CLI for resumed sessions.
5. **M4 — packaging:** installer with node, updater manifest, release notes;
   CLI-vs-desktop parity pass on key flows; the minor version bump lands here,
   at the user's order.

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
- **Terminal-to-web parity fidelity** — the CLI's grid/`Seg` renderer, ANSI
  styling, and TTY input/selection semantics do not map 1:1 to DOM; achieving
  "almost perfect" parity requires careful component/token mapping and
  side-by-side comparison (especially markdown fences/tables, box-drawn
  panels, live streaming/repaint behavior, and keyboard/mouse semantics).
  Mitigation: treat `apps/cli/src/ui/` as the reference, port pure logic, and
  add parity checks for representative states.
