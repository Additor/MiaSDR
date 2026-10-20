# Decisions

How MiaSDR works and why, by area. Each section states what the code does today. The code wins when the two disagree; fix this file in the same change.

## Scope and principles

### Product

- MiaSDR is an outbound tool first: Leads, Campaigns, Inbox, Actions, Tables and Analytics. The CRM part stays small: a Pipeline of deals, Contacts and Companies.
- Self-hosting with Docker Compose is the primary target. Hosted platforms stay usable through the external tick route and `DATABASE_SSL`.
- Email goes through Gmail, with a Google Workspace service account that has domain-wide delegation, behind the `MailboxProvider` port. LinkedIn goes through Unipile behind the `LinkedInGateway` port. Unipile has no free tier, so LinkedIn is the one paid dependency.
- WhatsApp and calls are out of scope.

### Principles

- A person approves every reply. AI jobs write classifications and drafts and hold no mailer. Campaign steps send on their own once a person starts the campaign.
- Use cases own the rules and the permission checks (`application/`). Route wrappers fix the order of checks and map errors; they never replace a use case check.
- Every business row belongs to one organization, and every query filters by it. An id of another organization answers 404, the same as an id that does not exist.
- A provider call has three outcomes: accepted, refused (`definite`) or unknown. The code claims the work in the database before the call and never retries an unknown outcome on a guess; a reconciler or a person settles it.
- Attribution stores `users.id`. Secrets and tokens are compared in constant time.
- Each bounded context lives in `src/contexts/<name>/` with three layers. A large context splits into subdomains with the same three layers each: `outreach/email` and `outreach/linkedin`; `conversations/ai`, `conversations/actions` and `conversations/after-reply`. What both subdomains share stays at the context root. `domain/` is pure and unit tested. `application/` holds ports and use cases that take an `Actor { userId, organizationId, role }`. `infrastructure/` holds the Drizzle adapters and the composition of each context. Wiring across contexts lives in `src/composition`.
- Contexts form layers, lowest first: identity, tenancy, integrations, leads, outreach, conversations, then deals, grid and analytics. A context imports only lower layers, so the graph has no cycle. When a lower context needs a higher one, it declares a port and `src/composition` passes the implementation in: outreach files received mail through `InboxFiling` (`outreach/application/inbound-ports.ts`), which `src/composition/inbox-filing.ts` binds to conversations. `src/architecture/context-dependencies.test.ts` enforces the layers.
- `src/app` reaches a context's infrastructure only through its composition files, which hand out wired deps, and identity's session and auth modules (`src/architecture/app-boundaries.test.ts`).
- A table belongs to the context whose `schema.ts` declares it, and only that context writes it. Lower-layer tables may appear in a join; a higher layer's tables are read through that context's read model (`src/architecture/table-ownership.test.ts`). Both tests carry a shrink-only list of older exceptions. Read predicates that every context applies to shared tables, such as `src/platform/db/conversation-visibility.ts`, live in `src/platform/db`.

## Platform

### Stack

Node 22 or newer, pnpm 10, Next.js 16.4 (App Router, `output: "standalone"`), React 19, Drizzle ORM on postgres.js, PostgreSQL 17 or newer, Better Auth 1.7, Zod 4, shadcn/ui on Base UI with lucide icons, Vitest and Playwright. License: AGPL-3.0-or-later. XLSX parsing uses `read-excel-file` and `fflate`; `xlsx` (SheetJS on npm) stays out because of its advisories.

### Rendering and build

- `cacheComponents` is on. Anything that reads the session, `params`, `searchParams` or the database renders inside `<Suspense>`, and server components and the route wrappers that read the database call `connection()` first, so `next build` never touches the database or prerenders a GET handler.
- `env()` validates the environment on first use, not at import, and `auth()` builds Better Auth on first use. A build needs no secrets.

### Request gate and session

- `src/proxy.ts` checks only that the Better Auth session cookie exists. Public prefixes: the auth pages, `/unsubscribe`, `/api/outreach/unsubscribe`, `/api/auth`, `/api/setup`, `/api/health`, `/api/jobs/tick` and `/api/webhooks` (the last two check their own secrets). Without a cookie an API path answers 401 JSON and a page redirects to `/sign-in?next=<path>`. The proxy forwards the path in `x-miasdr-path`.
- `resolveOrgContext()` (`identity/infrastructure/session.ts`) validates the session and re-reads the member's role from the database on every request, so a removal or role change applies at once even though Better Auth caches the session cookie for 2 minutes. If the session's active organization has no membership, it falls back to the oldest membership without writing the session back.
- `requireOrgContext()` serves pages: an expired session redirects to `/sign-in?next=<x-miasdr-path>`, a user with no membership to `/sign-in?error=no-organization`.

### Route wrappers and error mapping

| Wrapper (`src/shared/api.ts`) | Use |
|---|---|
| `withActor(run)` | Signed-in member of an organization. 401 otherwise. |
| `withAdmin(message, run)` | Owner or admin. Throws `ForbiddenError` before `run` parses the body, so a member with a malformed body gets 403, not 400. |
| `withUser(run)` | Signed-in user without an organization (create or switch organization). |

| Error (`src/shared/errors.ts`) | Status |
|---|---|
| `NotFoundError`, and a Postgres `22P02` (path id that is not a UUID) | 404 |
| `ForbiddenError` | 403 |
| `ConflictError` (its `details` merge into the body; clients branch on `details.code`) | 409 |
| `PayloadTooLargeError` | 413 |
| `ValidationError` (message plus `issues`) | 422 |
| `ZodError`, `SyntaxError` from `request.json()` | 400 |

- Handlers parse the body inside the wrapper's callback, so a malformed body answers 400 instead of 500.
- Use cases keep their own `requireAdmin` checks for callers that skip the routes, such as jobs and tests.
- A role string can hold several roles, comma separated. `isOwnerOrAdmin` in `tenancy/domain/roles.ts` reads it.

### Route matrix

`src/test-support/route-matrix.integration.test.ts` calls every exported handler of every `route.ts` in process, against Postgres and real Better Auth sessions, and runs `proxy()` for every path.

- Every route must appear in `ROUTES` or `PUBLIC_ROUTES` (`route-matrix-spec.ts`) with every method and path param described, or the test fails.
- A protected handler answers 401 without a session and 403 to a member where it is admin-only, also with a malformed body. It leaves another organization's rows unchanged and unlisted. A handler whose id is a credential (`invitations/[id]` GET) carries `idIsCapability`.
- `PERMISSION_AFTER_VALIDATION` in `route-matrix-allowlist.ts` is empty, and the test keeps it empty.

### Tenant scoping in the database

- Child tables reference their parents with composite `(column, organization_id)` foreign keys, so a row cannot point into another organization.
- `src/platform/db/schema-audit.ts` requires every public table to have `organization_id uuid not null`, a foreign key to `organizations` and an index containing the column. Exceptions sit in `NO_SCOPE` (Better Auth tables, `organizations`, `integration_credentials`), `NULLABLE_SCOPE` (`inbound_events`, `job_runs`) and `INDEX_DEBT`, each with a reason. A stale entry fails the audit, so the lists only shrink.
- `events`, `audit_log` and `messages` are append-only by trigger (migration 0013). `messages` accepts updates to `important` and `opened_at`. Deletes pass inside a cascade or in a transaction that sets `miasdr.allow_purge` to `on`.
- `recordAudit` (`src/platform/db/audit.ts`) writes an `audit_log` row inside the caller's transaction, so the row commits with the change. `meta` never holds a secret.
- Organization deletion is disabled. Foreign keys to `organizations` cascade, which tests use for cleanup.

### Secrets at rest

Integration credentials use an AES-256-GCM envelope `v2:<keyId>:<iv>:<tag>:<ciphertext>` (`integrations/infrastructure/credential-crypto.ts`), keyed by HKDF over `INTEGRATION_CREDENTIALS_KEY`. Decryption also tries `INTEGRATION_CREDENTIALS_LEGACY_KEYS`, and the older `v1` envelope still opens. `pnpm credentials:rotate` (`scripts/rotate-credentials.mjs`, `--apply` to write) re-encrypts every row with the current key and lists rows it cannot open.

### Environment and boot

- `src/shared/env.ts` holds the schema. `ENV_VARIABLES` must match `.env.example` and the tables in `docs/configuration.md`; a test checks both directions.
- `flag()` reads booleans: `1/true/yes/on` and `0/false/no/off` in any case, unset or empty gives the default, any other word throws with the variable named. `PAUSE_OUTBOUND` is the exception: `src/shared/outbound-pause.ts` treats an unreadable value as paused and logs a warning at boot.
- `APP_URL` is reduced to its origin. A path, query, fragment or credentials fail validation, because MiaSDR has no `basePath`.
- `src/instrumentation.ts` at server start: validates `RUN_MIGRATIONS` and `EMBEDDED_SCHEDULER`, refuses PostgreSQL below 17 (`MIN_POSTGRES_MAJOR`, exit with the detected and required versions), applies pending migrations when `RUN_MIGRATIONS` is true and `NODE_ENV=production`, then starts the embedded scheduler unless `EMBEDDED_SCHEDULER` is false.
- `runMigrations` takes `pg_advisory_lock(724105302)` so replicas never race, and rethrows the database's own message for a failed statement. `pnpm db:migrate` (`scripts/migrate.mjs`) uses the same lock key and version floor for operators who set `RUN_MIGRATIONS=false`.
- Migrations live in `drizzle/`, generated by drizzle-kit, with raw SQL for triggers, deferrable keys, `ON DELETE SET NULL (column)` and partial indexes. Migrations roll forward only.

### Scheduler

- One `runTick` entry point runs every registered job inside a time budget (50 s by default). The embedded scheduler ticks every 60 s in process and never overlaps itself. External schedulers call `GET` or `POST /api/jobs/tick` with `Authorization: Bearer $CRON_SECRET` (GET exists because Vercel Cron sends GET).
- Every job claims its own work (`FOR UPDATE SKIP LOCKED` or a lease), so overlapping ticks and several instances are safe.
- `kickJob` (`src/platform/jobs/kick.ts`) lets a request start a job pass 25 ms after it responds. Without an embedded scheduler the kick does nothing and the next tick serves the work.
- Job details, retention and failure logging belong to "Jobs and data retention".
- The test-only routes `/api/dev/inbound` and `/api/webhooks/dev-fakes` answer 404 unless `testHelpersBuilt()` holds (outside production, or a bundle built with `E2E_BUILD=1`, which `next.config.ts` inlines), their runtime flag is set (`E2E_DEV_HELPERS`, `E2E_FAKE_CONTROLS`) and a fake provider is selected. The Docker image is built without `E2E_BUILD`.

## Identity and organizations

### First account and sign-up modes

- `/setup` creates the first user, the first organization and the owner membership in one transaction under an advisory lock, and answers 409 once any user exists. Setup marks the email verified (a new instance may have no mail provider) and stores the time zone in `channel_settings` `general` unless it is UTC. Then the form sends the owner to `/onboarding`.
- While no user exists, `/sign-in` and `/sign-up` redirect to `/setup`, and the `user.create.before` hook refuses every Better Auth sign-up (email and Google) in both modes.
- `AUTH_SIGNUP=invite-only` (default) accepts a sign-up for an address with a pending, unexpired invitation. `open` accepts anyone once the first user exists. Rules: `identity/domain/signup-policy.ts`.
- On an invite-only instance an invited person reaches the form through `/sign-up?invitation=<id>`; the hook still checks the invitation by email. The verification link of an invited sign-up returns to `/accept-invitation/<id>`.
- Email and password need a verified address (`requireEmailVerification`, passwords of 8 characters or more). Google sign-in appears when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; account linking trusts Google.
- Auth emails go through Resend when `RESEND_API_KEY` and `AUTH_EMAIL_FROM` are set; otherwise the server log prints them. Sends are not awaited, so response timing does not reveal whether an account exists.

### Better Auth surface

- The catch-all `src/app/api/auth/[...all]/route.ts` passes GET and HEAD. Any other method must match `ALLOWED_MUTATIONS` in `identity/domain/auth-endpoint-policy.ts`: sign-up, sign-in (email and social), sign-out, send-verification-email, request-password-reset, reset-password, `organization/accept-invitation` and `organization/reject-invitation`. Everything else answers 403 with `code: "AUTH_ENDPOINT_NOT_ALLOWED"` for owners, members and visitors alike.
- The organization plugin runs with `disableOrganizationDeletion: true`, and `organizationHooks` refuse update, member role change, member removal and deletion. Renames, role changes and removals go through the tenancy use cases instead.
- Server code calls `auth().api.*` in process and skips the allow-list. A new browser flow that needs another mutation adds one entry and a test.
- Better Auth's built-in rate limiter guards sign-in, password reset and verification resend. It keeps counts in memory per instance and per client IP, and Better Auth enables it in production only. Behind a proxy it needs `X-Forwarded-For`.

### Roles and members

- Roles: `owner`, `admin`, `member` (`tenancy/domain/member-rules.ts`). Owners grant any role, admins grant admin and member, and members manage nobody. An owner alone changes or removes an owner, an organization keeps at least one owner, and nobody removes themself.
- Role changes and removals run in one transaction that locks the organization's member rows `FOR UPDATE`, so two requests cannot both pass the last-owner check. A removal clears `active_organization_id` on the removed user's sessions for that organization.
- Any member can list members. Listing, sending and revoking invitations needs an owner or admin.

### Invitations

- `inviteMember` checks `canGrantRole`, normalizes the email, refuses an existing member (409) and calls Better Auth's `createInvitation` in process. Invitations expire after 7 days, and a new invitation cancels pending ones for the same address.
- Revoke sets `canceled` and needs a pending invitation (409 otherwise).
- `/accept-invitation/[id]` states come from `deriveInvitationState` (`tenancy/domain/invitation-state.ts`): ready, wrong-account, expired, used, declined, not-found, plus anonymous. A canceled invitation reads as not found, and an id that is not a UUID never reaches Postgres.
- A viewer whose email differs from the invited address learns the organization name and nothing else, whatever the status. `GET /api/invitations/[id]` answers 401 without a session.
- Better Auth checks on accept and decline that the invitation belongs to the signed-in user, and accept sets the active organization.

### Organizations and switching

- `POST /api/organizations` (`withUser`) creates the organization and the creator's owner membership in one transaction and makes it active. A failed switch after the commit is logged, never returned, so a retry cannot create a second organization.
- `mayCreateOrganization`: open mode allows anyone; invite-only allows owners and admins of the oldest organization. Others get 403 before the name is checked.
- The server derives the slug from the name (`uniqueSlug`: `-2`, `-3` suffixes, `organization` when the name has no letters or digits) and retries five times on a unique-index race. The slug stays read-only because invitation links carry it.
- `GET /api/organizations` lists the caller's memberships with `canCreate`. `POST /api/organizations/active` switches after a membership check; a non-member, an unknown id and a malformed id all answer 404.
- A fresh session opens in the user's oldest membership (`session.create.before`).

### Password reset

- `/forgot-password` and `/reset-password` use Better Auth's `requestPasswordReset` and `resetPassword` through the verification email path. Known and unknown addresses get the same response. The token is single use and expires after 1 hour, and `revokeSessionsOnPasswordReset` ends every session of the user.
- A reset does not verify the address. `/reset-password` sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, because the token sits in the query string.

### Onboarding checklist

- `/onboarding` derives every step from tables (`tenancy/domain/onboarding.ts`, read through the schema barrel in `drizzle-onboarding-store.ts`):

| Step | Done when |
|---|---|
| Set the time zone (`profile`) | a time zone is saved in `channel_settings` `general` |
| Connect a mailbox | a `connected` mailbox exists; mailboxes with none connected show attention |
| Import leads | any `people` row |
| Create your first campaign | any campaign |
| Approve your first message | any draft with status `sent` |
| Connect LinkedIn (optional) | a `connected` `linkedin_accounts` row |
| AI key (optional) | an enabled `anthropic` integration with a stored credential |

- Required steps come first. An owner or admin can hide the guide (`POST /api/onboarding/dismiss`), stored per organization in `channel_settings` channel `onboarding` as `{ dismissedAt, dismissedBy }`. Hiding removes the sidebar count; the page stays reachable by URL.

### Organization settings and time zone

- `PATCH /api/settings/organization` (`updateOrganization`): the owner renames; owners and admins set the time zone, the unknown-sender AI cap and the default phone country. Each change writes an audit row (`organization.renamed`, `organization.timezone_changed`, `organization.ai_cap_changed`, `organization.phone_country_changed` with `from` and `to`) in the same transaction. A value equal to the current one writes nothing.
- The zone lives in two places: `channel_settings` `general.timeZone`, which the send engine, analytics and the day logic read, and `organizations.timezone`. Organization settings and Email rules write both in one transaction. Reads prefer a valid `general` value.
- `canonicalTimeZone` (`src/shared/time-zone.ts`) maps legacy ICU ids such as `Asia/Calcutta` to current IANA names at every write and at the reads that feed SQL or day math. An unset or unknown zone means UTC.
- The UI prints timestamps in the organization's zone with the UTC original in a tooltip: `<Time value />` in JSX, `formatDateTime(value, zone)` elsewhere (`components/shell/org-time-zone.ts`, `src/shared/format-time.ts`). The output never depends on the viewer's locale or zone. A filter labelled UTC keeps UTC.

## Leads

### Model

- One `people` row per human per organization, unique by email (`people_org_email_uq`) and by LinkedIn slug (`people_org_linkedin_uq`). `lifecycle` is `lead` or `contact`. The Leads screens list leads; contacts, conversion and companies belong to "Deals and CRM".
- A lead needs an email or a LinkedIn profile. Companies are shared `companies` rows keyed by domain, so the lead form never renames an existing company: a different name answers 422 "Rename {Company} on its company page."
- `updateLead` applies the import normalizers to a form edit. An empty field clears the stored value, unlike import. An email or profile another person holds answers 409 and names that person.

### Import

- Parsing is server side and stateless. `POST /api/leads/import/preview` returns headers, row count, up to three example values per column and a guessed mapping. `POST /api/leads/import/summary` is a dry run: same lock, same plan, rolled back. `POST /api/leads/import` takes the file again with the mapping. `GET /api/leads/import/sample` serves a sample CSV.
- Limits: 5 MB (`MAX_FILE_BYTES`, 413 at preview) and 10,000 rows (`MAX_IMPORT_ROWS`). A larger file is refused whole.
- `parseSpreadsheet` picks CSV or XLSX by content, then by name. `xlsx.ts` guards the XLSX path: the zip signature is required (an OLE file, meaning old `.xls` or password-protected, gets its own message), `.xlsm`, `.xlsb`, `vbaProject.bin` and macro-enabled content types are refused, and the guard inflates the sheet parts alone, up to 64 MB declared in total. Leads read sheet 1, formulas never run (the cached value is read), and a sheet has at most 200 columns and 5,000 characters per cell.
- Identity: email, then LinkedIn slug, then a Sales Navigator or Recruiter member id stored as `raw.linkedin_member_id`. A row with none is invalid. A row whose identifiers belong to two existing people is a conflict and changes nothing. Two rows of one file that claim each other's identifiers are a file conflict.
- Merge rules: a non-empty cell replaces the stored value and an empty cell never erases. Duplicate rows in one file merge, later non-empty values winning. A full name without parts splits on the first whitespace run and fills empty parts only; the full name derives from first and last names when the file gives none. A matched person keeps its lifecycle, and an inserted person is a lead.
- Companies: a mapped domain wins. With a company name and a non-webmail email the import infers the domain (webmail list in `normalize.ts`), but an inferred domain never moves a lead that already has a company. Without a domain the company name goes to `people.raw.company`. A company LinkedIn column accepts `linkedin.com/company/` and `/school/` pages and fills an empty `companies.linkedin_url`. Other domains (aliases) resolve to their company before planning.
- LinkedIn URLs: the parser reads the URL host (`linkedin.com` and subdomains). A profile is stored canonical as `https://www.linkedin.com/in/<slug>/`. Other LinkedIn pages are stored as typed with a null slug, so they never reach the invitation flow. A profile replaces a stored non-person URL, never the reverse.
- Phones are stored as E.164. The country for numbers without a code comes from the file's override (checked with `normalizePhoneCountry`), then the organization's `defaultPhoneCountry` in `channel_settings` `general`, then `DEFAULT_PHONE_COUNTRY`.
- Each import runs in one transaction under `pg_advisory_xact_lock` on `leads-import:<org>`, so two uploads of the same addresses cannot collide on the unique indexes. A caller can pass `tx` (the Tables hand-off does), and the import commits with it. The LinkedIn search sink (`importFoundPeople`) takes the same lock; a search result fills empty names and the title of a matched lead and changes nothing else.

### Source data

- An unmapped column ("Do not map (keep as source data)") goes to `people.raw`, merged by key on re-import. Headers that start with "Company " go to `companies.raw` when the row has a domain.
- `RAW_LIMITS`: 100 keys, 100 characters per key, 2,000 per value, 16,000 in total. Rows that hit a cap count in `rawTruncatedRows`.
- `POST /api/leads/raw/map` ("Map this field") creates or restores a custom field and copies `raw[key]` into `custom` for every lead with the key and no value; `overwrite` replaces values. The raw key stays, and a second run changes nothing. Lead search does not read `raw`.

### Custom fields

- `entity_columns` is the registry for `people` and `companies`; values live in `people.custom` and `companies.custom`. Screen: Settings, Custom fields (`/settings/columns`). Routes: `GET`, `POST` and `PUT` (reorder) `/api/leads/columns`, `PATCH` and `DELETE /api/leads/columns/[id]`.
- Keys: `x_<slug>`, with a hash suffix for labels with non-ASCII characters (so `회사 규모` and `회사 이름` stay apart) and a numeric suffix on collision (`x_plan_2`). A rename changes the label and never the key.
- Names: trimmed, 1 to 60 characters, at least one letter or digit, unique ignoring case across archived fields too (409 names the archived one). Built-in fields cannot be renamed, archived or deleted.
- Any member reads the registry. Every change needs an owner or admin (`withAdmin` and the use case). Delete needs an archived field and strips its key from every row in the same transaction. Reorder takes the full list of active ids and answers 409 for a stale list.
- Every writer takes `leads-columns:<org>:<entity>` first. Import, map-raw and the lead form resolve labels through `resolve-custom-columns.ts`: a folded-name match reuses the stored key, and an archived match is restored for an owner or admin and refused with 409 for a member. The lead edit resolves labels before it locks the lead row, the same order as column delete and import.
- Import suggests `custom:<header>` for every unrecognized named header. The merge field is the camelCase label (`Job Title` gives `{{jobTitle}}`). The mapping step and `validateMapping` refuse labels over 60 characters, labels without a letter or digit and two labels that resolve to the same key or merge field.

### List, filters and export

- `LeadFilter` (`leads/domain/lead-filter.ts`) is one parser for the page URL, the export, `GET /api/leads/ids` and bulk delete. A filter with no `lifecycle` lists leads; `contact` and `all` widen it.

| Param | Meaning |
|---|---|
| `q` | name, email, title, company, LinkedIn slug or pasted URL, phone digits (3 or more); LIKE escaped, 100 characters at most |
| `campaign`, `notCampaign` | `any`, `none` or a campaign id; a `removed` enrollment does not count |
| `email`, `linkedin`, `dnc`, `replied`, `hasConversation` | `yes` or `no` |
| `lifecycle` | `lead` (default), `contact`, `all` |
| `lastFrom`, `lastTo` | inclusive UTC dates on the last contact |
| `from`, `to` | inclusive UTC created dates |
| `source` | the exact value or the part before the first colon |
| `category` | reply category of any of the person's reply records |

- Sort keys: name, company, title, email (lower-cased, nulls last) and created; the default is created descending, and the id breaks ties so pages never skip or repeat a row. Page sizes 25, 50 (default), 100 and 200 (`?size=`).
- "Select all matching" reads up to 5,000 ids. Bulk delete takes up to 5,000 ids, or a filter plus the count the person confirmed: an empty filter answers 422 and a changed count 409.
- `GET /api/leads/export` streams keyset batches of 1,000 rows on `(created_at, id)`, with the cursor as text so microseconds survive. The file is UTF-8 with a BOM. `csvCell` puts an apostrophe before a cell that starts with `=`, `+`, `-`, `@`, tab or CR. Custom fields follow the core columns and a "Source data" JSON column. `ids` (up to 200, `MAX_FILTER_IDS`) exports exactly those people and ignores the other keys and the lifecycle default.
- The visible column set is a per-user cookie `leads-columns-<user id>`, read on the server.

### Lead status

- `leadStatus()` in `outreach/domain/lead-status.ts` gives one state per lead, first match wins: replied (an inbound message in a public conversation, or a `replied` enrollment), in sequence (`active` in an active campaign), paused (`active` or `pending` in a campaign that is not active), queued (`pending` in an active campaign), finished or stopped (the newest ended enrollment is `completed`, or bounced, suppressed, failed or cancelled), new (no enrollment, or removed ones only).
- Within a rule the newest `updated_at` wins, then the id. Personal campaigns stay out. Last contact is the later of the latest outbound message and any enrollment's `last_sent_at`, removed enrollments included.
- `readLeadStatuses` (`outreach/infrastructure/drizzle-lead-statuses.ts`) fills a page of ids in two organization-scoped queries. The Leads list and the lead page both read it through `readLeadActivity`, so they show the same state. A contact carries no lead status.

### Reachability and do not contact

- Reachability is separate from lead status (`outreach/domain/reachability.ts`, read by `readReachability`): do not contact with reason and time, email open, suppressed or missing, LinkedIn open or missing. A suppressed address blocks email and leaves LinkedIn open.
- `setPersonDoNotContact` (conversations) is the one writer. `POST /api/crm/people/[personId]/dnc` sets or clears it; `POST /api/crm/people/dnc` marks 1 to 200 people, one transaction each, reporting `already_marked`, `not_found` or `retryable`. Setting needs a reason (500 characters at most).
- Setting upserts `contact_policies` (source `human`) and, in the same transaction, sets the person's `pending` and `active` enrollments to `suppressed` with `stop_reason = 'do_not_contact'`, ends follow-up runs, retires open drafts and returns open reply handling to `action_required`. Clearing removes the flag and revives nothing. The flag applies to every channel, and the send engines check it again before each provider call.

### Delete

- A lead is refused, never cascaded, when any of these holds:
  - a `sends` row with status `sending`, `sent` or `unknown` (`has_hidden_sends` when the send sits in another member's personal campaign);
  - a `pending` or `active` enrollment in an active or paused campaign;
  - a reply-handling `records` row or an `events` row;
  - `lifecycle = 'contact'` (contacts have their own delete).
- The refusal names the reason and points to do not contact. A deletable lead goes with its contact policy and its unsent enrollments. Each batch is one transaction. A foreign key from a table the leads context does not know (`23503`) reruns the batch one lead at a time and reports that lead as `linked_records`.
- Deleting a person marked do not contact first copies the address to `suppression_list` (reason `manual`), so a later import cannot revive it. Setting do not contact writes history events, so a lead marked through the product counts as having history afterwards.
- The lead page states the outcome before the click with the same rules (`checkLeadDelete`).

## Email outreach

Code: `src/contexts/outreach`. The domain layer holds working hours, send policy, rendering, threading, bounce checks and unsubscribe tokens. `sendNextEmail` and `reconcileUncertainSends` live in `application/send-next-email.ts`; the claim lives in `infrastructure/drizzle-outreach-store.ts`.

### Send engine

- **One send per mailbox per claim.** `claimNext` locks the mailbox row (`FOR UPDATE SKIP LOCKED`), checks status, gap (`next_send_at`), working hours and the daily limit, picks the next due enrollment (`FOR UPDATE OF e SKIP LOCKED`), inserts the `sends` row and places the next gap, all in one transaction. The insert is the claim: `(enrollment_id, step_number)` is unique, and a `failed` row below attempt 3 is re-claimed by the same upsert. A worker that loses a lead to another worker tries the next one.
- **Daily limit.** A count of today's `sends` rows of `kind = 'campaign'` with status `sending`, `sent` or `unknown`, from the start of the local day in the mailbox's working-hours zone. Definite failures and test sends use no quota.
- **Order.** Follow-ups (`active`) before new leads (`pending`), then the oldest due first. An enrollment is pinned to a mailbox only in `markSent`, so a failed first step can retry on any mailbox.
- **Defaults.** Working hours are Monday to Friday 09:00 to 18:00 in the organization's zone (`channel_settings.general.timeZone`, UTC when unset). A mailbox with no saved hours sends by that default. The gap is 18 to 24 minutes, set per organization in `channel_settings.email.sendGapMinutes` (whole minutes, 1 to 240).
- **Checks after the claim.** `checkBlockers` runs right before the provider call: the enrollment must still be `pending` or `active` (`enrollment_stopped`), the campaign `active`, the address off `suppression_list`, the person not do not contact. A paused campaign gives the attempt back. Any other block marks the send failed at attempt 3.
- **Empty subject.** `sendNextEmail` fails the lead with `send_failed: Subject is empty for this lead` before anything is stored or sent.
- **Status guards.** Every store write that ends a send or moves an enrollment filters on the previous status, so a reply, unsubscribe or bounce that lands between claim and send is never overwritten. The provider call cannot be undone: a stop that lands after `checkBlockers` still sends one mail.

### Outcomes and reconciliation

| Provider answer | Send status | What follows |
|---|---|---|
| Accepted | `sent` | Enrollment advances |
| Refused (`definite`) | `failed` | Retry after 15, then 30 minutes; the third failure fails the enrollment |
| Anything else (`unknown`) | `unknown` | Never retried on a guess |

- We set our own `Message-ID` and an `X-MiaSDR-Send-Id` header before sending. Gmail replaces `Message-ID`, so `findSent` scans sent mail since the claim and matches the custom header.
- `findSent(mailbox, rfcMessageId, since, hint?)` returns `found`, `absent` or `inconclusive`. The query is `in:sent [to:<address>] after:<claim minus 1 hour>` with `includeSpamTrash=true`. `absent` needs a complete listing, no page cap hit, and a claim at least 10 minutes old (`FIND_SENT_INDEX_LAG_MS`). A claim older than 30 days (`FIND_SENT_HORIZON_MS`) is `inconclusive`.
- `reconcileUncertainSends` looks up `unknown` sends older than 10 minutes. Found: `sent` and the sequence advances. Absent after 30 minutes: retryable. `inconclusive` and API errors leave the send `unknown` (job detail `reconcile_inconclusive`).

### Unconfirmed sends

The campaign page lists email sends still `unknown` after 30 minutes (`UNCONFIRMED_AFTER_MINUTES`); the campaigns list shows an "N unconfirmed" count. `POST /api/campaigns/[id]/sends/[sendId]/resolve` with `{ outcome, checkedSentFolder? }` settles one (owner or admin, `withAdmin`).

- `delivered` marks the send `sent` and advances the enrollment through `advanceEnrollment`.
- `not_delivered` needs `checkedSentFolder: true` (422 otherwise), marks the send `failed` and schedules the retry, so the step goes out again. The attempt cap still applies.
- `resolveUnknownEmailSend` takes the row lock and checks `status = 'unknown'`; a send that already left `unknown` answers 409.

### Mailboxes and takeover

- Connecting, editing, testing, disabling and removing a mailbox needs owner or admin. `verify` through the provider decides `connected` or `failed` with a reason.
- A mailbox with leads still in a sequence cannot be removed (disable it instead). A mailbox that is the only assigned sender of a campaign that is not completed cannot be removed either. Sending history blocks removal through the `sends` foreign keys.
- **Takeover.** A follow-up stays on the mailbox that sent step 1, so it threads in the same Gmail conversation. When that mailbox is not `connected` (or gone) for longer than `takeoverAfterHours` (`channel_settings.email`, default 24, whole hours 1 to 168), another connected mailbox of the campaign's sender list may claim the follow-up. A connected mailbox that is out of hours, throttled or at its limit never loses its leads.
- `mailboxes.unavailable_since` starts the clock when the status leaves `connected` and clears it on return. `sends.taken_over_from_mailbox_id` records the source mailbox.
- A taken-over follow-up starts a new thread: `buildClaim` drops the Message-ID and thread id of earlier sends from another mailbox and keeps the subject.

### Gmail adapter and inbound sync

- **Auth.** Service account with domain-wide delegation, JWT signed with `node:crypto`. Key in `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`. Scopes: `gmail.send`, `gmail.readonly`, `gmail.modify`. `MAILBOX_PROVIDER` picks `gmail` or `fake` (in-memory, demos and tests). With neither, or with a missing or malformed key, `emailJobs()` registers no email job and the app still boots.
- **Jobs.** `email.inbox-sync` runs before `email.send`, so a reply stops follow-ups before they are claimed. Then `email.reconcile` and `email.reconcile-test`.
- **Polling.** `email.inbox-sync` calls `history.list` from `mailboxes.gmail_history_cursor`, at most once a minute per mailbox. The first sync stores the cursor and ingests nothing. The cursor moves only after every message in the batch applied, and only if it still equals the value the sync started from. An expired cursor resets and writes the gap into `last_error`.
- **Order of handling.** Bounce, own message, auto-reply, ordinary message.
- **Dead letters.** A message that fails to apply 5 times (`MAX_MESSAGE_ATTEMPTS`) is skipped and stays `failed` in `inbound_events`. Owners and admins review it at `/settings/inbound-events` (`GET /api/inbound-events`, `POST .../[id]/retry`, `POST .../[id]/dismiss`). A Gmail retry fetches the message by id through `MailboxProvider.fetchMessages` on the next sync (up to 25 per mailbox); a LinkedIn retry hands the row back to `linkedin.replay-events`.

### Bounces

The From name and body are attacker controlled, so classification alone never suppresses an address. A hard bounce suppresses only when both hold:

1. This mailbox sent to the failed recipient: a `sends` row of the mailbox, status `sending`, `sent` or `unknown`, claimed within 90 days.
2. The notice ties to that send (`X-MiaSDR-Send-Id`, or `In-Reply-To`/`References` equal to the send's ids), or the sender is an authenticated delivery system. That means local part `mailer-daemon` or `postmaster` on a Google domain, our mailbox's domain or the recipient's domain, and the first `Authentication-Results` header (authserv-id on google.com) shows `dmarc=pass`, aligned `dkim=pass` or aligned `spf=pass`. Any non-pass DMARC rejects.

A failed check stores the message as an auto-reply, sets `possibleBounce: true` in `raw` when we mailed that address, and counts `unverified_bounce` in the job detail. A verified bounce adds the address to `suppression_list` (reason `bounced`), sets the person's pending and active email enrollments to `bounced`, and ends their After a reply runs.

### Unsubscribe and suppression

- One HMAC token (`UNSUBSCRIBE_SECRET`) binds organization and address. The body footer links to the page `/unsubscribe?token=`, which asks for a click because mail scanners follow links.
- `List-Unsubscribe: <APP_URL/api/outreach/unsubscribe?token=...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` go on campaign mail, test mail and replies. The POST route is public, accepts only the form body `List-Unsubscribe=One-Click` or the page's JSON `{token}`, and answers 400 for anything else.
- `suppressEmail` writes `suppression_list` once per organization and address (a conflict does nothing), sets pending and active email enrollments of that address to `suppressed` (or `bounced`), and ends their runs in the same transaction. Suppression blocks email only.

### Test send

`POST /api/mailboxes/[id]/send-test` (owner or admin) writes a `sends` row with `kind = 'test'` and no enrollment.

- The claim takes the mailbox row lock, checks `connected`, the domain policy and the recipient (suppression, do not contact), and enforces 3 test sends per mailbox per 60 minutes, any status. A test send still `sending` and under 2 minutes old blocks a second one.
- Test sends ignore working hours, the gap and the daily limit. Outcomes follow the campaign rules; `email.reconcile-test` settles `unknown` rows and never retries.
- The route answers 200 with `{ status: sent | failed | unknown | blocked | rate_limited, message }` and writes `audit_log` action `mailbox.test_sent`.

### Mailbox domain allow-list

Domain-wide delegation lets `verify()` succeed for any Workspace address. `MAILBOX_ALLOWED_DOMAINS` (comma list) limits which addresses connect and send. With it unset, `AUTH_SIGNUP=invite-only` allows any address and `AUTH_SIGNUP=open` refuses every connection. The send path enforces the same rule: a mailbox outside the list sends nothing and counts as `blocked_by_domain_policy` in the `email.send` detail. Connect rejects with 422; retest and re-enable mark the mailbox `failed` with the reason.

### PAUSE_OUTBOUND

`isOutboundPaused()` (`src/shared/outbound-pause.ts`) reads `process.env` on every call. A value `flag()` cannot read counts as paused, and the server logs a warning at start. While paused, `sendNextEmail`, `runNextLinkedInAction` and the `email.send` and `linkedin.run` jobs claim nothing, and a test send answers 409. Inbox sync, reconcile, webhook replay, LinkedIn sync and search, drafts and AI jobs keep running, so a reply still stops its sequence. Replies a person approves in the Inbox still send. The Jobs page and both campaign views show a banner.

## LinkedIn outreach

Code: `src/contexts/outreach`. `domain/linkedin.ts` holds step rules, limits, pacing and event keys. `application/send-next-linkedin.ts` runs one action, `linkedin-inbound.ts` handles webhooks, `infrastructure/unipile-gateway.ts` is the adapter behind the `LinkedInGateway` port. `LINKEDIN_PROVIDER=fake` swaps in `FakeLinkedInGateway` (one demo account, 45 made-up search results).

### Unipile gateway

- **Credentials.** DSN, API key and webhook secret are one JSON blob in `integration_credentials`, encrypted with `INTEGRATION_CREDENTIALS_KEY`. Managing them, syncing accounts and editing limits needs owner or admin.
- **DSN allow-list.** The DSN host must be `*.unipile.com` (optional port) or match `LINKEDIN_DSN_ALLOWED_HOSTS` (`host`, `host:port` or `*.domain`). IP literals, userinfo, paths and non-https schemes are refused. Loopback over http works only with `LINKEDIN_PROVIDER=fake` or an explicit `allowLoopback` option in tests; `NODE_ENV` does not enable it. The DSN is checked again before sync, webhook registration and every gateway call. Error text shown to a client is fixed text, never the upstream body.
- **Outcomes.** 5xx, network errors, timeouts and a 2xx body that is not JSON are `unknown`. Every other answer is `definite`. 429 and 422 `cannot_resend_yet` (and similar limit types) are `rate_limited`: the account pauses for 24 hours (`limit_reached_until`) and the attempt goes back. 401 is `auth` and disconnects the account. A 401 or 403 of type `insufficient_privileges` keeps the account connected. `already_connected` skips the invitation; `already_invited_recently` counts it as sent.
- **Account sync.** `linkedin.sync-accounts` runs per credentialed organization once per UTC hour (slot `linkedin-sync` / `YYYY-MM-DDTHH`). `provider_account_id` is unique across organizations; an account id held by another organization is skipped. `lastSyncAt` and `lastSyncError` sit in the integration row's `config`.

### Hosted auth

`POST /api/linkedin/accounts/hosted-auth` (owner or admin) creates a Unipile hosted-auth link to connect or reconnect a profile.

- Each link is a row in `linkedin_connect_links`. The notify URL (`/api/webhooks/unipile-account`) carries the link id and a random secret; the row keeps only its SHA-256. A wrong id, secret or echoed `name` answers 401.
- A link expires after 15 minutes (callbacks accepted for 30), completes once, and an organization holds at most 5 pending links. A sync failure answers 502 and keeps the link pending so Unipile retries.
- Redirect URLs come from `APP_URL` only.

### Step state machine

- Step 1 is the invitation (optional note); later steps are messages. A campaign has at most 6 steps, waits of 0 to 60 days, the first wait 0 and message waits at least 1 day.
- The rendered note must fit 300 characters (`INVITE_NOTE_MAX`, counted with `String.length`); a longer note fails the lead. `inviteNoteLength` counts the same way with each spin group's longest option, so the preview flags every note the engine would fail.
- Enrollments move `pending` to `active` with `connection_state` `none`, `request_sent`, `connected`. Acceptance (`new_relation`, or our own note echoed in a new chat) schedules step 2 after its wait, and each later step after the previous one. A reply sets `replied`. An invitation not accepted in 30 days ends `completed` with `invite_not_accepted`.
- A lead is pinned to the account that resolved its profile, because provider ids and chats belong to one account.
- **Reconciliation.** `rfc_message_id = li:<send id>` marks that a call may have started. `linkedin.reconcile` checks an unresolved invitation older than 10 minutes in the sent list, then by network distance; an unresolved message by text in its chat. Missing after 30 minutes is retryable.

### Limits and pacing

One claim locks the account row and does one action: a due message, one invitation, or one profile lookup. `next_allowed_run_at` holds the gap.

| Rule | Default | Where |
|---|---|---|
| Invitations per day | account `daily_invite_limit` (1 to 100), else 30 premium or 5 free | `linkedin_accounts`, `channel_settings.linkedin` |
| Invitations per week | 100 (1 to 200) | `channel_settings.linkedin.invitesPerWeek` |
| Messages per day | 50 (1 to 200) | `linkedin_accounts.daily_message_limit` |
| Gap after invitation, message, lookup | 10 to 20, 2 to 6, 1 to 3 minutes | `channel_settings.linkedin` |
| Gap between typed replies | 8 seconds (0 to 600) | `channel_settings.linkedin.replyGapSeconds` |

Invitation counts are windows over `sends`, so nothing needs a daily reset. The message cap counts sequence messages from `sends` plus replies from `send_attempts` per UTC day. The limits editor warns above 30 invitations (premium), 10 (free) and 100 messages.

### Webhooks and idempotency

- `POST /api/webhooks/unipile?org=<organization id>` with header `x-unipile-secret`, compared in constant time (401 otherwise).
- Every delivery writes an `inbound_events` row first, keyed `unipile:message_received:v2:<org>:<account>:<message id>` or `unipile:new_relation:v2:<org>:<account>:<member>`. The organization is in the key because `inbound_events` is unique on (provider, key) across tenants. Replay reads the stored payload, so v1 rows still replay.
- Processing runs synchronously. A failure is logged on the row and answered 200; `linkedin.replay-events` retries with backoff from 5 seconds doubling to 15 minutes, 8 attempts.
- Connect registers both hooks and stores the result in `integration_accounts.config.webhooks`; disconnect removes them at Unipile. A local or private `APP_URL` skips both. `POST /api/linkedin/webhooks/setup` (owner or admin, `no-store`) reveals the secret for manual setup and writes `integration.secret_viewed` first.

### Sales Navigator ids

`domain/linkedin-identity.ts` parses a public slug or a member id (`A(Co|Cw|E)...`, a bare token from 20 characters). Enrollment accepts a slug, a member URL or `raw.linkedin_member_id`. The resolve calls `getProfile` without `linkedin_api` first and retries once with it only after a definite refusal on a Sales Navigator or Recruiter reference; `insufficient_privileges` on that retry fails the lookup and keeps the account connected. A slug written back that collides with another lead fails the enrollment and changes neither person.

### Search queue and batches

Code: `domain/linkedin-search.ts`, `application/linkedin-search.ts`, `run-linkedin-search.ts`, `linkedin-search-batch.ts`. Job `linkedin.search`. Page `/leads/searches`.

- **URL.** Only `linkedin.com/search/results/people` and `linkedin.com/sales/search/people`, forced to `https://www.linkedin.com`, tracking parameters dropped. 1 to 2500 results, default 100.
- **Status.** `queued`, `running`, `paused`, `paused_limit`, `completed`, `failed`, `cancelled`. Pause works from queued, running and `paused_limit`; resume from paused, `paused_limit` and failed; cancel from every open state.
- **Claim.** One transaction locks a due search and one account and writes two 120-second leases. The search gap (3 to 7 seconds, `searchGapSeconds`) sits in `next_page_at` and the account lease. A search with a cursor stays on its account; otherwise it takes the connected account with the most allowance left.
- **Allowance.** `searchLeadsPerDay` (default 400, 10 to 2500) per account and UTC day in `search_leads_today` with `search_day`. With every account spent the search turns `paused_limit` and resumes the next UTC day.
- **Outcomes.** `rate_limited` pauses the account for 24 hours and moves the search on; `auth` disconnects the account. An unknown outcome retries the same cursor with backoff from 1 minute; the fifth in a row fails the search.
- **One page, one transaction.** Leads, enrollments, result rows and counters for a page commit together after the store confirms the claim. A crash re-reads the same cursor and adds nothing twice. Lock order: search row, then the per-organization import lock.
- **Leads.** `importFoundPeople` matches by slug or member id. A matched lead only gets empty names and title filled. A target campaign enrolls found people in the same step.
- **Batches.** Upload CSV or XLSX (at most 500 rows and 1 MB, refused whole). Rows dedupe by `searchUrlKey`, skip URLs already queued in the organization, and keep a report of refused rows. A batch can restrict accounts (`account_ids`) and holds at most 1000 searches. "Rerun failed" moves `failed` searches to `queued` and keeps cursor and results. Deleting searches, results or a batch needs owner, admin or the uploader, answers 409 while a search is `running`, and leaves imported leads alone.

### Personal campaigns

`campaigns.type` is `regular` or `personal`; personal is LinkedIn only (`campaigns_personal_linkedin_ck`). The type can change until the campaign has a send, and never away from personal once private replies exist.

- A reply from a member enrolled in a personal campaign on that account lands in a conversation with `private_campaign_id` set. It stops the person's enrollments and leaves the record untouched, so no classification, draft or task follows. A private thread never turns public.
- `conversation-visibility.ts` (`publicConversation`, `publicConversationSql`, `visibleRecordSql`) is the one predicate. Inbox, counts, search, unread badge, Actions, reply stores, AI loaders and the sequence start use it; `conversation-visibility.test.ts` fails on a reader of `conversations` without it.
- `readPersonalThread` serves owner, admin and the campaign creator (403 otherwise).

## Campaigns

Code: `outreach/application/campaign-management.ts` (email), `linkedin-campaigns.ts` (LinkedIn), `enrollment-admin.ts`, `enrollment-restore.ts`. Any member can create, run and fill campaigns.

### Lifecycle

| From | To |
|---|---|
| `draft` | `active` |
| `active` | `paused`, `completed` |
| `paused` | `active`, `completed` |

- **Start** needs valid steps, no `[[placeholder]]` left from the starter template, every assigned sender connected, and at least one connected mailbox or account. The first email launch renders step 1 for up to 20 live enrollments and refuses only when every sampled subject comes out empty; otherwise it returns `emptySubjectLeads` and `sampled`.
- **Steps** change only while the campaign is `draft` or `paused`, and never shrink below the furthest step a lead reached. Email: up to 10 steps, first wait 0 days, follow-ups 1 to 60.
- **Delete** works on a draft only. **Archive** sets `campaigns.archived_at` on a `completed` campaign, checked in the same UPDATE. An archived campaign refuses status changes (409). Lists hide archived campaigns unless `?archived=only|all`.
- Campaign writes and sender replacement commit in one transaction.

### Enroll, remove, restore

- **Enroll** by `{ personIds }` (1 to 500) or `{ query, limit, dryRun? }` (up to 5,000). Each requested id lands in one bucket of `PickedEnrollCounts`: added, not found, missing identity, duplicate, removed earlier, suppressed, do not contact or contact. An id of another organization counts as not found, so the answer never confirms it exists. Contacts can never enroll: `notContactSql` filters every candidate select, and triggers on `campaign_enrollments` raise `contact_cannot_be_enrolled` as the last guard. A completed campaign takes no leads.
- **Remove** (`DELETE .../enrollments/[enrollmentId]`, `POST .../enrollments/remove`, up to 500) sets `removed` with `stop_reason = 'removed'` on `pending` and `active` rows only; final rows count as `skippedFinal`. History and sends stay. A send already claimed drops at `checkBlockers`.
- **Restore** (`POST .../enrollments/restore`, up to 500) refuses: not removed, campaign completed or archived, a genuine reply, do not contact, suppressed (email), a contact, live in another campaign on the same channel, no step left. A lead with progress comes back `active`, otherwise `pending`. Restore and the reply stop share `lockPersonOutreachTx`, a per-person advisory lock, so one sees the other's commit. Each restore writes an `enrollment.restored` event and an audit row.
- Enroll answers carry cross-campaign `notices` (other enrollments with a sent step or reply, leads skipped for `already_contacted_by_account`), at most 50 rows. Personal campaigns stay out.

### Senders

`campaign_senders` holds the sender list. Create and PATCH take `senderIds`; each must belong to the organization and be connected (422). An empty list means every connected sender. Email: a lead pinned to a mailbox outside the list moves to a listed one at the next claim (new thread). LinkedIn: the list gates lookups, invitations and messages; leads already invited stay with their account, while uninvited pending leads lose their pin when their account leaves the list.

### Sequence

The campaign's Sequence is its outbound steps in `campaigns.steps`. Merge fields come from `buildVariables`: company raw, person raw, standard fields and aliases, custom columns, then per-enrollment `merge_fields`. An empty merge field takes one adjacent space with it. Preview and send read the same variable columns (`enrollment-variables.ts`) and report unresolved tokens (`empty` or `unknown`).

### After a reply

A campaign setting with two modes, stored as state on a campaign-owned row in `sequences` (`campaign_id`, one per campaign):

| Mode | Stored as |
|---|---|
| Stop and hand the conversation to the Inbox (default) | no row, or status `archived` |
| AI drafts follow-ups for my approval (`ai_drafts`) | status `active` with a published version |

- **Flow.** Step 1, "Reply to their answer", has delay 0 and adopts the reply draft the classification already queued. Later steps have a delay in days, a Goal, optional starting text and knowledge tags. The job (`conversations.sequences`) only writes drafts; `approveAndSendDraft` sends each one after a person approves it.
- **Save publishes.** Published versions are frozen (migration 0016 triggers). A run keeps the version it started on. Switching to handoff asks first and ends runs in progress with reason `after_reply_off`; the steps stay.
- **LinkedIn and personal** campaigns are locked to handoff.
- **Start rule.** A run starts for a reply whose owning campaign is the one that most recently emailed the person: a `sends` row of `kind = 'campaign'`, channel `email`, status `sent`, latest `sent_at` no later than the reply. That campaign must be email, regular, not archived, `active` or `completed`, and in `ai_drafts` mode. Its mode decides, even when an older campaign has a flow. The reply must be classified (auto-applied, accepted or overridden at the current context version) into a subcategory outside `NO_START_KEYS` and outside the not-interested category. It must arrive no earlier than 10 minutes (`NEW_REPLY_MARGIN_MINUTES`) before `sequences.after_reply_enabled_at`, the moment the flow last switched from off to on. Contacts, do not contact and suppressed people start nothing. A person's Restart skips the recency rule.
- **Paused campaign.** It starts no runs and holds draft creation for runs in progress. Completed and archived campaigns let runs continue.
- **Delays.** Whole days move by calendar days in the organization's zone and keep the wall-clock time across DST. The next step is due its delay after the previous message was sent, skipped or discarded.
- **Stop rules.** A reply, do not contact, unsubscribe, bounce, manual suppression, a closed record, conversion to contact, and a move into a terminal subcategory (not-interested category, `do_not_contact`, `left_company`, `wrong_contact`, `connected_to_different_contact`, `customer`) end the run as `interrupted` and retire its unsent drafts. Each writer does this in its own transaction through `src/platform/db/sequence-stop.ts` (`endRunTx`, `interruptPersonRunsTx`, `interruptEmailRunsTx`); a sweep at the start of each tick is the safety net.
- **Draft fate.** Sent: the step is `sent` and the next scheduled. Discarded: `skipped`. Stale without a stop reason: drafted again up to 3 times, then `failed`. A failed step waits for a person to retry or skip it.
- **Races.** `claimDue` takes one step with `FOR UPDATE SKIP LOCKED`. `linkDraft` locks the run before the step, the same order as `endRunTx`, and returns false for an ended run, so the job retires the draft it wrote. `endRunTx` also retires drafts whose `request.sequenceRunId` names the run.
- **Per-record controls** on the Inbox thread: `POST /api/crm/records/[id]/after-reply` with `pause`, `resume`, `skip`, `cancel` or `restart`. Restart answers 409 with the reason the server computed when it cannot run.

## Conversations, Inbox and Actions

Code: `src/contexts/conversations`. Ingest entry points are `receiveInbound` and `receiveInboundLinkedIn` (`infrastructure/composition.ts`), which the outreach adapters call.

### Ingest

- The idempotency key is per provider message (`gmail:<mailbox>:<id>`, `linkedin:<account>:<id>`), so a replay stores nothing new.
- An unknown but usable sender becomes a person with source `inbound` and `lifecycle = 'lead'`. The LinkedIn sender resolves to the enrolled lead, else the lead with the sender's profile slug, else a new person. Echoes of our own messages are not stored.
- In the ingest transaction a real (non-auto) message turns open drafts of the record `stale`, runs the reply stop, remembers CC addresses and auto-assigns the record.
- **Quarantine.** Only messages that cannot be tied to anyone park as `identity_exceptions`: an email with an unusable sender address, and a LinkedIn message from a new chat whose sender has no slug and matches no lead. A known thread or a named lead never parks. Resolving at `/inbox/unmatched` replays the stored message under the chosen person; the organization comes from the exception row.

### A reply stops all outreach

`stopPersonOutreachOnReplyTx` (`src/platform/db/sequence-stop.ts`) runs in the transaction that stores a genuine reply, on both channels. It takes the person advisory lock, sets every `pending` or `active` enrollment of the person to `replied` (`stop_reason = 'replied'`, on every channel, campaign and account), interrupts their runs, and writes one `outreach.stopped_by_reply` event per person. The person is the one the conversation is filed under plus anyone in the organization with the sender's address, so mail without thread headers still stops. Auto-replies and unverified bounces skip the stop. Finished enrollments keep their status. A replay stops nothing.

### AI classification

- `ai_jobs` (job `conversations.ai`) uses a lease and `SKIP LOCKED`. The tick sweeps records whose latest inbound message has no job. 3 attempts, retry delay `min(5 min, 2 s * 2^(attempts-1))`, a lease older than 5 minutes is taken over. With no Anthropic key the job releases the work without using an attempt.
- **Untrusted text.** Email text, names, knowledge and operator instructions sit in tags with a per-request nonce. The output is closed: one active subcategory key, confidence 0 to 1, a reason up to 500 characters. Zod checks it in the adapter and the use case.
- **Applying** (`classification-policy.ts`, deterministic). In order: hold a change away from a locked Existing customer; hold a move to a lower stage rank (`do_not_contact` exempt); hold `customer` when `customer_requires_review`, a `review_required` subcategory, or `other` when `review_other`; hold below `auto_apply_confidence` (default 0.85, `pipeline_settings`); else auto-apply. The write locks the record and compares `context_version` and `latest_inbound_message_id`; a mismatch stores a `stale` classification and changes nothing.
- **Stop requests.** A reply that asks to stop, or a `do_not_contact` classification, shows a banner with one button that suppresses the address. Nothing suppresses on its own.
- **Unknown senders.** At most 50 AI replies a day for unknown senders (`channel_settings.general`, 0 blocks all). Over-cap jobs end `skipped` with reason `daily_cap`; an admin can requeue them.
- **Failure kinds** (`payload.failureKind`): `transient` and `lease` failures are requeued by the sweep with backoff from 15 minutes (capped at 6 hours, ceiling 5); `shape` and `permanent` wait for an admin (`POST /api/jobs/ai/requeue`, `/api/jobs/ai/[id]/requeue`).
- **Corrections.** A stage move or a person's classification takes `expectedContextVersion` (409 on mismatch), bumps the version, retires open drafts, ends runs and queues a fresh draft (`restartRecordWorkTx`). Undo reverts only the latest classification while the record still carries it.

### Drafts and approval

- **Approval rule.** `approveAndSendDraft` is the only email reply sender, and LinkedIn replies go through `sendLinkedInReply`. No AI job holds a mailer, and no setting sends without a person. Any member may edit, regenerate, discard, approve and send.
- **Knowledge.** Documents are pasted text with versions and tags (`/settings/knowledge`, any member). `selectKnowledge` takes always-included documents first (3,000 characters each, 5,000 together while others compete), then documents by shared step tags, within 8,000 characters. Citations go to `draft_knowledge_citations`.
- A new draft turns other open drafts of the record and channel `stale`. Regenerate writes a new row and discards the old one. `drafts.revision` counts edits.
- **Manual replies.** `POST /api/inbox/[id]/draft` with `{ subject, bodyText, cc? }` writes a draft (`provider = "manual"`) that still goes through `approveAndSendDraft`. Subject 1 to 998, body 1 to 100,000 characters; AI bodies cap at 20,000. No AI key needed.
- **Send.** The use case checks status `awaiting_review`, the revision the person saw and `context_version`. It writes the `send_attempts` row (unique idempotency key, snapshot of subject, text, recipient, CC and headers) before the provider call, then re-checks suppression, do not contact, CCs and mailbox state. The recipient comes from the person, never from the request. Mail reuses the outreach path: own Message-ID, `In-Reply-To`, `References`, Gmail thread id, signature, `List-Unsubscribe`.
- **Outcomes.** Definite refusal: attempt `failed`, draft back to `awaiting_review`. Unknown: attempt and draft `delivery_uncertain`, never resent. `conversations.reply-reconcile` settles a found message as `reconciled` after 10 minutes; a `sending` attempt with no outcome after 30 minutes turns uncertain. A person resolves uncertainty with "Confirm delivered" or "Not delivered" and a required note. After a send the record moves to `waiting`.

### LinkedIn replies

- A typed reply is a `drafts` row (`channel = 'linkedin'`, null subject) plus a `send_attempts` row (`provider = 'linkedin'`). Pressing Send is the approval. `POST /api/inbox/[id]/linkedin-reply` takes optional `draftId` and `revision` to send an AI draft with the person's edits.
- The claim locks the conversation, then the account, refuses while a reply of the chat is `sending` or `delivery_uncertain`, and applies `replyBlock`: account connected, not paused, under the daily message cap, outside the reply gap. A refusal answers 409 with `code` (`not_connected`, `paused`, `daily_cap`, `too_fast`) and writes nothing. Working hours do not apply.
- AI drafts for LinkedIn have no subject and at most 8,000 characters (`MAX_LINKEDIN_REPLY`). The email approve route refuses a LinkedIn draft.
- `conversations.linkedin-reply-reconcile` searches the chat by text after 10 minutes; missing after 30 minutes turns uncertain. It never sends.

### CC

- Ingest upserts `lead_ccs` for the record's person from Cc and Resent-Cc, excluding the lead, our mailboxes, the sender and anything past 50. Auto-replies add nothing.
- A reply can CC only addresses already in `lead_ccs` for that person, at most 20, none suppressed or belonging to a do-not-contact person (422 or 409). `drafts.cc` holds the list; a CC change bumps the revision. `checkBlockers` re-checks every CC after the ledger row exists (`cc_blocked`). No BCC, no free-typed addresses.

### Send status tables

Store queries compare and set on the previous status; migration 0008's triggers reject any change out of a final status (SQLSTATE 23514). The one exception is the engines' re-claim `failed -> sending` with the attempt raised by one while below 3.

`sends` (campaign and test; `sent` and `failed` are final):

| From | To | Writer |
|---|---|---|
| (insert) | `sending` | claim |
| `sending` | `sent`, `failed`, `unknown` | the worker that made the call (`fromCall`) |
| `sending`, `unknown` | `sent`, `failed` | reconcile |
| `unknown` | `sent`, `failed` | a person's answer, under the row lock |

`send_attempts` (email and LinkedIn replies; `sent`, `reconciled`, `failed` are final):

| From | To | Writer |
|---|---|---|
| (insert) | `sending` | claim, unique idempotency key |
| `sending` | `sent`, `failed`, `delivery_uncertain` | the worker that made the call |
| `sending`, `delivery_uncertain` | `reconciled` | reconcile or a person's "delivered" (note required) |
| `delivery_uncertain` | `failed` | a person's "not delivered" with a note |

A draft changes status only in the transaction where its attempt moved, filtered on the draft's expected status.

### Visibility

Every member sees every public conversation of the organization. Private conversations of personal campaigns stay out of the Inbox, Actions, unread counts, search and the Scheduled view, and records whose conversations are all private stay out of every reply-handling reader. Every store call filters by organization; a foreign id answers 404.

### Inbox views

- Inbox lists conversations. Views: All, Unread, Important, Sent, Replied, Out of office, Automated and Scheduled. `/inbox?view=action` redirects to `/actions`.
- **Automated** means the latest inbound message carries `raw.autoReply` or `raw.possibleBounce`, or its sender or subject matches the patterns in `domain/inbox-filter.ts` (one source for JavaScript and Postgres `~*`). All hides these threads and says how many; search still finds them.
- **Scheduled** is read-only: the next step of active enrollments in active campaigns and scheduled follow-up steps of active runs, by send time. Paused campaigns drop out.
- Filters are URL params (`lead`, `campaign`, `mailbox`, `subcategory`, `category`, `range`, `from`, `to`, `q`, `view`, `page`). Date filters read whole days in the organization's zone. Search covers the person's name and email and the subject and body of every message in the thread, with LIKE wildcards escaped.
- `GET /api/inbox/unread-count` returns `{ total, linkedin, email }` of inbound messages without `opened_at`, auto-replies excluded. Opening a thread marks it read through an explicit POST.

### Actions work queue

`/actions` is the queue of work that waits for a person. Read model: `conversations/actions/infrastructure/work-queue-read.ts`; writes in `drizzle-crm-store.ts`.

- **Membership.** A record is in the queue when it is `action_required` or `error`, or `waiting` with `next_action_at` due. A `next_step` record with an open task leaves the queue, because the task covers it. A record counts once.
- **Groups.** The first match decides: problem (record `error`, a `failed` or `delivery_uncertain` draft, or a failed AI job for the newest inbound message), reply (an `awaiting_review` draft), classification (held or unseen AI change), follow-up (`waiting` and due), next step. The page shows them in the order problem, reply, follow-up, classification, next step.
- **Assignment.** `records.assigned_to` names the member who handles the replies, with `assigned_source` of `auto`, `human` or `cleared`. The screen word is Assigned to; Owner stays the deal field (`deals.owner_user_id`).
  - Auto-assign: the first inbound message of an unassigned record goes to the creator of the person's newest non-removed regular-campaign enrollment whose creator is still a member. It never replaces a person's choice; choosing Nobody sets `cleared` and auto-assign skips the record.
  - Claim: any member can take an unassigned visible record. Assign: any member can give a visible record to a member or to nobody, with `expectedAssignedTo`; a mismatch answers 409. Neither changes `context_version` or retires a draft.
  - `records_assigned_to_fk` points at `members` with `ON DELETE SET NULL (assigned_to)`, so a member who leaves leaves their records unassigned.
  - Route: `/api/crm/records/[id]/assignee`. Every change writes an `assignee.changed` event.
- **Scopes.** Mine, Unassigned and Others split the queue by assignee and add up to the total. The page opens on Mine for every role, and the sidebar Actions number is Mine only. Unconfirmed campaign sends, unmatched senders and dead inbound events (owners and admins only) are shared work outside the scopes.
- **Waiting since.** Problem items wait since the failure was recorded. Follow-ups wait since `next_action_at` and read as overdue; they stay out of the oldest-wait sentence. Every other group waits since the last inbound message.
- **Ordering.** Inside a group the item that has waited longest comes first, keyed on (waiting time, record id). Paging is keyset per group, 50 by default and 200 at most. Counts for all scopes come from one pass.
- **Working the queue.** A thread opened from Actions offers Back to Actions and Next in queue (`getNextQueueItem`, same order as the list). Classifications settle in the row with the same server rules as the thread; one button accepts applied changes the AI was at least 0.9 sure of.
- The row snippet comes from a public conversation through `publicConversationSql`. Date filters use the organization's zone.

## Deals and CRM

### Leads and CRM

MiaSDR is an outbound tool first. A person starts as a lead in Leads, Campaigns and the Inbox. The CRM group in the sidebar holds Pipeline (deals), Contacts and Companies. The UI never says "record"; code and tables keep `records`.

#### Lifecycle model

- One `people` row per human. `people.lifecycle` (`lead` or `contact`) decides which screens list the person. Conversion copies nothing. A human who writes from a second address is a second row; MiaSDR has no person merge.
- `people.converted_at` is set for a contact and null for a lead (CHECK `people_converted_at_ck`). The trigger `people_lifecycle_trg` rejects contact to lead and any change of `converted_at` once set. Conversion goes one way: deleting the last deal leaves the person a contact.
- `leadFilterCondition` applies `lifecycle ?? 'lead'`, so every lead list, export, id selection, delete-matching and neighbor query returns leads unless the filter says `contact` or `all`. The Contacts list uses the partial index `people_org_contacts_idx`.
- Unknown inbound senders arrive as `lifecycle = 'lead'`.
- A contact's replies still land in the Inbox and Actions and may queue an approval-gated reply draft. No After a reply run starts for a contact: the sequence store and engine filter `p.lifecycle <> 'contact'`, and `createRunOn` re-checks after the record lock.
- The reply category `customer` ("Existing customer") and a Won deal stay independent. Deal stages carry no stop rule; terminal subcategories, the do-not-contact subcategory and the customer lock belong to reply categories only.
- A do-not-contact or suppressed person can still get a deal. The screens show the flags.

| Invariant | Enforced by |
|---|---|
| `lifecycle` is `lead` or `contact` | `people_lifecycle_ck` |
| A contact never returns to lead | `people_lifecycle_trg` |
| A contact has no pending or active enrollment | conversion stops them; `notContactSql` in every candidate select and restore; the triggers `campaign_enrollments_contact_ins_trg` and `campaign_enrollments_contact_upd_trg` |
| A deal's person is a contact and never changes | `deals_contact_trg`, `deals_person_trg` |
| `closed_at` and `lost_reason` match the stage kind | `deals_closed_at_ck`, `deals_lost_reason_ck` through `deals.stage_kind` |
| A stage's kind never changes | `deal_stages_kind_trg` |
| A stage with deals cannot be deleted | `deals_stage_fk` RESTRICT |
| An amount has a currency | `deals_currency_pair_ck` |

#### Contact guard on enrollment

- The two enrollment triggers stay narrow. The INSERT trigger fires for `pending` or `active`, the UPDATE trigger only on a move from a non-live to a live status. Both read `people.lifecycle` `FOR SHARE` and raise `check_violation` with the message `contact_cannot_be_enrolled`. A trigger on every status write deadlocked with `markSent` and the LinkedIn webhook loop, so `pending` to `active` and every move to a final status never read `people`.
- `notContactSql` (`outreach/infrastructure/contact-guard.ts`) filters enroll-by-search, LinkedIn enroll-by-query, picked leads, the search sink and the grid handoff. Each INSERT runs a chunk in a savepoint; on `contact_cannot_be_enrolled` the chunk rolls back, re-selects with `notContactSql` and counts the dropped people as `skippedContact`.
- Skip precedence: missing identity, duplicate, suppressed, do not contact, contact. Restore refuses a contact. The grid handoff reports "Is a contact".
- A send claimed before a conversion commits can still reach the provider, because the claim commits first and `checkBlockers` reads the enrollment without a lock. The `sends` row keeps the provider's outcome.

#### Context boundaries

- `src/contexts/deals` owns `deals` and `deal_stages`. Its one cross-context write port is `ConvertLead`. `deals/infrastructure/crm-read.ts` is the read model of the CRM screens: read-only SQL over `people`, `companies`, `deals`, `deal_stages` and `events`, with a test that pins the columns it reads.
- Leads owns `people` and `companies`: `markConverted`, `convertToContact`, `previewConvert`, `makeContact`, `addContact`, the company use cases, `personSummaries` and `searchPeople` (`leads/infrastructure/people-directory.ts`).
- Outreach owns `stopPersonEnrollmentsTx`, `liveEnrollmentSummary`, `latestRepliedEnrollment`, `enrollmentSources` (`drizzle-conversion-outreach.ts`), `notContactSql` and the delete side in `person-outreach.ts`.
- Conversations owns `lockPersonRecords`, `lockPersonRecordRows`, `interruptPersonRuns`, `previewPersonRunStop`, `appendPersonEvent`, `activeConversationOfPerson`, `activeConversationOfRecord` and `listPersonEvents` (`person-handling.ts`), plus `purgePersonHandling` (`person-purge.ts`). `events` is declared in conversations; every person event goes through `appendPersonEvent`.
- Leads imports only identity and tenancy. The wiring that needs deals or outreach lives in `src/composition/person-lifecycle.ts`, which routes import and no context does.
- `deals/infrastructure/deals-composition.ts` is the composition root of the conversion and the deal use cases.
- `/api/crm/*` and `conversations/**/crm*.ts` mean reply handling. The CRM screen group means deals.

#### Conversion and lock order

`convertToContact(deps, tx, { reason, guard? })` (leads) is the one transition. `createDealFromLead` runs it through `ConvertLead` and inserts the deal in the same transaction, so both commit or neither does. `makeContact` runs it with `reason: "added"` and no deal. In order:

1. Lock the person: the person's `records` rows `FOR UPDATE` in id order, then the person advisory lock (`lockPersonOutreachTx`). `lockPersonForConversion` in `src/platform/db/person-locks.ts` does this for code outside conversations.
2. Re-read `people.lifecycle`. A contact returns `changed: false` and nothing else happens.
3. Run the caller's `guard(tx)`. Deals passes the personal-campaign rule here, so an enrollment that committed before the locks still counts.
4. `markConverted` sets `lifecycle` and `converted_at`.
5. `stopPersonEnrollmentsTx` sets `pending` and `active` enrollments to `cancelled` with `stop_reason = 'converted'` and clears the LinkedIn resolve retry time. Other statuses stay.
6. `interruptPersonRuns`, reason `converted`, ends active and paused runs and retires every unsent draft of an open run step. In hand-off mode no run exists and the Inbox reply draft survives.
7. `appendPersonEvent` writes `lifecycle.converted` with the counts in `meta`.

Lock order per person: records, the person advisory lock, the `people` row, enrollments, runs. Single-person reply ingest takes records first as well. Four writers take another order: do not contact (`dnc:{personId}`, then its `contact_policies` row, then records), `suppressEmail` (enrollments before records), multi-person ingest (the sender's advisory lock before that person's records) and `advanceRunTx` (run before record). A person transaction therefore runs with `lock_timeout` `CONVERSION_LOCK_TIMEOUT` (5 s) and drops to `HELD_LOCK_TIMEOUT` (300 ms) once it holds the person's records or advisory lock. Postgres breaks a lock cycle in the waiter whose `deadlock_timeout` (1 s by default) runs out first; the shorter wait makes the conversion give way, roll back and retry, while the writer that cannot retry commits. `retryOnce` runs the transaction once more on SQLSTATE 40P01 or 55P03 and answers 409 `try_again` on a second failure.

The enrollments a conversion cancels show the stop label "Became a contact" (`stopReasonNote` and `stopReasonDetail` in `outreach/domain/campaign-view.ts`).

#### Deals and stages

- A deal has five fields a person fills in: title (1 to 200), stage, owner (`owner_user_id`, SET NULL on user delete), amount (`amount_minor`, bigint 0 to 2^53 - 1, with an ISO 4217 `currency` from `CURRENCY_EXPONENTS`) and `expected_close_on`. System fields: `closed_at`, `lost_reason` (at most 500), `stage_changed_at`, `source_enrollment_id`, `idempotency_key`, `version`, `created_by`. A deal has no `company_id`; its company is the person's company.
- `source_enrollment_id` is the person's replied enrollment at conversion time (latest by `updated_at desc, id desc`), with `ON DELETE SET NULL (source_enrollment_id)`. The UI shows "From {campaign}" for a regular campaign only.
- One pipeline per organization: `deal_stages` with `kind` `open`, `won` or `lost` and a `position` unique per organization, `DEFERRABLE INITIALLY DEFERRED` so a reorder can swap two rows. The defaults are New, Meeting, Proposal, Won and Lost.
- `ensureStages(tx, org)` (`drizzle-deal-store.ts`) lists the stages without a lock and takes the organization advisory lock only when none exist. `GET /api/deal-stages` never writes: it returns the defaults flagged `virtual: true`, and `POST /api/deal-stages/defaults` creates them.
- Stage settings answer 409 `name_taken` (names are unique ignoring case), 409 `stage_in_use` with the deal count, and 409 `last_of_kind`: one open, one won and one lost stage always exist, open before won before lost. Each change writes an audit row (`deal_stage.created`, `renamed`, `reordered`, `deleted`, `defaults_created`).
- Any member can use every CRM screen and setting. The one limit: a person with a live enrollment in another member's personal campaign converts only by that campaign's creator or an owner or admin (`/convert` answers 403 `personal_campaign`, Make contact 409 `personal_campaign`).

| Use case | Rules |
|---|---|
| `createDealFromLead` | Replays a stored `(organization_id, person_id, idempotency_key)` with 200. 409 `already_converted` for a contact. |
| `createDealsFromLeads` | Up to 200 ids per request (`MAX_BULK_CONVERT_IDS`) and a 20 s budget (`BULK_TIME_BUDGET_MS`); one transaction per person. Skip reasons: `already_converted`, `not_found`, `personal_campaign`, `failed`, `retryable`. The dialog sends the `retryable` ids once more. A Lost stage answers 422, since each lost deal needs its own reason. |
| `createDealForContact` | Needs an idempotency key; 422 for a lead. |
| `moveDealStage` | Needs the current `version`; 409 `stale_version`. A lost stage needs a reason (422). |
| `deleteDeal` | Open stages only (409 `deal_closed`). `DELETE /api/deals/[id]?expectedVersion=` checks the version when given. |

Events: `deal.created`, `deal.stage_moved`, `deal.updated` and `deal.deleted`, each with `person_id` set and the deal id in `meta`. Activity reads `deal.stage_moved` as "Moved deal to {stage}", `stage.moved` as "Changed category" and `lifecycle.converted` as "Became a contact".

#### Pipeline board and lists

- The board shows one column per stage in position order, newest stage move first, 25 cards per column (`BOARD_LIMIT`, at most 100) with a cursor for "N more". Won and Lost columns hold deals closed in the last 30 days unless Show all is on. Column totals per currency travel as decimal strings, because a sum can pass 2^53 - 1.
- `primaryDeal` (`deals/domain/primary-deal.ts`: open first, then newest by creation, then the higher id) names a contact's open deal and the Latest deal column; `crm-read`'s `latestDealJoin` orders the same way and a test compares the two.
- Contacts lists Email, Latest deal, Deal owner and Reach, 25 per page, with `owner` (a member id, `me` or `none`) and `stage` filters. Malformed values answer 422; unknown ids list nothing. Contacts has bulk select, Export CSV (`/api/contacts/export`, dates in the organization zone) and bulk Mark do not contact.
- A contact carries no lead status. Contact since and the source campaign are Details facts; the deal stage shows in the Deals section.
- `previewConvert` (up to 500 ids; the bulk dialog sums chunks) feeds the effects text in `crm/_components/deal-effects.ts`, for example "Stops 2 campaign enrollments. Ends 1 follow-up in progress." Lines with a zero count drop. Each conversion dialog states "{Name} cannot go back to Leads or join a campaign again", and a bulk conversion above 50 leads (`SECOND_CONFIRM_ABOVE`) asks a second time.

#### URL map

Every redirect answers 307. Static rules live in `next.config.ts`; the rest are route handlers.

| Old | New |
|---|---|
| `/crm` | `/crm/pipeline` |
| `/crm/records` | `/leads?hasConversation=yes&lifecycle=all`, carrying only `q` (`src/app/(legacy)/crm/records/route.ts`) |
| `/crm/records/[id]` | `/inbox/[conversationId]` of the active public channel through `activeConversationOfRecord`, else `/crm/pipeline` |
| `/crm/actions` | `/actions` |
| `/crm/identity-exceptions` | `/inbox/unmatched` |
| `/crm/settings`, `/settings/crm` | `/settings/replies` |
| `/leads?tab=companies` | `/crm/companies` |
| `/leads/[id]` for a contact | `/crm/contacts/[id]` (in-page `redirect()`) |

### Contacts and Companies CRUD

#### Vocabulary

| Product word | Meaning and code name | Where it shows |
|---|---|---|
| Other domains | Further domains of one company: `company_domain_aliases`. The UI never says "alias". | The company Details row, the merge preview, the delete company text. |
| Listed in Companies | `companies.crm_listed_at IS NOT NULL`, or a contact has the company's `company_id`. | Add company, the company page empty state, the merge picker's "Leads only" mark. |
| Make contact | `makeContact`, an event `lifecycle.converted` with `meta.reason = "added"`. | The lead page button and Add contact's matching-lead step. |
| Email suppressed | A `suppression_list` row for the address (the Reachability word). | The delete dialog's line "{email} stays Email suppressed." |

PRODUCT.md Terminology carries Other domains, Listed in Companies and Make contact, and the line "A lead becomes a contact when you create a deal from it or make it a contact." `src/architecture/docs-vocabulary.test.ts` pins them.

#### Add contact, Make contact, Add company

- Add contact (`leads/application/add-contact.ts`) inserts `lifecycle = 'contact'` with `converted_at = now()` and writes `contact.added`. The order: field plan, replay by creation key (8 to 200 characters), identity match, company, insert, event.
- The identity match tries email, then the LinkedIn slug, against `people_org_email_uq` and `people_org_linkedin_uq`. A match answers 409 `lead_exists` or `contact_exists` and writes nothing. The client offers to make the matching lead a contact, which keeps the lead's own details and drops the typed values.
- "Also create a deal" runs `addContactWithDeal` (deals) over the `CreateContact` port, so the contact and its deal commit together.
- Make contact (`POST /api/leads/[id]/make-contact`) converts without a deal. It answers 409 `already_converted` and 409 `personal_campaign`.
- The person form and Add contact never edit an existing company. The repository resolves the domain first (`resolveCompanyDomain`) and answers 422 "Rename {Company} on its company page." when the request names that company differently. The form shows an existing company as a link and asks for a name for a new domain only. The company page edits name, LinkedIn page and company fields (`updateCompany`, `PATCH /api/companies/[id]`); the domain stays read-only.
- Add company (`addCompany`) inserts a listed company for a new domain and lists a company that had leads only. A listed company's domain or another domain of a company answers 409 `company_exists` with `viaAlias`. Audit: `company.created`.

#### Domains

- A company has one domain and any number of other domains. A domain is a company domain or an alias in one organization, never both: `companies_org_domain_uq`, `company_domain_aliases_org_domain_uq` and the guard triggers `companies_domain_not_alias_trg` and `company_aliases_not_domain_trg` back the rule.
- Every writer of one domain takes the advisory lock `leads-company-domain:{org}:{domain}` and resolves aliases first. The import holds `leads-import:{org}` instead, and merge and company delete take that lock first, so an import never sees half a merge. The import maps aliases before `plan()`.
- Every company write bumps `companies.version`. The merge and the company delete compare it with what the dialog showed.
- `crm_listed_at` is stamped by Add company, by a merge (on the kept company) and by any use case that removes a company's last contact. No trigger writes it and nothing clears it, so a listed company stays listed until someone deletes or merges it.

#### Company merge and delete

You pick the company to keep. `mergeCompanies` runs one transaction in this order:

1. Replay check, so a repeated merge answers its first result.
2. `leads-import:{org}`, then the held-lock timeout.
3. The domain locks of both companies and the other company's existing aliases.
4. The company field registry lock.
5. The other company's people, then both company rows `FOR UPDATE`.
6. Compare versions and people counts with the preview; a difference answers 409 `company_changed`.
7. Move the people, write the merged values, move the other's aliases, delete the other row, then add its domain as an alias of the kept company (the guard trigger refuses an alias that is still a company domain).
8. Write `company.merged` with the moved people, dropped field values and dropped raw keys.

Value rule (`leads/domain/company-merge.ts`): the kept company's non-empty values stay, and the other's value fills an empty field. Name, LinkedIn page and every company field key follow that rule, archived fields included. Raw data merges with `mergeRaw(other.raw, kept.raw)`. `crm_listed_at` becomes the earlier stamp of the two, or now. A merge touches no `deals` row, because deals follow their contacts.

`deleteCompany` deletes a company no person points at, with its other domains. A company with a lead or a contact answers 409 `company_in_use { contacts, leads }`; the use case is the guard, because `people_company_fk` is SET NULL. A stale `expectedVersion` answers 409 `company_changed`. Audit: `company.deleted`.

#### Contact delete

A contact without an open deal can be deleted (`deleteContact`, `DELETE /api/contacts/[id]`; preview `GET /api/contacts/[id]/delete-preview`). Any member can delete. The transaction sets a 30 s statement timeout and runs in this order:

1. `lockPersonForDelete`: the person's records `FOR UPDATE` in id order, their conversations `FOR UPDATE` in id order (a message insert needs `FOR KEY SHARE` on its conversation, so no reply lands mid-purge), then the person advisory lock. After the first lock the wait drops to 300 ms.
2. The `people` row `FOR UPDATE`. A gone person answers 404, a lead 409 `not_a_contact`.
3. The `contact_policies` row `FOR UPDATE`.
4. Every deal of the person `FOR UPDATE`.
5. Blockers answer 409 `contact_blocked { blockers }`: `open_deals` (named and linked in the dialog), `send_in_flight`, `recent_send` (a campaign send under 24 hours old, which today's mailbox limit counts), `recent_invite` (a LinkedIn invitation under 7 days old, which the weekly cap counts), `ai_job_running`, and `private_conversation` or `personal_campaign_sends` when another member's personal campaign holds the person and the actor is not its creator, an owner or an admin.
6. The counts must equal the counts the dialog showed, else 409 `counts_changed { counts }`.
7. `keepEmailSuppressed`: a person marked do not contact gets a `manual` suppression row, so the address stays Email suppressed.
8. `purgePersonHandling` deletes reply handling, conversations, messages and history events. It turns `miasdr.allow_purge` on and off around its own deletes; `allow-purge-scope.test.ts` fails when another file sets the switch.
9. Closed deals, then the person's enrollments and sends (campaign reports drop those sends).
10. The `people` row; notes, tasks and `lead_ccs` go with it.
11. Stamp `crm_listed_at` on the person's company when no contact is left.
12. Audit `person.deleted` with the counts and `suppressionKept`.

`retryOnce` covers 40P01 and 55P03. A statement timeout (57014) answers 409 `try_again` without a retry, since a second run meets the same size. `deals_person_fk` stays RESTRICT as the last guard.

These copies stay after a delete: `audit_log` rows keep the person id; the suppression row keeps the email; messages the person sent into another person's conversation stay there; `inbound_events` payloads keep the raw provider message; other people's `lead_ccs` rows keep the address; `identity_exceptions.identity_value` keeps the address or profile (a `resolved` row may have a null `resolved_person_id` and reads "Resolved to a deleted contact"); `linkedin_connections` keep provider ids; grid rows keep what a table holds. A re-import, a table handoff or a new message brings the person back as a new lead with no history.

#### Copy rules

- `{Name}` is the full name, else the email, else "this contact".
- Each irreversible step names its permanence. A merge, a contact delete and a company delete end in "This cannot be undone."
- A code the client branches on travels as a 409 `ConflictError` with `details.code`. A 422 carries a message the client shows.
- Toasts read "Added {Name}.", "Deleted {Name}.", "{Name} is a contact now." and "Merged {other} into {kept}."
- New strings pass `copy-vocabulary.test.ts`, which reads every user-facing string in the UI, the domain layers and the error messages. It rejects "record" and "CRM rules" in user-facing strings and error messages.

## Tables

Code: `src/contexts/grid` (README in `grid/README.md`), pages under `src/app/(app)/tables`, routes under `/api/grid`. Nothing in Tables sends email or LinkedIn messages.

### Limits

`GRID_LIMITS` (`application/limits.ts`) is the one list routes and use cases share.

| Limit | Value |
|---|---|
| JSON body / cell edit body / upload | 256 KB / 5 MB / 5 MB |
| Rows and columns per import | 10,000 and 200; a larger file is refused whole |
| Rows and columns per table, tables per workbook | 50,000 and 200, 100 |
| Cell edits per request | 5,000 cells over at most 1,000 rows |
| Selection and export rows | 50,000 |
| Rows per campaign handoff | 5,000, with at most 20 extra columns as custom lead fields |

### Formulas

- Formulas are a small expression language with a hand-written parser and evaluator (`domain/formula-parser.ts`, `domain/formula.ts`). Cells read as `{{columnKey}}`. Names resolve through a fixed function map; there is no property access, no eval and no route to a global. `FORMULA_LIMITS` caps length (5,000), tokens, nesting, tree height, nodes, evaluation steps (60,000 per row), text length and list size before the work happens.
- Functions include IF, AND, OR, IFERROR, ISERROR, IFS, SWITCH, COALESCE, text functions, ROUND, ROUNDUP, ROUNDDOWN, SUM, AVERAGE, INDEX, JSON_VALUE, LOOKUP, TODAY, NOW, DATE, YEAR, MONTH, DAY, DATEDIF and TEXT with a format.
- Dates are ISO 8601 text. A datetime without offset is wall time in the organization zone (`organizations.timezone`, overridden by a valid `channel_settings.general.timeZone`). `DATE` refuses dates that do not exist. The engine never reads the system clock: the caller passes `now`, and `TODAY` without it is an error. A formula that calls TODAY or NOW is volatile and joins any run triggered by a row edit or an import.
- Column keys come from `domain/keys.ts` (`\p{L}\p{N}\p{M}_`, NFC-normalized, at most 60 code points), so Korean, Thai or Hindi headers keep their characters. Tokens normalize to NFC before they match a key.
- `LOOKUP` resolves table and column names at evaluation, not at save. A deleted or renamed source fails the next evaluation with `#REF`; a source over 50,000 rows gives `#LOOKUP`. A value missing from a source that resolved returns the default.
- Errors are `ERROR`, `REF` and `LOOKUP`, shown as `#ERROR`, `#REF` and `#LOOKUP`, with `cell_meta[key] = { status: "error", code, error }`. ISERROR and IFERROR catch data errors only; a step budget, length limit or missing clock surfaces.
- Formula columns compute in the request (`application/formula-recalc.ts`) after a column save, a cell edit, an import or an enrichment result, never through `grid_jobs`. The worker's `afterWrite` only marks dependents stale.
- One trigger refreshes at most 10 dependent LOOKUP columns and 10,000 dependent rows, following chains to depth 3 (`LOOKUP_REFRESH_LIMITS`). A column past either bound, or with auto-run off, keeps its value and gets `{ status: "stale" }`.
- Recalculate (`POST .../columns/[columnId]/recalculate`, formula columns only) recomputes every row inside a 25 s budget (`RECALC_BUDGET_MS`). On a stop the unfinished cells get a stale marker and a second Recalculate continues.

### Enrichment providers and waterfalls

- Catalog entries are `available` (an adapter exists: `hunter`, `apollo`, `http`, `fake`) or `catalog_only`. A provider row's `config.adapter` picks the adapter. `fake` works only under `GRID_PROVIDER=fake`. Owners and admins manage providers; any member runs columns.
- Hunter and Apollo call fixed hosts with the key in a header. Apollo never asks to reveal personal emails or phone numbers.
- Credentials live in `grid_provider_credentials` as an encrypted envelope; views carry `hasCredential` only. A save verifies the key first and stores nothing on failure. Every request, response and error text passes `redactSecrets` before it reaches `grid_cell_runs` or `cell_meta`.
- SSRF guard (`domain/enrichment-url-policy.ts`, `infrastructure/enrichment-http.ts`): the generic `http` adapter needs its host on `GRID_HTTP_ALLOWED_HOSTS` (empty by default, so none can be created). The base URL must be https with no userinfo, query, fragment, IP literal, encoded slash or dot segment, and an entry without a port allows the default port only. The URL is parsed again before every call. The adapter resolves DNS once, refuses private, loopback, link-local, CGNAT, documentation, multicast and IPv4-embedding IPv6 addresses, and connects to that validated address, so a rebind cannot swap it. Redirects are refused, bodies stop at 1 MB, calls time out at 30 s (`GRID_CALL_TIMEOUT_MS`).
- A waterfall runs its steps in order and the first hit wins. A miss, a permanent error or an unavailable provider moves on; every attempt is one `grid_cell_runs` row. When nothing hit and a step failed transiently or was rate limited, the cell retries and remembers the steps that missed, so nobody pays for them twice. A rate-limit wait uses no attempt. `maxCostCents` on the column skips a step whose worst case would pass it.
- The per-provider rate limit counts the provider's `grid_cell_runs` rows in the last 60 s plus an in-process gate. A transient error's `retryAfterMs` becomes the retry delay.

### Runs, worker and kick

- One `grid_jobs` row per cell (`grid_jobs_cell_uq`) stays after the run, so retry finds failed cells. The claim is `FOR UPDATE SKIP LOCKED` on the outer select across organizations, with a 5 minute lease (`GRID_JOB_LEASE_MS`). Every finishing write is fenced by the lease token. New work is due a minute in the past because the claim compares `run_after` with the worker clock.
- Run limits: `maxRows` default 1,000, at most 10,000, refused rather than truncated; `firstN` counts rows after the skip rules and scans up to 100,000 rows; optional `maxCostCents` against worst-case provider cost.
- Auto-run cascade caps (`domain/enrichment-run-limits.ts`): each edit, paste or finished cell queues at most 100 rows per column and 500 cents of worst-case cost, and only under 2,000 pending cells per organization. A held-back cell keeps its value and gets `{ status: "skipped: cap" }`; `editCells` returns `skippedByCap`.
- An organization runs at most 8 cells at once (`ORG_MAX_RUNNING_CELLS`); the claim orders by position within each organization, so a second organization's single cell runs behind a large run, not after it.
- The worker keeps a slot pool of `GRID_RUN_CONCURRENCY` (default 8, 1 to 16) and refills a slot as a cell finishes, up to 2,000 cells per pass or the tick deadline. Running cells settle before the pass returns.
- `succeedOnce` wraps the save after a paid call. A failed save ends the cell in a terminal `failed` job ("The provider answered and was paid, but the result could not be saved") with the ledger rows recorded, and never retries on its own.
- `kickJob` (`src/platform/jobs/kick.ts`) runs `grid.run` 25 ms after a request queued cells, outside the request, one pass at a time per process, repeating while a pass reports `more`. Without an embedded scheduler the kick does nothing and the tick serves the work.
- Cancel deletes queued jobs and writes a `cancelled` ledger row each; a running call finishes. Retry re-queues `failed` jobs only.

### AI columns and output sanitizing

- AI columns use the organization's Anthropic key through `AiProvider.answer()` with structured output. Each cell value sits in a nonce-fenced block and the column instruction is fenced as operator guidance.
- Output types: text, number, boolean, email, url, date and json. The model answers text, and `ai-output-coerce.ts` checks each answer before the write. A rejected answer becomes that cell's error and keeps its earlier value; the job succeeds, so the paid call never repeats.
- `domain/output-sanitize.ts` cleans every provider and AI write and every ledger row: it removes `\u0000`, lone surrogates and control characters other than tab and newline, turns CRLF into a newline, caps strings at 20,000 characters, keys at 200, arrays and objects at 1,000 entries and depth at 12, and nulls numbers JSON cannot hold.
- Runner columns are not created from raw JSON. `createColumn` accepts static types and `formula`; any other type needs `registerColumnTypeHook`.

### Views and pins

- `grid_tables.view` is the default every member starts from. A member's `hiddenColumns`, `pinnedColumns`, `sorts` and `filters` live in `grid_user_views` and replace the default per key, an empty value included. A key the member never stored follows the default.
- `PUT .../view` takes the whole effective view and stores only the keys that differ (`personalOverride`). Only an owner or admin can PATCH the default (403 otherwise); saving it deletes the admin's own row.
- At most 3 pins (`MAX_PINNED_COLUMNS`). Phone width ignores pins. Both layers are sanitized against the current columns on read.
- A muted filter condition stays saved and filters nothing; the client and the SQL share `isConditionActive`. A number filter value parses with the cell parser, and a stored filter that no longer parses reads as inactive.

### Edit pipeline and conflicts

- `grid_rows.version` comes from `grid_row_version_seq` and changes on every write. A cell edit may carry `expectedVersion`; a stale one throws `RowConflictError` (409 with the current rows) and the batch writes nothing. Edits without it win.
- Undo is a server compare-and-set: the cells PATCH takes a per-cell `expected` value checked under the row lock and answers `{ applied, skipped }`. `undo: true` starts no paid auto-run and marks the runner columns that read the restored cells stale. The client stack holds 100 actions and 50,000 cells.
- Paste (`POST .../paste`) is one transaction: it locks the table, adds up to 1,000 rows and 100 columns, writes up to 5,000 cells and notifies dependents. Rows and columns grow only while the view shows the whole table in table order.
- Copy, cut and CSV export prefix text that starts with `=`, `+`, `-`, `@`, tab or CR with an apostrophe, and paste and import remove it, so a round trip is lossless.
- The changes feed cursor is `version:watermark:after:next`. Each round re-reads rows written by any transaction that was still running when the last round began (row `xmin` against `pg_snapshot_xmin`), so a late commit is never missed. Row deletes are invisible to the cursor, so `changes` returns the row `total` and a client reloads when it drops.
- Lock order: workbooks in id order, then the table, then rows, then columns.

### Import, export and hand-off

- XLSX uploads use the leads importer's hardened parser with a 1-based `sheet`; an empty sheet raises `SheetContentError` so the picker stays. A fresh table's starter column takes the key of the first imported header.
- Export follows the member's merged view with `useView`; `rowIds` wins. The 50,000-row limit counts filtered rows.
- Push to campaign (`pushToCampaign`, `infrastructure/campaign-handoff.ts`) runs in one transaction: it filters rows by a valid address for the campaign's channel and by suppression, imports them through `importLeads`, matches people back by email and slug, then drops do-not-contact people, contacts ("Is a contact"), people already enrolled and duplicates before `enrollEmailPeople` or `enrollPeople`. A new campaign is an email draft. Nothing sends: the campaign keeps its state. A push to a new campaign where every row drops rolls back the imported leads too.

## Jobs and data retention

### Tick and registry

- One entry point, `runTick` (`src/platform/jobs/tick.ts`), runs every registered job once inside a 50 s budget. A job past the deadline reports `more: true`; a throwing job is reported and the others still run.
- `registeredJobs()` (`src/composition/job-registry.ts`) is the composition point: email, LinkedIn, conversations (AI and reply reconcile), sequences, grid, then the maintenance jobs `platform.daily-rollover` and `platform.history-prune`.
- Self-hosting runs `startEmbeddedScheduler` every 60 s with `EMBEDDED_SCHEDULER` on (default). Ticks never overlap in one process. External schedulers call `GET` or `POST /api/jobs/tick` with `Authorization: Bearer $CRON_SECRET`, compared in constant time; Vercel Cron sends GET.
- Every job claims its own work (`SKIP LOCKED`, a lease or a slot), so overlapping callers across processes are safe.

### Slot claims and leases

- `claimSlot(job, slotKey, { organizationId, leaseMs })` (`slots.ts`) inserts `(job, slot, organization)` into `job_runs` with a lease (default 5 minutes). On conflict it takes the row over only when the row is not `succeeded` and its lease has expired.
- `finishSlot` with `retryAfterMs` (default 5 minutes, 0 means the next tick) reopens a failed slot later. `finishSlot` and `extendSlot` are fenced by `started_at`, so a displaced owner changes nothing.
- Slot users: `history-prune` (one per UTC day), the rollover steps, `linkedin-sync` (one per organization and hour) and manual LinkedIn job runs.

### Daily rollover

- `platform.daily-rollover` claims `daily-rollover:<org>:<step>:<yyyy-mm-dd>` per organization and step, where the day is the local date in `channel_settings.general.timeZone` (UTC when unset). A DST day of 23 or 25 hours stays one day. A step that fails or runs out of budget retries alone after 5 minutes. One query reads the finished claims, so a finished organization costs nothing more.
- Steps register in `rollover-registry.ts` and must be idempotent. The one step, `backfill-linkedin-urls`, fills `people.linkedin_url` from the slug where it is missing.
- No step resets a counter: the email daily limit counts today's `sends` rows, LinkedIn invitation caps are `sends` windows, `limit_reached_until` is a timestamp, and `search_leads_today` restarts on its own through `search_day` (UTC). A reset in the organization's zone would restart it mid UTC day and double the budget.

### History pruning and retention

`platform.history-prune` claims one slot per UTC day and deletes in batches of 1,000 with `FOR UPDATE SKIP LOCKED`, at most 20 batches per table per tick. A run cut short marks its slot failed with no delay and continues on the next tick. The tick detail lists rows deleted per table.

| Deleted | After | Env |
|---|---|---|
| `job_runs` started earlier, except a live `running` row | 30 days | `RETENTION_JOB_RUNS_DAYS` |
| `inbound_events` with status `done` or `skipped` | 30 days | `RETENTION_INBOUND_EVENTS_DAYS` |
| `inbound_events` with status `failed` (dead letters) | 90 days | `RETENTION_INBOUND_FAILED_DAYS` |
| `ai_jobs` with status `succeeded` | 30 days | `RETENTION_AI_JOBS_DAYS` |
| `sessions` and `verifications` past expiry | 1 day | none |

Each variable takes whole days of at least 1. Better Auth deletes an expired row only when it reads it, so abandoned rows pile up without the prune. The prune never touches sends, messages, enrollments, suppression, people, pending or processing events, failed or queued AI jobs, or grid jobs and ledger rows. `events`, `audit_log` and `messages` are append-only by trigger.

### Failure log

- `tickObserver` (`observe.ts`) serves both the embedded scheduler and the cron route. It logs one `[jobs]` JSON line per failing job per tick: a thrown error, or a `detail` key containing `fail` or `error` with a count above zero. A repeat of the same failure logs once, then at most every 10 minutes with the skipped count. A tick of 30 s or more logs `tick.slow`; a job that runs clean again logs `job.recovered`.
- `recordTickFailure` (`failure-log.ts`) upserts one `job_runs` row per job and error signature (digits and ids removed), job name `tick:<job>`, no organization, with the count in the error text. A failed write logs a warning and never stops the scheduler.
- `/settings/jobs` (owner or admin) shows Background job failures, Recent runs (slot claims and manual runs) and AI jobs, including Skipped AI jobs.

### AI requeue

- `ai_jobs.payload.failureKind` is `transient` (provider or network), `lease` (the worker died on the last attempt), `shape` (wrong answer form on every attempt) or `permanent` (rejected key, refusal, empty taxonomy).
- The sweep at the start of `conversations.ai` requeues `transient` and `lease` failures, and failures without a kind, once `failed_at + 15 min * 2^autoRequeues` (capped at 6 hours) has passed and `autoRequeues` is below `payload.requeueCeiling` (default 5). It skips an organization with no AI key, and writes `ai_jobs.auto_requeued` per organization.
- Owners and admins requeue one job (`POST /api/jobs/ai/[id]/requeue`) or every failure since a time (`POST /api/jobs/ai/requeue`, 500 per call). A requeue moves only rows that are `failed` now, or `skipped` with `skipReason` `daily_cap`: status `queued`, attempts 0, due now, the automatic counter reset. A classification job also loses its `failed` classification row, which would otherwise hold the slot and make the retried result stale. A second click changes nothing; an unknown or foreign id answers 404. Each manual requeue writes `ai_jobs.requeued` with the actor.
