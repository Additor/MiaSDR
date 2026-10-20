#!/usr/bin/env bash
# Runs the steps of .github/workflows/ci.yml in the same order against a throwaway Postgres container.
# The container listens on a free local port and is removed on exit. The first failing step stops the run.
#
# Usage: scripts/ci-local.sh            (set SKIP_DOCKER_IMAGE=1 to skip the final Docker image step)
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

name="miasdr-ci-local-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
step() { printf '\n=== %s ===\n' "$*"; }

step "start postgres:17 on port ${port}"
docker run -d --name "$name" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=miasdr_test -p "127.0.0.1:${port}:5432" postgres:17 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres -d miasdr_test >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready -U postgres -d miasdr_test >/dev/null

export TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:${port}/miasdr_test"
export E2E_PG_URL="postgres://postgres:test@127.0.0.1:${port}/postgres"
export NEXT_TELEMETRY_DISABLED=1

step "install";   pnpm install --frozen-lockfile
step "typecheck"; pnpm typecheck
step "lint";      pnpm lint
step "migrate";   DATABASE_URL="$TEST_DATABASE_URL" pnpm exec drizzle-kit migrate
step "vitest";    pnpm test
step "build";     pnpm build
step "e2e";       pnpm e2e
if [ "${SKIP_DOCKER_IMAGE:-0}" != "1" ]; then
  step "docker image"; scripts/docker-image-check.sh "postgres://postgres:test@host.docker.internal:${port}/postgres"
fi

printf '\nci-local: all steps passed\n'
