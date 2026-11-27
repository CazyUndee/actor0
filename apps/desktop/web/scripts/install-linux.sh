#!/bin/sh
#
# Install actor0 from an unpacked Linux tarball.
#
#   ./install.sh                 # ~/.local (no root needed)
#   PREFIX=/usr/local sudo ./install.sh
#
# The app directory is self-contained: the shell binary, resources.neu, the
# agent bundle and the pinned Node runtime all move together, so the only
# absolute path that has to be written is the desktop entry's Exec=. That is
# why this is a script and not an AppImage: nothing here needs FUSE, and a
# plain directory under $PREFIX is what a package manager would unpack anyway.
#
# Runtime dependency: WebKitGTK 4.1 (libwebkit2gtk-4.1-0 on Debian/Ubuntu,
# webkit2gtk4.1 on Fedora). It is not bundled because it is a system library
# with its own security updates.

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=${PREFIX:-$HOME/.local}
appdir="$prefix/share/actor0"
bindir="$prefix/bin"
appsdir="$prefix/share/applications"

mkdir -p "$appdir" "$bindir" "$appsdir"

# Replacing the previous install from a different directory is safe: user data
# lives under the XDG data dir, never here. When the script is run from the
# installed copy itself, there is nothing to copy over itself.
if [ "$here" != "$appdir" ]; then
  rm -rf "$appdir"
  mkdir -p "$appdir"
  cp -R "$here/." "$appdir/"
fi

chmod +x "$appdir/actor0"
# The tar writer already records 0755, but a file copied through a filesystem
# that drops the bit (or extracted with tar --no-same-permissions) must still
# run: without this, the first launch fails on the bundled runtime.
for node in "$appdir"/runtime/*/node; do
  [ -f "$node" ] && chmod +x "$node"
done

ln -sf "$appdir/actor0" "$bindir/actor0"

cat > "$appsdir/actor0.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=actor0
Comment=actor0 desktop agent
Exec=$appdir/actor0
Icon=$appdir/icon.png
Terminal=false
Categories=Development;
StartupWMClass=actor0-desktop
EOF
chmod 644 "$appsdir/actor0.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$appsdir" >/dev/null 2>&1 || true
fi

printf 'installed actor0 in %s\nrun: %s/actor0\n' "$appdir" "$bindir"
