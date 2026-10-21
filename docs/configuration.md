# Configuration

Every setting is an environment variable. Copy `.env.example` to `.env`, replace each `CHANGEME`, and restart the app after a change. `src/shared/env.ts` validates the values on first use and names the variable that failed. Empty values count as unset.

Boolean variables (`RUN_MIGRATIONS`, `EMBEDDED_SCHEDULER`, `PAUSE_OUTBOUND`) accept `1`, `true`, `yes`, `on`, `0`, `false`, `no` and `off`, in any case, with surrounding spaces. Any other word in `RUN_MIGRATIONS` or `EMBEDDED_SCHEDULER` stops the start and names the variable. `PAUSE_OUTBOUND` is the exception: a word it cannot read counts as paused, and the server logs a warning at start.

A test (`src/architecture/env-docs.test.ts`) keeps this page, `.env.example` and the schema in step: a variable in one of them and not in the others fails CI.

## Required

| Variable | Default | Effect |
| --- | --- | --- |
| `DATABASE_URL` | none | PostgreSQL 17 or newer connection string. The bundled compose file builds it from `POSTGRES_PASSWORD`. |
| `APP_URL` | none | Public origin, such as `https://sdr.example.com`, without a path. Auth, unsubscribe and invite links use it. |
| `BETTER_AUTH_SECRET` | none | Session signing secret, 32 characters or more. `openssl rand -hex 32`. |
| `INTEGRATION_CREDENTIALS_KEY` | none | Encrypts saved provider credentials, 32 characters or more. Keep a copy outside the server. |
| `UNSUBSCRIBE_SECRET` | none | Signs unsubscribe links, 32 characters or more. Changing it breaks links in mail already sent. |

## Database and process

| Variable | Default | Effect |
| --- | --- | --- |
| `DATABASE_SSL` | `require` | `disable` for the bundled Postgres container, `require` for everything else. |
| `DB_POOL_MAX` | `8` | Connection pool size, 1 to 50. |
| `RUN_MIGRATIONS` | `true` | Applies pending migrations at boot (production builds only). Set `false` to migrate yourself, see "Migrations" below. |
| `EMBEDDED_SCHEDULER` | `true` | Runs the job tick inside the server every 60 seconds. Set `false` when an external scheduler calls `POST /api/jobs/tick`. |
| `CRON_SECRET` | none | Bearer token for `/api/jobs/tick`, 16 characters or more. Required for an external scheduler. |
| `PAUSE_OUTBOUND` | `false` | Emergency brake. While `true`, automated sequence sends (email and LinkedIn) and mailbox test sends are held. Replies you approve still send. See [Pause all sending](operations.md#pause-all-sending). |
| `DEFAULT_PHONE_COUNTRY` | none | Two-letter country for phone numbers written without a country code, such as `KR` for `010-...`. Settings, Organization overrides it per organization. |
| `INTEGRATION_CREDENTIALS_LEGACY_KEYS` | none | Old credential keys during a rotation, comma separated, 32 characters or more each. See [operations](operations.md#rotating-the-credential-key). |

## Sign-up and mail

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_SIGNUP` | `invite-only` | `open` lets anyone create an account. Requires `MAILBOX_ALLOWED_DOMAINS`. |
| `MAILBOX_ALLOWED_DOMAINS` | none | Comma list of domains whose addresses may be connected as mailboxes. |
| `RESEND_API_KEY` | none | Sends invite and sign-in mail through Resend. |
| `AUTH_EMAIL_FROM` | none | From address for that mail. |
| `GOOGLE_CLIENT_ID` | none | Google sign-in client id. |
| `GOOGLE_CLIENT_SECRET` | none | Google sign-in client secret. |
| `MAILBOX_PROVIDER` | none | `gmail` for real mail, `fake` for demos (nothing is sent). See [Gmail setup](setup/gmail.md). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | none | Gmail service account key as raw JSON. Wins over the file. |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | none | Path to the key file inside the container. |

## LinkedIn, AI and enrichment

| Variable | Default | Effect |
| --- | --- | --- |
| `LINKEDIN_PROVIDER` | none | `unipile` (default behavior) or `fake` for demos. Each organization saves its own Unipile credentials. |
| `LINKEDIN_DSN_ALLOWED_HOSTS` | none | Extra Unipile hosts besides `*.unipile.com`, comma list (`host`, `host:port` or `*.domain`). |
| `AI_PROVIDER` | none | `fake` answers with a keyword classifier and template drafts (demos only). |
| `AI_MODEL` | `claude-sonnet-5-5` | Anthropic model when an organization has not picked one. An owner or admin picks the model in Settings, Integrations, AI model; the pick is checked against the live model list of the saved key and wins over this variable. |
| `GRID_PROVIDER` | none | `fake` enables the deterministic enrichment provider (demos only). It offers Find email and the four shared actions. An address with `invalid`, `catchall`, `unknown` or `disposable` in it gets that verdict, and `nohit` finds nothing. |
| `GRID_HTTP_ALLOWED_HOSTS` | none | Hosts a Custom HTTP enrichment provider may call. Empty means none. |
| `GRID_RUN_CONCURRENCY` | `8` | Grid cells run at once per tick, 1 to 16. |

## Retention

Only logs are pruned. Sends, messages, enrollments and suppression are kept.

| Variable | Default | Effect |
| --- | --- | --- |
| `RETENTION_JOB_RUNS_DAYS` | `30` | Days to keep job run rows. |
| `RETENTION_INBOUND_EVENTS_DAYS` | `30` | Days to keep finished provider events. |
| `RETENTION_INBOUND_FAILED_DAYS` | `90` | Days to keep dead-lettered provider events. |
| `RETENTION_AI_JOBS_DAYS` | `30` | Days to keep finished AI jobs. |

## Compose-only variables

Docker Compose reads these. The app does not.

| Variable | Default | Effect |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | none | Password of the bundled `db` service. Read when Postgres first creates its volume. |
| `PORT` | `3000` | Host port published for the app. |
| `COMPOSE_FILE` | `docker-compose.yml` | Which compose file Compose uses. Set it to `docker-compose.external-db.yml` for an external database. |

## Migrations

By default the production server applies pending migrations on boot under a Postgres advisory lock. To run them from your pipeline instead:

1. Set `RUN_MIGRATIONS=false` on the app.
2. Before starting the new version, run the migrate script with the same `DATABASE_URL` and `DATABASE_SSL`:
   - From a checkout: `pnpm db:migrate` (reads `.env` when the file exists).
   - In the production image: `docker compose run --rm app node scripts/migrate.mjs`.

The script refuses a Postgres older than 17, takes the same advisory lock as the app, and prints how many migrations it applied. Running it twice is safe: the second run reports nothing pending. It exits 1 on a failed migration and prints the database's own message.

## External database

`docker-compose.external-db.yml` runs the app alone against a database you manage (PostgreSQL 17 or newer, see [database](database.md)).

1. Set `DATABASE_URL` in `.env`. Set `DATABASE_SSL=disable` only when the server has no TLS. `POSTGRES_PASSWORD` is not needed.
2. Select the file. Either set `COMPOSE_FILE=docker-compose.external-db.yml` in `.env` or the shell, or pass it each time:

```bash
docker compose -f docker-compose.external-db.yml up -d --build
```

3. Use one file. A `COMPOSE_FILE` that lists both compose files merges the two app services and starts the bundled `db` as well.

A pooled connection string (PgBouncer in transaction mode) can break the advisory lock. Use the direct connection string for `DATABASE_URL`, or set `RUN_MIGRATIONS=false` and migrate from a direct connection.
