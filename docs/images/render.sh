#!/usr/bin/env bash
# Render docs/images/src/*.html to docs/images/*.jpg with headless Chrome,
# then encode as mozjpeg (about 100 KB per image) with sharp.
# Needs Google Chrome and Node. Set CHROME to use another browser path.
# The paintings in src/art are public domain (Monet, Whistler).
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
tmp="$(mktemp -d)"
render() { # name width height
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1.5 \
    --window-size="$2,$3" --virtual-time-budget=20000 \
    --screenshot="$tmp/$1.png" "file://$PWD/src/$1.html" >/dev/null 2>&1
}
render hero 1200 630
render actions-preview 1200 640
render features 1200 600
render how-it-works 1200 508
npm install --prefix "$tmp" sharp >/dev/null 2>&1
NODE_PATH="$tmp/node_modules" node encode.cjs "$tmp" "$PWD"
