#!/usr/bin/env bash
# Builds the Dockerfile (no push), starts the image against a Postgres and asserts:
#   - the container reports healthy and /api/health answers 200
#   - the rotation script runs under plain node
#   - the migrate script runs under plain node against a fresh database, then finds nothing pending
#   - the E2E helper routes answer 404 even with a session, a valid CRON_SECRET and every runtime helper
#     variable on (the same assertions as e2e/09-production-image.spec.ts)
#
# Usage: scripts/docker-image-check.sh <database-url-as-seen-from-the-container>
# On Linux and macOS the container reaches the host through host.docker.internal.
set -euo pipefail

db_url="${1:?usage: docker-image-check.sh <database-url>}"
tag="miasdr-ci-check:$$"
name="miasdr-ci-check-$$"
jar="$(mktemp)"
cron_secret="ci-cron-secret-0123456789abcdef"

scratch_db="miasdr_ci_migrate_$$"
admin_url=""
cleanup() {
  if [ -n "$admin_url" ]; then
    docker exec "$name" node -e "
      const postgres = require('postgres');
      const sql = postgres(process.argv[1], { max: 1, ssl: false });
      sql.unsafe('drop database if exists ${scratch_db} with (force)').finally(() => sql.end());
    " "$admin_url" >/dev/null 2>&1 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker rmi -f "$tag" >/dev/null 2>&1 || true
  rm -f "$jar"
}
trap cleanup EXIT

docker build -t "$tag" .

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
docker run -d --name "$name" --add-host=host.docker.internal:host-gateway -p "127.0.0.1:${port}:3000" \
  -e "DATABASE_URL=${db_url}" -e DATABASE_SSL=disable \
  -e "APP_URL=http://localhost:${port}" \
  -e "BETTER_AUTH_SECRET=$(printf 'a%.0s' {1..40})" \
  -e "INTEGRATION_CREDENTIALS_KEY=$(printf 'b%.0s' {1..40})" \
  -e "UNSUBSCRIBE_SECRET=$(printf 'c%.0s' {1..40})" \
  -e "CRON_SECRET=${cron_secret}" \
  -e MAILBOX_PROVIDER=fake -e LINKEDIN_PROVIDER=fake -e AI_PROVIDER=fake -e GRID_PROVIDER=fake \
  -e E2E_DEV_HELPERS=1 -e E2E_FAKE_CONTROLS=1 -e EMBEDDED_SCHEDULER=false \
  "$tag" >/dev/null

base="http://127.0.0.1:${port}"
for _ in $(seq 1 90); do
  if curl -fsS "$base/api/health" >/dev/null 2>&1; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    docker logs "$name" >&2
    echo "container exited early" >&2
    exit 1
  fi
  sleep 2
done
curl -fsS "$base/api/health" >/dev/null || { docker logs "$name" >&2; echo "health check failed" >&2; exit 1; }

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() {
  if [ "$2" != "$3" ]; then
    echo "FAIL $1: expected $3, got $2" >&2
    docker logs "$name" >&2
    exit 1
  fi
  echo "ok   $1 -> $2"
}

# A valid secret: the job tick accepts it, so the 404s below are not caused by a bad secret.
expect "jobs/tick accepts the secret" "$(status -X POST -H "authorization: Bearer ${cron_secret}" "$base/api/jobs/tick")" 200

setup="$(status -X POST -H 'content-type: application/json' "$base/api/setup" \
  -d '{"name":"CI Admin","email":"ci-admin@example.test","password":"ci-password-12345","organizationName":"CI Org","timeZone":"UTC"}')"
[ "$setup" = 201 ] || [ "$setup" = 409 ] || { echo "setup answered $setup" >&2; exit 1; }
expect "sign in" "$(status -c "$jar" -X POST -H 'content-type: application/json' "$base/api/auth/sign-in/email" \
  -d '{"email":"ci-admin@example.test","password":"ci-password-12345"}')" 200

expect "dev/inbound is 404 with a session" "$(status -b "$jar" -X POST -H 'content-type: application/json' "$base/api/dev/inbound" \
  -d '{"mailbox":"sdr@e2e-corp.test","fromEmail":"lead@example.test","subject":"Re: hi","bodyText":"hello"}')" 404
for action in delivered liState mailBehavior; do
  expect "dev-fakes ${action} is 404 with the bearer secret" "$(status -X POST -H "authorization: Bearer ${cron_secret}" -H 'content-type: application/json' \
    "$base/api/webhooks/dev-fakes" -d "{\"action\":\"${action}\",\"mode\":\"ok\"}")" 404
done

# The rotation script runs under plain node inside the image (dry run, writes nothing).
rotate_out="$(docker exec "$name" node scripts/rotate-credentials.mjs)" || { echo "rotate-credentials dry run failed" >&2; docker logs "$name" >&2; exit 1; }
case "$rotate_out" in *"Dry run"*) echo "ok   rotate-credentials dry run" ;; *) echo "FAIL rotate-credentials output: $rotate_out" >&2; exit 1 ;; esac

# The migrate script runs under plain node inside the image against a database that has no tables yet.
# The container's own boot migrated the URL's database, so this check uses a scratch database on the same server.
admin_url="$db_url"
docker exec "$name" node -e "
  const postgres = require('postgres');
  const sql = postgres(process.argv[1], { max: 1, ssl: false });
  sql.unsafe('create database ${scratch_db}').finally(() => sql.end());
" "$admin_url" || { echo "could not create the scratch database" >&2; exit 1; }
scratch_url="$(python3 -c 'import sys; from urllib.parse import urlsplit, urlunsplit; u=urlsplit(sys.argv[1]); print(urlunsplit(u._replace(path="/"+sys.argv[2])))' "$db_url" "$scratch_db")"
expected="$(ls drizzle/*.sql | wc -l | tr -d ' ')"
migrate_out="$(docker exec -e "DATABASE_URL=${scratch_url}" -e DATABASE_SSL=disable "$name" node scripts/migrate.mjs)" || { echo "migrate script failed" >&2; exit 1; }
case "$migrate_out" in *"applied ${expected} (${expected} in total)"*) echo "ok   migrate script applied ${expected} migrations to a fresh database" ;; *) echo "FAIL migrate output: $migrate_out" >&2; exit 1 ;; esac
migrate_again="$(docker exec -e "DATABASE_URL=${scratch_url}" -e DATABASE_SSL=disable "$name" node scripts/migrate.mjs)" || { echo "second migrate run failed" >&2; exit 1; }
case "$migrate_again" in *"nothing pending"*) echo "ok   migrate script finds nothing pending on the second run" ;; *) echo "FAIL second migrate output: $migrate_again" >&2; exit 1 ;; esac

echo "docker image check passed"
