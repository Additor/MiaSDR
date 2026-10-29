#!/usr/bin/env bash
# Fails when a browser chunk of the last `pnpm build` holds database code (docs/decisions.md, "API errors and contract types").
# `src/architecture/client-imports.test.ts` checks the imports; this checks what the bundler wrote.
#
# Each marker is a string its package keeps through minification. The script first finds each one in the package
# source, so a marker an upgrade renames fails the check instead of passing it.
#
# Usage: scripts/client-bundle-check.sh   (after pnpm build)
set -euo pipefail
cd "$(dirname "$0")/.."

chunks=".next/static/chunks"
[ -d "$chunks" ] || { echo "client-bundle-check: $chunks is missing. Run pnpm build first." >&2; exit 1; }

# package|marker|a source file of the package that holds the marker
markers=(
  'drizzle-orm|drizzle:entityKind|node_modules/drizzle-orm/entity.js'
  'postgres|CONNECT_TIMEOUT|node_modules/postgres/src/connection.js'
)

failed=0
for entry in "${markers[@]}"; do
  IFS='|' read -r package marker source <<<"$entry"
  if ! grep -qF "$marker" "$source"; then
    echo "client-bundle-check: $source no longer holds \"$marker\". Pick a new marker for $package." >&2
    failed=1
    continue
  fi
  hits="$(grep -rlF "$marker" "$chunks" || true)"
  if [ -n "$hits" ]; then
    echo "client-bundle-check: browser chunks hold $package code (\"$marker\"):" >&2
    echo "$hits" >&2
    failed=1
  fi
done

[ "$failed" = 0 ] && echo "client-bundle-check: no drizzle-orm or postgres code in $chunks"
exit "$failed"
