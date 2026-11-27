# actor0 desktop

A native window around the same harness the CLI runs. Two processes, on purpose:

```
 Neutralino shell (C++ core + OS webview)
   serves resources/app   ← the React UI (this package's `src`)
   spawns  node resources/agent/agent.mjs  ← the agent core (apps/desktop/agent)
                │
                └── its own localhost WebSocket ← the UI's `src/client.ts`
```

The shell is a *host*, not an engine: it owns the window, the native filesystem
API the agent's tools can use, and the process supervision. The agent is a
second headless host of `@actor0/harness` — sibling to the CLI's `print.ts` and
`mcp-serve.ts` — and it imports no CLI code.

In a package the page holds no spawn permission. A small launcher starts the
agent beside the shell and records its port; the page only reads that record.

## Development

The UI runs in a browser with the agent beside it, which is the fastest loop:

```bash
# terminal 1 — the agent, on the dev default port
ACTOR0_AGENT_PORT=3000 npm --workspace @actor0/desktop-agent run dev

# terminal 2 — the UI
npm --workspace @actor0/desktop-web run dev
```

Open http://127.0.0.1:5174. The UI finds the agent at `ws://127.0.0.1:3000`
because there is no shell to write `.tmp/agent.json`.

To run the real window, build both halves and let Neutralino serve them:

```bash
npm --workspace @actor0/desktop-web run shell     # build UI + agent, then `neu run`
```

`neu` needs the platform binaries in `apps/desktop/web/bin`, which
`npx neu update` fetches once. The packaged launcher starts the bundled Node;
the shell's `commandAllowList` is empty in the shipped config.

## Packaging

One command per host, because macOS bundles must be signed on macOS and each
host can only execute (and therefore smoke-test) its own archives:

```bash
npm --workspace @actor0/desktop-web run package:host   # this machine's default target
npm --workspace @actor0/desktop-web run package:win    # win_x64
npm --workspace @actor0/desktop-web run package:linux  # linux_x64, linux_arm64, linux_armhf
npm --workspace @actor0/desktop-web run package:mac    # mac_x64, mac_arm64, mac_universal (macOS only)
npm --workspace @actor0/desktop-web run package:all    # all seven, on a macOS host
```

Outputs land in `apps/desktop/web/dist/`: one archive per target, a `.sha256`
beside it, `update-manifest.json`, and the shared `resources.neu` that the
updater downloads. `resources.neu` is architecture-independent, so one
`neu build` serves every target; only the shell binary and the Node runtime
differ. Node is pinned to 22.14.0 and every download is checked against the
pinned SHA256 before it is staged.

`node scripts/smoke.mjs <target>` unpacks an archive the way the platform
does, checks the layout and modes, runs the bundled Node, and starts the
shipped agent against a free port. The GitHub workflow runs it for every
target before uploading anything.

## Installing

### Windows x64

Download `actor0-desktop-0.5.7-win_x64.zip`, extract it anywhere, and run
`actor0.cmd`. `start-actor0.vbs` does the same without a console window.

SmartScreen shows "Windows protected your PC" because the build has no
commercial certificate: choose **More info → Run anyway**. The app keeps its
state under `%USERPROFILE%\.actor0\` and can be removed by deleting the
folder — there is no installer and no registry entry.

There is no native Windows arm64 shell upstream (Neutralino ships only
`win_x64`). On Windows on ARM, this x64 build runs under the system's x64
emulation; nothing else is required.

### macOS

Download the archive for the machine: `mac_arm64` for Apple Silicon,
`mac_x64` for Intel, or `mac_universal` when one download must serve both.
Unzip it, drag `actor0.app` to Applications, then **right-click → Open** the
first time.

The build is ad-hoc signed, not notarized: that first right-click is what
tells Gatekeeper you meant to run it. A plain double-click is refused with
"Apple could not verify". macOS 11 or newer is required.

The `.app` is never written to at runtime. The agent's port record and log
live in `~/.actor0/agent/`, which the launcher and the page both derive from
`os.getPath("home")` — a signed bundle inside `/Applications` is read-only
and rewriting it would break the signature.

### Linux

Pick the archive for the machine: `linux_x64` (most desktops), `linux_arm64`
(64-bit Raspberry Pi OS, ARM servers), or `linux_armhf` (32-bit Raspberry Pi
OS and other armv7l systems). Then:

```bash
tar -xzf actor0-desktop-0.5.7-linux_x64.tar.gz
cd actor0-desktop-0.5.7-linux_x64
./install.sh                 # installs to ~/.local/share/actor0
actor0                       # or launch it from the desktop entry
```

`PREFIX=/usr/local sudo ./install.sh` installs system-wide. Without
installing, `./actor0` runs from the extracted directory.

Requires WebKitGTK 4.1 and GTK 3: `libwebkit2gtk-4.1-0 libgtk-3-0` on
Debian/Ubuntu, `webkit2gtk4.1 gtk3` on Fedora. These are glibc builds; musl
distributions (Alpine) are not covered.

The launcher and `install.sh` are LF shell scripts with mode 0755, including
inside the tarball — the packager writes the tar headers itself because
Windows' `bsdtar` drops the executable bit.

## Where the state lives

The same places the CLI uses, in the same formats:

- `$ACTOR0_CONFIG_DIR` (default `~/.config/actor0`) — `config.json`
- `$ACTOR0_DATA_DIR` (default `~/.local/share/actor0`) — `sessions/*.json`, `usage.jsonl`
- `~/.actor0/agent/` — `port.json`, `agent.log`, and the pid file the launcher
  uses for single-instance. Set `ACTOR0_STATE_DIR` to move this directory.

So a conversation started in the CLI resumes here, and the other way round.
