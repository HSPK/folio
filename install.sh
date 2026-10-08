#!/bin/sh
set -eu

fail() { printf 'Folio: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=macos ;;
  *) fail "Unsupported system. On Windows, use install.ps1." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "Only x64 and ARM64 are supported." ;;
esac

download() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 "$@"; }
repo=https://github.com/HSPK/folio
version=${FOLIO_VERSION:-latest}
if [ "$version" = latest ]; then
  url=$(download --output /dev/null --write-out '%{url_effective}' "$repo/releases/latest")
  version=${url##*/}
fi
case "$version" in v*) ;; *) version=v$version ;; esac
printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "Invalid release version: $version"

asset=folio-$platform-$arch.tar.gz
base=$repo/releases/download/$version
temporary=$(mktemp -d "${TMPDIR:-/tmp}/folio-install.XXXXXXXX")
trap 'rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
download --output "$temporary/$asset" "$base/$asset"
download --output "$temporary/SHA256SUMS" "$base/SHA256SUMS"
expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$temporary/SHA256SUMS")
printf '%s\n' "$expected" | grep -Eq '^[a-fA-F0-9]{64}$' || fail "Missing or invalid checksum for $asset."
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{print $1}')
else
  fail "sha256sum or shasum is required."
fi
[ "$actual" = "$expected" ] || fail "Checksum mismatch; nothing was installed."
tar -tzf "$temporary/$asset" > "$temporary/entries"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$temporary/entries"; then
  fail "Unsafe archive paths; nothing was installed."
fi
tar -xzf "$temporary/$asset" -C "$temporary"

if [ "$platform" = linux ]; then
  directory=${FOLIO_INSTALL_DIR:-"$HOME/.local/bin"}
  [ -f "$temporary/folio" ] || fail "The archive contains no folio executable."
  mkdir -p "$directory"
  [ ! -d "$directory/folio" ] || fail "$directory/folio is a directory."
  staged=$directory/.folio-install-$$
  install -m 755 "$temporary/folio" "$staged"
  if ! mv -f "$staged" "$directory/folio"; then
    rm -f "$staged"
    fail "Could not replace the installed executable."
  fi
  printf 'Installed Folio %s to %s/folio\n' "${version#v}" "$directory"
  case ":${PATH:-}:" in
    *":$directory:"*) ;;
    *) printf 'Add this directory to PATH: %s\n' "$directory" ;;
  esac
  printf 'Start with: "%s/folio" --serve /path/to/markdown\n' "$directory"
else
  directory=${FOLIO_INSTALL_DIR:-"$HOME/Applications"}
  [ -x "$temporary/Folio.app/Contents/MacOS/Folio" ] || fail "The archive contains no Folio application."
  mkdir -p "$directory"
  target=$directory/Folio.app
  [ ! -L "$target" ] || fail "Refusing to replace an application symlink."
  if [ -e "$target" ]; then
    [ -d "$target" ] && [ -f "$target/Contents/Info.plist" ] || fail "$target is not an application bundle."
    mv "$target" "$temporary/Folio.previous.app"
  fi
  if ! mv "$temporary/Folio.app" "$target"; then
    if [ -d "$temporary/Folio.previous.app" ]; then
      if ! mv "$temporary/Folio.previous.app" "$target"; then
        trap - EXIT
        fail "Restore $temporary/Folio.previous.app manually."
      fi
    fi
    fail "Could not install the application."
  fi
  printf 'Installed Folio %s to %s\nStart with: open "%s"\n' "${version#v}" "$target" "$target"
  printf 'This release is ad-hoc signed, not notarized. macOS may require approval in Privacy & Security.\n'
fi
