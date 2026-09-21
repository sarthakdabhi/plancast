#!/bin/sh
# This installer uses only tools shipped with macOS. No sudo or shell-profile edits.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(uname -s)" != Darwin ]; then echo 'Plancast requires macOS.' >&2; exit 1; fi
machine=$(uname -m)
case "$machine" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;; esac
if [ "$arch" != '@ARCH@' ]; then echo "This archive is for @ARCH@; download the $arch archive." >&2; exit 1; fi
cd "$source_dir"
echo 'Verifying Plancast files…'
shasum -a 256 -c SHA256SUMS > /dev/null
prefix=${PLANCAST_INSTALL_PREFIX:-"$HOME/.local"}
case "$prefix" in /*) ;; *) echo 'PLANCAST_INSTALL_PREFIX must be an absolute path.' >&2; exit 1 ;; esac
base="$prefix/share/plancast/cli"
release="$base/@RELEASE_ID@"
link="$prefix/bin/plancast"
mkdir -p "$base" "$prefix/bin"
if [ -e "$link" ] || [ -L "$link" ]; then
  if [ ! -L "$link" ]; then echo "Will not replace existing file: $link" >&2; exit 1; fi
  old=$(readlink "$link")
  case "$old" in "$base/"*/plancast) ;; *) echo "Will not replace unrelated link: $link" >&2; exit 1 ;; esac
fi
stage=$(mktemp -d "$base/.install-XXXXXX")
cleanup() { if [ -n "$stage" ]; then /bin/rm -r "$stage"; fi; }
trap cleanup EXIT
trap 'exit 130' INT TERM
/usr/bin/ditto "$source_dir" "$stage"
(cd "$stage" && shasum -a 256 -c SHA256SUMS > /dev/null)
"$stage/plancast" --version > /dev/null
if [ -e "$release" ]; then
  # Same release: require matching contents before reusing it.
  /usr/bin/cmp "$release/SHA256SUMS" "$stage/SHA256SUMS"
  (cd "$release" && shasum -a 256 -c SHA256SUMS > /dev/null)
else
  mv "$stage" "$release"
  stage=''
fi
# Rename a temporary symlink so an existing managed launcher never disappears.
link_stage=$(mktemp -d "$prefix/bin/.plancast-link-XXXXXX")
ln -s "$release/plancast" "$link_stage/plancast"
mv -f "$link_stage/plancast" "$link"
rmdir "$link_stage"
echo "Installed: $link"
echo "Run: \"$link\" setup-local"
echo 'If plancast is not on your PATH, add this line to ~/.zshrc and open a new terminal:'
echo 'export PATH="$HOME/.local/bin:$PATH"'
