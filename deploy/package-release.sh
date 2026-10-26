#!/usr/bin/env bash
# Builds two kinds of release from the same source:
#   release/report-server-<version>-<date>.zip / .tar.gz     modern dependencies (package.json), needs Node 20+ (Ubuntu, Windows 10/11)
#   release/report-server-<version>-<date>-node16.zip         legacy dependencies (deploy/legacy/), runs on Node 16 (Windows Server 2012)
# All dependencies are plain JavaScript (no native modules), so node_modules built on a Mac or Linux machine works
# unchanged on Windows and the server needs no internet access or compiler.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date +%Y%m%d)"
OUT="$PWD/release"
mkdir -p "$OUT"

# stage <dir> <package.json> <package-lock.json>: copies the app and installs production dependencies from that set
stage() {
  local APP="$1/report-server"
  mkdir -p "$APP"
  cp -R server.js .env.example README.md src public scripts deploy "$APP/"
  cp "$2" "$APP/package.json"
  cp "$3" "$APP/package-lock.json"
  rm -rf "$APP/deploy/legacy"
  (cd "$APP" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
  # a native binary would break the "same node_modules everywhere" assumption: fail loudly
  if find "$APP/node_modules" -name '*.node' -o -name 'binding.gyp' | grep -q .; then
    echo "A native module was found in node_modules; the release would not be portable." >&2
    exit 1
  fi
}

MODERN="$(mktemp -d)"
LEGACY="$(mktemp -d)"
stage "$MODERN" package.json package-lock.json
stage "$LEGACY" deploy/legacy/package.json deploy/legacy/package-lock.json

ZIP="$OUT/report-server-$VERSION-$STAMP.zip"
rm -f "$ZIP"
(cd "$MODERN" && zip -qr "$ZIP" report-server)
echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))  [Node 20+]"

# same content as a tar.gz for Ubuntu / Linux servers (keeps the executable bit on the .sh scripts)
TGZ="$OUT/report-server-$VERSION-$STAMP.tar.gz"
rm -f "$TGZ"
tar -czf "$TGZ" -C "$MODERN" report-server
echo "Built $TGZ ($(du -h "$TGZ" | cut -f1))  [Node 20+]"

LZIP="$OUT/report-server-$VERSION-$STAMP-node16.zip"
rm -f "$LZIP"
(cd "$LEGACY" && zip -qr "$LZIP" report-server)
echo "Built $LZIP ($(du -h "$LZIP" | cut -f1))  [Node 16, legacy dependencies]"
