#!/bin/sh
#
# actor0 packaged launcher — macOS and Linux.
#
# The counterpart of scripts/packaged-launcher.vbs, and for the same reason:
# the packaged page must never hold `os.spawnProcess`. That permission cannot
# be scoped to "the caller is us" (see stage-launcher.mjs: commandAllowList
# matches argv[0] as a bare name, and the token that authorises the board
# endpoint is fetchable by any local process), so the agent is started here,
# by a script on disk, and the page only reads the port file this writes.
#
# The launch sequence is the vbs one:
#
#   1. resolve paths from this script's own location, so the app runs from
#      any install directory (inside a .app this is Contents/MacOS);
#   2. single instance — a *live* pid behind agent/port.json means a second
#      launch opens a window on the agent that already runs;
#   3. otherwise mint the agent's WebSocket token from the bundled runtime,
#      start the agent detached with its output appended to agent/agent.log,
#      wait for the file it writes rather than sleeping for a guess;
#   4. run the app window in the foreground, and when it closes, clean up the
#      agent (and its children) by the pid the agent recorded — which is also
#      what a terminal Ctrl+C does.
#
# stage-launcher.mjs substitutes __APP_BINARY__ and __BUILD_ARG__. The build
# number is baked in here rather than passed as an argument (the Windows entry,
# actor0.cmd, passes it), because a .app is launched by Launch Services with
# arguments this script must not mistake for its own — and it is a build
# counter, never a version (see the repository's AGENTS.md).
#
# Everything below is POSIX sh: no `[[`, no arrays, no `local`, and no
# fractional `sleep`, which is why the wait loop is `node -e` — the bundled
# runtime is the one piece of the package that can be trusted to sleep for
# 100ms on any of these systems.

set -u

# In the .app this script is Contents/Resources/run.sh, launched by the Mach-O
# stub in Contents/MacOS, which exports the executable directory. Everywhere
# else (the Linux tarball) the script's own directory is the app directory.
# install.sh also links $PREFIX/bin/actor0-desktop to this file; resolve that link
# first, or the app directory would look like $PREFIX/bin.
script=$0
while [ -h "$script" ]; do
  link=$(readlink "$script") || break
  case $link in
    /*) script=$link ;;
    *) script=$(dirname -- "$script")/$link ;;
  esac
done
here="${ACTOR0_APP_DIR:-$(CDPATH= ; cd -- "$(dirname -- "$script")" && pwd)}"
app="$here/__APP_BINARY__"
buildArg="__BUILD_ARG__"
agentDir="$here/agent"

# Runtime state does not live inside the app. On macOS the app is a signed
# bundle, often in /Applications, and writing a port file into Contents/MacOS
# both fails for a non-admin user and adds a file the signature covers. Linux
# installs are writable, but the same path is used there so one launcher
# serves both. $HOME/.actor0 is derived identically by the page through
# os.getPath("home"), so the record needs no command-line handshake.
stateDir="${ACTOR0_STATE_DIR:-${HOME:-$here}/.actor0}"
stateAgentDir="$stateDir/agent"
portFile="$stateAgentDir/port.json"
pidFile="$stateAgentDir/launcher.pid"
logFile="$stateAgentDir/agent.log"

say() { echo "actor0: $1" >&2; }

die() {
  say "$1"
  [ -f "$logFile" ] && say "see $logFile for the agent output"
  exit 1
}

# The pid the agent wrote into its own port file, or empty when there is none.
# Whitespace is stripped first: the agent pretty-prints the file, and `.*`
# in sed does not cross a newline.
read_port_pid() {
  tr -d '[:space:]' < "$1" 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p'
}

[ -f "$app" ] || die "the app binary is missing: $app"
[ -f "$agentDir/agent.mjs" ] || die "the agent bundle is missing: $agentDir/agent.mjs"
mkdir -p "$stateAgentDir" || die "cannot create the state directory: $stateAgentDir"

# Launch Services starts a .app with an arbitrary working directory. The shell
# resolves its own resources, but the page and the agent's relative paths must
# not inherit /, so run from the executable's directory as the vbs does.
cd "$here" || die "cannot enter $here"

# --- the bundled runtime, for this machine ---------------------------------
# `uname -m` names the machine; the package names its runtimes the way
# nodejs.org does. A universal macOS package carries both, and selecting here
# is the whole reason they are kept in per-arch directories.
case "$(uname -m 2>/dev/null)" in
  x86_64|amd64)         wantArch="x64" ;;
  aarch64|arm64)        wantArch="arm64" ;;
  armv7l|armv6l|armhf)  wantArch="armv7l" ;;
  *)                    wantArch="" ;;
esac

nodeBin=""
if [ -n "$wantArch" ] && [ -f "$here/runtime/$wantArch/node" ]; then
  nodeBin="$here/runtime/$wantArch/node"
fi
if [ -z "$nodeBin" ]; then
  # Anything at all beats nothing: a single-arch package installed on a
  # machine whose uname it has never seen still runs.
  for candidate in "$here"/runtime/*/node; do
    if [ -f "$candidate" ]; then nodeBin="$candidate"; break; fi
  done
fi
[ -n "$nodeBin" ] || die "no bundled Node runtime under $here/runtime"
[ -x "$nodeBin" ] || chmod +x "$nodeBin" 2>/dev/null || true

# --- single instance --------------------------------------------------------
# If a live agent already holds the port file, this is a second launch: open
# the window on the existing agent instead of racing it with a second one. A
# pid that no longer exists is a stale file and is removed so the stale port
# can never be handed to a window (the vbs does the same, via tasklist).
launchAgent=1
if [ -f "$portFile" ]; then
  pid="$(read_port_pid "$portFile")"
  if [ -z "${pid:-}" ] || [ "$pid" -eq 0 ] 2>/dev/null; then
    launchAgent=1
  elif kill -0 "$pid" 2>/dev/null; then
    launchAgent=0
  else
    rm -f "$portFile"
  fi
fi

if [ "$launchAgent" = 0 ]; then
  # Attach: a second window on the agent that is already running. No cleanup
  # trap — this script does not own the agent it is attaching to.
  "$app" "$@" &
  exit 0
fi

# --- start the agent, the way a first launch has to --------------------------
rm -f "$portFile"
mkdir -p "$agentDir"

# The socket exposes config.get (provider credentials) and turn.send (the
# whole tool set), so it must never listen unauthenticated: the token is minted
# here and lives only for this launch.
token=$("$nodeBin" --input-type=commonjs -e '
  process.stdout.write(require("crypto").randomBytes(32).toString("hex"));
') || die "could not mint the agent token"
[ ${#token} -eq 64 ] || die "the agent token came out wrong (got ${#token} chars)"

buildFlag=""
if [ -n "$buildArg" ]; then buildFlag=" --build $buildArg"; fi

# The agent's working directory: its default is $HOME, and an override the
# user set for the session must survive into the packaged app.
ACTOR0_AGENT_CWD="${ACTOR0_AGENT_CWD:-${HOME:-$here}}"
export ACTOR0_AGENT_CWD

# Detached with output appended to the log. A pipe nobody drains is how a
# packaged app dies without saying why; this file is what the error below and
# the README point at.
nohup "$nodeBin" "$agentDir/agent.mjs" \
  --port-file "$portFile" \
  --token "$token" \
  --nl-path "$here"$buildFlag \
  >> "$logFile" 2>&1 &
launcherPid=$!
echo "$launcherPid" > "$pidFile" 2>/dev/null || true

if ! "$nodeBin" --input-type=commonjs -e '
  var fs = require("fs");
  var path = process.argv[1];
  var deadline = Date.now() + 16000;
  (function poll() {
    try {
      var info = JSON.parse(fs.readFileSync(path, "utf8"));
      if (info.port && info.pid) return process.exit(0);
    } catch (e) {
      /* not written, or half written: keep polling until the deadline */
    }
    if (Date.now() > deadline) return process.exit(1);
    setTimeout(poll, 100);
  })();
' "$portFile"; then
  die "the agent did not start (it was given 16s and printed nothing to $logFile)"
fi

agentPid="$(read_port_pid "$portFile")"
if [ -z "${agentPid:-}" ] || [ "$agentPid" -eq 0 ] 2>/dev/null; then
  agentPid="$launcherPid"
fi


# --- one window, cleaned up after itself ------------------------------------
cleanup() {
  ownPid=""
  if [ -f "$pidFile" ]; then ownPid="$(tr -d '[:space:]' < "$pidFile" 2>/dev/null || true)"; fi
  if [ -n "${ownPid:-}" ]; then
    # The agent's tool calls are children of the agent; killing the agent
    # alone would leave them behind. One level down, then the agent itself.
    pkill -TERM -P "$ownPid" 2>/dev/null || true
    kill -TERM "$ownPid" 2>/dev/null || true
  fi
  rm -f "$pidFile" "$portFile"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

"$app"
