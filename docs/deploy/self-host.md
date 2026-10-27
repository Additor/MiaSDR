# Self-hosting with Docker Compose

`docker-compose.yml` runs two services: `db` (postgres:17-alpine) and `app` (the Next.js standalone build on Node 22). An external database must run PostgreSQL 17 or newer (`docs/database.md`).

## Install

```bash
cp .env.example .env     # replace each CHANGEME with: openssl rand -hex 32
docker compose up -d --build
docker compose logs -f app
```

The app waits for the database health check, applies migrations at boot under a Postgres advisory lock, then starts the job scheduler. The first visit goes to `/setup`.

## Volumes and files

| Path | Purpose |
| --- | --- |
| Volume `db-data` | All Postgres data. Back it up. |
| `./secrets/google-service-account.json` | Optional Gmail key, mounted read-only at `/run/secrets/google-service-account.json`. |
| `.env` | Secrets. Keep mode `600` and out of version control. |

Compose loads `docker-compose.override.yml` automatically when it exists. The file is git-ignored, so a fresh clone has none. If you made one on this machine, check its paths before you run `docker compose up`.

## Secrets

- `BETTER_AUTH_SECRET`, `INTEGRATION_CREDENTIALS_KEY`, `UNSUBSCRIBE_SECRET` and `POSTGRES_PASSWORD` need `openssl rand -hex 32`. Compose refuses to start when one is missing.
- Keep a copy of `INTEGRATION_CREDENTIALS_KEY` outside the server. Without it, saved credentials cannot be decrypted. To replace a key that leaked or aged out, follow "Rotating the credential key" in [docs/operations.md](../operations.md#rotating-the-credential-key).
- Changing `UNSUBSCRIBE_SECRET` breaks the unsubscribe links in mail you already sent.
- `POSTGRES_PASSWORD` is read when Postgres first creates the volume. Changing it later in `.env` does not change the database password.

## Backups

```bash
docker compose exec -T db pg_dump -U miasdr -d miasdr -Fc > miasdr-$(date +%F).dump
```

Restore into an empty database:

```bash
docker compose exec -T db pg_restore -U miasdr -d miasdr --clean --if-exists < miasdr-2026-01-01.dump
```

Run the dump from cron daily and copy it off the server. Test a restore once on a scratch machine.

## Upgrades

Read the Upgrade notes of each release in [CHANGELOG.md](../../CHANGELOG.md) before you pull it.

```bash
# back up first
git pull
docker compose up -d --build
docker compose logs --tail=50 app
```

Migrations run on boot. To apply them by hand instead, set `RUN_MIGRATIONS=false` in `.env`. The compose file passes it to the app.

## Run one instance

Run exactly one `app` container. The send claim logic uses row locks and unique inserts, but it has not been verified under overlapping instances. Do not use `docker compose up --scale app=2`.

## Job scheduler

The app ticks every 60 seconds with a 50 second budget (`src/platform/jobs/embedded.ts`). The tick runs `email.inbox-sync`, `email.reconcile` and `email.send` when `MAILBOX_PROVIDER` is `gmail` or `fake`.

To run the tick from outside instead, for example from the host's cron:

1. Set `CRON_SECRET` (16 characters or more) in `.env`.
2. Set `EMBEDDED_SCHEDULER=false` in `.env`. The compose file passes it to the app.
3. Add a cron entry that runs every minute:

```
* * * * * curl -fsS -X POST -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/jobs/tick
```

The endpoint answers 401 without the exact bearer token. It returns the tick report as JSON (see [operations](../operations.md)).

## HTTPS with Caddy

Point a DNS record at the server and open ports 80 and 443. Set `APP_URL=https://sdr.example.com` in `.env`. Unsubscribe and auth links use this value.

Add Caddy to the compose file:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    depends_on:
      - app
```

Add `caddy-data:` under `volumes:`. Create `Caddyfile`:

```
sdr.example.com {
    reverse_proxy app:3000
}
```

Then remove the `ports:` mapping on `app` so only Caddy is public. Caddy gets and renews the certificate on its own.

## Health check

`GET /api/health` returns `{"ok":true}` or 503. The Dockerfile defines a `HEALTHCHECK` that calls this URL with `node` (the image has no `curl`), so `docker ps` shows the container as healthy or unhealthy. Monitor the URL from outside as well.

## Other hosts (not tested)

Nobody has deployed MiaSDR to Vercel, Neon or Cloudflare. Docker Compose is the supported path. The notes below come from reading the code.

What any serverless host needs:

- **The Node.js runtime.** The code uses `node:crypto` and `node:fs`, so the Edge runtime cannot run it. On Cloudflare Workers that means an adapter such as OpenNext and the Node.js compatibility flag.
- **An external tick.** A `setInterval` does not run between requests. Set `EMBEDDED_SCHEDULER=false` and call `/api/jobs/tick` with `Authorization: Bearer <CRON_SECRET>` from a scheduler. The route accepts GET and POST, so Vercel Cron works as is. A Cloudflare Cron Trigger needs a small Worker that makes the HTTP call. The tick budget is 50 seconds and the route allows 60, so your plan must allow that duration.
- **Migrations outside the request path.** The app migrates at boot when `NODE_ENV=production` and holds a session advisory lock, which a pooled connection (PgBouncer in transaction mode, Neon's pooled URL) may not keep. Set `RUN_MIGRATIONS=false` and run `pnpm db:migrate` against the direct connection string from CI.
- **Gmail without a mounted file.** Use `GOOGLE_SERVICE_ACCOUNT_JSON`.
- **Fewer connections.** Each instance opens its own pool (`DB_POOL_MAX`, default 8). Lower it to 1 or 2.

Open questions: whether the `postgres` driver works through Neon's pooled endpoint or Cloudflare Hyperdrive, and whether a tick finishes inside your plan's function limit. `output: "standalone"` in `next.config.ts` targets the Docker image; Vercel ignores it, and nobody has checked that build.
