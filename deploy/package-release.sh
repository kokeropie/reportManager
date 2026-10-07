#!/usr/bin/env bash
# Builds release/report-server-<version>-<date>.zip: the app plus production node_modules, ready to unzip on the
# Windows server. All dependencies are plain JavaScript (no native modules), so node_modules built on a Mac or
# Linux machine works unchanged on Windows and the server needs no internet access or compiler.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date +%Y%m%d)"
OUT="$PWD/release"
STAGE="$(mktemp -d)"
APP="$STAGE/report-server"
mkdir -p "$APP" "$OUT"

cp -R server.js package.json package-lock.json .env.example README.md src public scripts deploy "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund >/dev/null)

# a native binary would break the "same node_modules everywhere" assumption: fail loudly
if find "$APP/node_modules" -name '*.node' -o -name 'binding.gyp' | grep -q .; then
  echo "A native module was found in node_modules; the zip would not be portable." >&2
  exit 1
fi

ZIP="$OUT/report-server-$VERSION-$STAMP.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qr "$ZIP" report-server)
echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
