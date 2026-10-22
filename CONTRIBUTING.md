# Contributing

Thanks for helping. MiaSDR runs on Next.js 16, which changed APIs and file conventions. Before you write Next.js code, read the guide for the API you touch under `node_modules/next/dist/docs/`. [AGENTS.md](AGENTS.md) says the same for coding agents; `next dev` rewrites that file, so leave it in place.

## Set up

You need Node 22, Docker and pnpm 10 (the version is pinned in `package.json`; `corepack enable` picks it up).

```bash
corepack enable
pnpm install
cp .env.example .env
docker run -d --name miasdr-dev -e POSTGRES_USER=miasdr -e POSTGRES_PASSWORD=CHANGEME -e POSTGRES_DB=miasdr \
  -p 127.0.0.1:5432:5432 postgres:17
```

In `.env`, replace `BETTER_AUTH_SECRET`, `INTEGRATION_CREDENTIALS_KEY` and `UNSUBSCRIBE_SECRET` with values of at least 32 characters (`openssl rand -hex 32` prints one), and uncomment the `DATABASE_URL` and `DATABASE_SSL` lines at the bottom. Then:

```bash
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. The first visit asks you to create the owner account.

## Where code goes

```
src/app/            routes and screens; route handlers stay thin; _lib/api.ts holds the route wrappers
src/contexts/<ctx>/ one bounded context: people (leads, contacts, companies), outreach, conversations, deals, grid, identity, tenancy, integrations, analytics
  domain/           pure rules with unit tests; imports no framework, database or other layer
  application/      use cases and ports; checks permissions; never imports infrastructure
  infrastructure/   Drizzle stores, read models and adapters (Gmail, Unipile, Anthropic)
  <subdomain>/      the same three layers for one part of a large context:
                    outreach/email, outreach/linkedin, conversations/ai, conversations/actions, conversations/after-reply
src/composition/    wiring that spans contexts; routes import it, no context does
src/platform/       the database (client, schema barrel, migrations, shared read predicates) and the job scheduler
src/shared/         the kernel: errors, env, time zones, formatting; imports nothing above it
src/architecture/   tests that check the whole repository: layers, boundaries, table ownership, copy, docs
src/components/     ui/ primitives (shadcn) and shell/ app-wide components
```

Unit tests of `domain/` and `application/` sit next to the file they test. Tests of `infrastructure/` and `src/platform/db`, most of them integration tests against Postgres, sit in that folder's `__tests__/`.

The tiers under `src/` import downward only: `shared`, then `platform`, then the contexts, then `composition`, then `app`.

A route handler calls `withActor`, `withAdmin` or `withUser`, then one use case. These checks keep the layers apart:

- ESLint (`eslint.config.mjs`) stops `domain/` from importing `application/`, `infrastructure/`, `src/platform`, Next.js, React or Drizzle. It stops `application/` from importing `infrastructure/` and runtime `src/platform` code: a use case takes the database and job slots through ports, and may import platform types and the driver-free `@/platform/db/errors`.
- `src/architecture/context-dependencies.test.ts` keeps contexts in layers (identity, tenancy, integrations, people, outreach, conversations, then deals, grid and analytics): a context imports only lower layers and never `src/composition`. When a lower context needs a higher one, declare a port in the lower context and wire it in `src/composition`.
- `src/architecture/context-dependencies.test.ts` also keeps `src/shared` free of every tier above it, and lets `src/platform` import a context only where its shrink-only list allows.
- `src/architecture/context-dependencies.test.ts` also fixes what a context publishes to the contexts above it: `domain/`, `application/`, schema and composition files, plus the few infrastructure modules in `PUBLISHED_INFRASTRUCTURE`. Wiring that spans contexts lives in `src/composition` (`deals.ts`, `person-lifecycle.ts`, `inbox-filing.ts`).
- `src/architecture/app-boundaries.test.ts` lets `src/app` import a context's `infrastructure/` only through its composition files (`composition.ts`, `*-composition.ts`) and identity's session and auth modules. Add a wired deps function to the composition file instead of importing a store.
- `src/architecture/table-ownership.test.ts` lets only the context that declares a table write it, and lets a context read a higher layer's tables only through that context's read model. It scans `src/platform` too.
- `src/architecture/status-guards.test.ts` checks that every write of `drafts.status` and `campaign_enrollments.status` names the statuses it moves from, as the transition tables in `conversations/domain/draft-status.ts` and `outreach/domain/enrollment-status.ts` define.

The boundary tests keep shrink-only lists of the places that broke a rule when it arrived. When you fix one, delete its entry; the test fails until you do.

UI work follows [DESIGN.md](DESIGN.md) for tokens, components and layout, and [PRODUCT.md](PRODUCT.md) for the words the screens use. Background on why the code works the way it does: [docs/decisions.md](docs/decisions.md) and [docs/database.md](docs/database.md).

## Tests

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test` runs the unit tests. The integration tests skip themselves until `TEST_DATABASE_URL` points at a migrated Postgres 17:

```bash
docker run -d --name miasdr-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=miasdr_test -p 127.0.0.1:55432:5432 postgres:17
export TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/miasdr_test
DATABASE_URL=$TEST_DATABASE_URL pnpm exec drizzle-kit migrate
pnpm test
```

Some tests read the docs, so a docs edit can fail them:

- `docs-links.test.ts` checks every relative link and anchor in the Markdown files.
- `docs-vocabulary.test.ts` checks the Terminology list in PRODUCT.md and the vocabulary tables in docs/decisions.md.
- `env-docs.test.ts` checks that `.env.example`, `docs/configuration.md` and `src/shared/env.ts` name the same variables.

### End-to-end

```bash
pnpm exec playwright install chromium
pnpm e2e
```

`pnpm e2e` builds the app twice (a test build and a production-like build), starts both with fake providers and their own database, and runs the Playwright specs in `e2e/`. It needs a Postgres it can create databases on: set `E2E_PG_URL` to an admin URL, or start one on the default port 55437. The specs run in file order on one worker, and later specs use what earlier ones created (`01-setup-onboarding` creates the owner, `02-invite-signup` the second member), so run a single spec together with the specs it depends on. `E2E_SKIP_BUILD=1` reuses the last builds, and arguments after `--` go to `playwright test`. The header of `e2e/run.mjs` lists the other options.

Timing runs stay out of the suite and live in `scripts/bench`: the grid change feed, grid sort and recalculation, the lead list on 10,000 leads, and the read indexes. Run them with `pnpm vitest run -c scripts/bench/vitest.config.mts` and `TEST_DATABASE_URL` set; each file's header names its size variables. Live enrichment vendor calls live in `scripts/smoke` and need your own keys; see [Enrichment providers](docs/setup/enrichment.md#verification-of-these-adapters).

`scripts/ci-local.sh` runs the whole CI pipeline (install, typecheck, lint, migrate, tests, build, e2e, Docker image check) against a throwaway Postgres. Run it before you push a larger change.

## Before you open a pull request

- A bug fix comes with a test that fails without the fix.
- A schema change needs a Drizzle migration (`pnpm exec drizzle-kit generate`) and a test over existing data. Released migrations never change.
- A behavior change or design choice updates the matching section of `docs/decisions.md`. State what the code does today and check each claim against the code.
- Do not commit secrets, `.env` or files under `secrets/`.

## Style

- Match the surrounding code and its naming.
- Keep a module under 700 lines of code (ESLint `max-lines`). Split a larger one by use case and keep the old path as the entry that re-exports it, as `deals/application/deals.ts` does.
- Write comments and docs in plain English with active voice. Say what the code does and why. Skip filler.
- Keep user-facing messages specific: name the field, the limit or the next step.

## Reporting problems

Open an issue for bugs and feature ideas. Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

MiaSDR is licensed under the GNU Affero General Public License, version 3 or later (`AGPL-3.0-or-later`, see [LICENSE](LICENSE)). By contributing you agree your work ships under it.
