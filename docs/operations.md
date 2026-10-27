# Operations

## Replies, bounces and unsubscribes

The `email.inbox-sync` job polls each connected mailbox through Gmail's history API, at most once per minute per mailbox. It checks each new message in this order:

1. **Bounce.** A hard bounce adds the recipient to the suppression list (reason `bounced`) and ends that address's pending and active enrollments. A soft bounce is counted and changes nothing.
2. **Own message.** Mail the mailbox sent itself is skipped.
3. **Auto-reply** (out-of-office, `Auto-Submitted`, bulk or auto-reply headers). Counted, and the campaign's sequence continues.
4. **Reply.** A message from a lead in an active sequence sets the enrollment to `replied` and clears its next send. Follow-ups stop. The inbox job runs before the send job in each tick, so a reply stops follow-ups before they are claimed.
5. A message from an unknown sender is counted as `ignored_unknown_sender`.

Replies and unknown senders are stored in the Inbox (`/inbox`). A message whose sender cannot be tied to any person (an unusable address, or a LinkedIn sender with no profile and no known lead) is parked under Unmatched senders (`/inbox/unmatched`, linked from the Inbox header with the open count) instead of being dropped. Someone files it under a person there, or ignores it. The app stores an unknown sender it can identify as a new lead.

The first sync of a new mailbox stores a cursor and ingests nothing. If Gmail expires the cursor, the app resets it and writes a note in the mailbox's `last_error`. Replies and bounces in that gap are not synced.

Every email carries an unsubscribe link and the `List-Unsubscribe` and `List-Unsubscribe-Post` headers (RFC 8058 one-click). The link opens a page with a confirm button. Confirming suppresses the address in that organization only and stops its pending and active email enrollments. Repeating it does nothing.

## Limits and spacing

- **Daily limit.** Set per mailbox, 1 to 200, default 30. The app counts today's `sends` rows. The day is the mailbox's own time zone. Failed attempts that Gmail refused do not use quota.
- **One send per mailbox per tick.** With a 60 second tick, the gap setting decides the real pace.
- **Gap between sends.** A random 18 to 24 minutes by default. An organization overrides it within 1 to 240 minutes in Settings, Mailboxes, Sending rules.
- **Order.** Follow-ups go before new leads, oldest due first.
- **Retries.** A send that Gmail refuses retries after 15 and then 30 minutes, then the enrollment fails (3 attempts). A send with an unknown result (timeout, unreadable response) is never retried on a guess. After 10 minutes the app looks for it in the sent mail, scanning from the time of the claim (an hour earlier, to allow for clock skew). Found means sent. Still missing after 30 minutes means it retries.

## Working hours and time zones

Each mailbox has working days, a start and end time, and a time zone, set in **Settings > Mailboxes**. The times step by 30 minutes, the end time also offers 23:59, and a time saved off the step stays as it is. An end at or before the start runs past midnight. New mailboxes default to Monday to Friday, 09:00 to 18:00 in the time zone the browser reported on the setup page (UTC when none was saved). A mailbox outside its hours holds its sends until the window opens. This is the usual reason a started campaign sends nothing in the evening or on a weekend. Check the time zone first if sends start at the wrong hour.

## Pause all sending

`PAUSE_OUTBOUND` stops every automated sequence send on the server at once, without touching data. Use it when a mailbox is burning, a template is wrong, or LinkedIn warns an account.

To pause, set `PAUSE_OUTBOUND=true` in `.env` and recreate the app: `docker compose up -d app`. The switch is read on every call, so a restart is all it takes. To resume, set it empty or `false` and recreate the app again. Campaigns, enrollments and mailbox settings stay as they are, and due sends go out at the next tick after you resume.

While it is set:

- **Stopped.** The email send job and the LinkedIn run job (messages, invitations and profile lookups) claim nothing and send nothing. The tick report shows `detail.paused: 1` for `email.send` and `linkedin.run`. Both send engines also check the switch before every claim, so a call outside the tick stops as well. The mailbox test send is refused with 409 "Sending is paused (PAUSE_OUTBOUND)" before it reaches the provider.
- **Still running.** Inbox sync, bounce and reply handling, LinkedIn webhooks and account sync, LinkedIn search, reconcile jobs (they only look up sends already made), follow-up draft writing and AI jobs. A reply still stops its sequence while sending is paused.
- **Not covered.** A reply you approve on an Inbox thread still sends, because a person decides each one. Disable the mailbox or the LinkedIn account to block those too.
- **Banner.** Every page of the app shows "Sending is paused." and "Campaign emails and LinkedIn actions wait until the pause ends. Replies you approve still send. The server administrator ends the pause, see docs/operations.md." while the switch is set.
- **Typos.** A value the app cannot read (`maybe`, `ture`) does not stop the server from starting. It counts as paused, the banner shows, and the server logs one warning at start that names `PAUSE_OUTBOUND` and the value. Fix the value and recreate the app to resume.

An owner or admin can also pause one organization without touching the server: Settings, Organization, Sending, Pause all sending. The pause is stored in the organization's `general` channel settings (`sendingPaused` with the time and the name of the person), and both send engines read it inside their claim transaction, so that organization claims no campaign email and no LinkedIn action while other organizations keep sending. Replies you approve and mailbox test sends still go out. Every page shows "Sending is paused." with the name of the person who paused and a link to resume. `PAUSE_OUTBOUND` wins when both are set.

Pausing a single campaign or disabling a single mailbox stays available for a narrower stop. `EMBEDDED_SCHEDULER=false` is not a pause: it also stops reply and bounce sync.

## Job tick report

`POST /api/jobs/tick` returns JSON. The embedded scheduler produces the same report and hands it, like the endpoint, to the tick observer:

- A job that threw, or reported failed items in `detail` (any key containing `fail` or `error` with a count above zero), writes one line `[jobs] {"event":"job.failed",...}` to stderr. The same fault repeating logs once, then at most every ten minutes with `repeatedSinceLastLine`. A job that runs clean afterwards logs `job.recovered`.
- A tick that takes 30 seconds or more writes one `tick.slow` line (stderr) with the slowest jobs, at most every ten minutes.
- Each logged failure also updates one row in `job_runs` (job `tick:<name>`, one row per error text) that Settings, Jobs shows under Background job failures. Those rows follow `RETENTION_JOB_RUNS_DAYS`.

| Field | Meaning |
| --- | --- |
| `startedAt` | ISO time the tick began. |
| `durationMs` | Total time of the tick. |
| `jobs[].name` | `email.inbox-sync`, `email.reconcile`, `email.send`, the LinkedIn jobs, the AI jobs, `conversations.sequences`, `grid.run`, `platform.daily-rollover` and `platform.history-prune`. |
| `jobs[].processed` | Items handled: mailboxes synced, uncertain sends settled, emails sent. |
| `jobs[].more` | `true` when work remains or the job did not run because the 50 second budget ran out. A caller can tick again soon. |
| `jobs[].detail` | Counts for `email.inbox-sync`: `hard_bounce`, `soft_bounce`, `reply`, `auto_reply`, `own_message`, `ignored_unknown_sender`, and `mailboxes_failed`. |
| `jobs[].durationMs` | Time the job took in this tick. |
| `jobs[].error` | Message from a job that threw. Other jobs still run. |

An empty `jobs` array means no jobs are registered. Without a mailbox provider the email jobs are missing, so check `MAILBOX_PROVIDER`. Check the key too (see [Gmail setup](setup/gmail.md)).

## Follow-ups after a reply job

`conversations.sequences` runs the follow-ups of the campaign setting Follow-ups after a reply on every tick. It first stops runs whose person replied, asked not to be contacted, unsubscribed, bounced, was suppressed or became a contact (reason `converted`), and runs whose reply handling a person closed or whose reply moved to a reply type set to stop follow-ups (`reply_types.follow_ups = 'stop'`). It then starts runs for replies with a newly applied AI pick whose type keeps follow-ups going, and writes the draft for each due step. A run on a type set to Don't write a reply draft starts at step 2. A run starts from the campaign that most recently emailed the person, and only when that campaign is an email campaign in "AI drafts, you approve" mode with a published flow. A paused campaign starts no new runs and holds draft writing for runs in progress. Switching the campaign back to "Off, hand to the Inbox" interrupts its runs in progress with the reason `after_reply_off`. A contact starts no run; creating a deal ends the person's runs in the same transaction. The job never sends: a person approves every draft on the Inbox thread, and only that path sends. One step is claimed at a time with a row lock, and a step stuck in `drafting` for longer than the lease is taken over, so overlapping ticks do not write two drafts. Whole-day delays follow the organization's time zone (Settings, Organization, UTC when unset). Retention: runs, step runs and their drafts are kept. No pruning step touches them.

## Grid job and enrichment settings

`grid.run` runs the queued enrichment and AI cells of the Tables feature, one job row per cell, in a lease-protected claim (5 minute lease, a displaced worker changes nothing). A pass keeps `GRID_RUN_CONCURRENCY` cells running and starts the next cell the moment one finishes, until the queue is empty, the tick budget (50 seconds) ends, or the safety ceiling of 2,000 claimed cells is reached. A run, retry or auto-run request also starts a pass in the receiving process about 25 ms after the response (one kicked pass at a time, repeated while cells remain). Other instances pick the cells up on their tick. One organization runs at most 8 cells at once across all workers.

[Configuration](configuration.md) lists `GRID_PROVIDER`, `GRID_HTTP_ALLOWED_HOSTS` and `GRID_RUN_CONCURRENCY` (default 8, 1 to 16). Each pass in a process has its own pool, so a kicked pass and a tick pass can overlap. A Custom HTTP provider can only call hosts in `GRID_HTTP_ALLOWED_HOSTS`, over https; the native vendor adapters use fixed hosts and need no entry (see [Enrichment providers](setup/enrichment.md)).

Provider keys are saved per provider in the app (encrypted with `INTEGRATION_CREDENTIALS_KEY`) and never appear in cell results or logs. Retention: `grid_jobs` rows stay after they finish (`succeeded` or `failed`) so a retry can find failed cells, and `grid_cell_runs` keeps the cost and result ledger. The history pruning job does not touch either. The `job_runs` rows of both new jobs follow `RETENTION_JOB_RUNS_DAYS`.

## Rotating the credential key

`INTEGRATION_CREDENTIALS_KEY` encrypts every saved credential: AI provider keys (Anthropic, Vercel AI Gateway, OpenRouter), Unipile keys, and the keys of grid providers. Stored envelopes look like `v2:<keyId>:<iv>:<tag>:<ciphertext>`. The key id is the first 8 hex characters of the key's SHA-256, so the app finds the right key without trying them all. Older `v1:` envelopes (no key id) still decrypt.

Rotate when the key leaked or on your own schedule. Nothing needs re-entering and the app stays up.

1. Make the new key: `openssl rand -hex 32`. Keep a copy outside the server.
2. In `.env`, move the current value into `INTEGRATION_CREDENTIALS_LEGACY_KEYS` (comma separated when you keep several) and put the new key in `INTEGRATION_CREDENTIALS_KEY`. Each key needs 32 characters or more.
3. Deploy: `docker compose up -d`. New saves use the new key. Rows still on the old key keep working because the old key is on the legacy list.
4. Dry run: `docker compose exec app node scripts/rotate-credentials.mjs`. It writes nothing. It prints, per table (`integration_credentials`, `grid_provider_credentials`), how many rows are on the current key, how many it would rotate and from which key id, and which rows no known key can decrypt.
5. Apply: `docker compose exec app node scripts/rotate-credentials.mjs --apply`. Each row is decrypted with whichever known key fits, re-encrypted with the current key, checked, and written in its own transaction. Rows already on the current key are skipped, so you can run it again. Outside Docker the same run is `pnpm credentials:rotate` and `pnpm credentials:rotate --apply`.
6. Run the dry run again. Every row should show as already on the current key and 0 undecryptable.
7. Remove the old key from `INTEGRATION_CREDENTIALS_LEGACY_KEYS` and deploy again.

The script prints counts, key ids and row ids. It never prints a key or a credential. A row that no known key can decrypt is listed and left as it was, and the script exits with code 2 after it finishes the others. Find the key for that key id (its first 8 SHA-256 hex characters: `printf %s "$KEY" | shasum -a 256 | cut -c1-8`), add it to the legacy list and run again. If the key is gone, save the credential again in the app. Exit code 1 means a usage or configuration error (missing `DATABASE_URL`, a key shorter than 32 characters).

Back up the database before the first `--apply`. Keep the old key until step 6 shows no row on it, because a backup restored from before the rotation needs it.

## History retention

`platform.history-prune` deletes only logs. Defaults in days: `RETENTION_JOB_RUNS_DAYS` 30, `RETENTION_INBOUND_EVENTS_DAYS` 30 (finished events), `RETENTION_INBOUND_FAILED_DAYS` 90 (dead-lettered events), `RETENTION_AI_JOBS_DAYS` 30 (succeeded AI jobs). Sends, messages, enrollments, suppression, sequence runs and grid data are never pruned.

## Logs

The app writes to stdout and stderr. Read them with:

```bash
docker compose logs -f app
```

Lines to look for:

- `Email jobs disabled: <reason>`: the Gmail key is missing or malformed. The app still runs.
- `[auth-email] to=... subject=...`: an auth email (invitation, reset link) printed because `RESEND_API_KEY` and `AUTH_EMAIL_FROM` are not both set. Copy the link from the log.
- `[auth] <what> email failed:`: Resend refused or was unreachable.

Mailbox errors show in the Mailboxes page as the mailbox's last error.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. It needs no secrets. A newer push to the same ref cancels the older run.

| Job | What it runs |
|-----|--------------|
| `typecheck` | `pnpm typecheck` |
| `lint` | `pnpm lint` |
| `test` | `pnpm db:migrate` (the script the production image runs) against a `postgres:17` service, then `pnpm test` with `TEST_DATABASE_URL` set. Require the check named `test` in branch protection. |
| `build` | `pnpm build` |
| `e2e` | `pnpm exec playwright install --with-deps chromium`, then `pnpm e2e` against a `postgres:17` service. A failed run uploads the Playwright results and the server logs from `e2e/.run/` as artifacts. |
| `docker` | `scripts/docker-image-check.sh`: builds the Dockerfile without pushing, starts the image, waits for `/api/health` and asserts that `/api/dev/inbound` and `/api/webhooks/dev-fakes` answer 404 with every helper variable on |

Node 22 and the pnpm version in `package.json` (`packageManager`) are used. Actions are pinned by commit SHA; refresh one with `git ls-remote --tags <repo>`.

Run the same steps locally with `scripts/ci-local.sh`. It starts a throwaway Postgres container (`postgres:17`) on a free port, runs install, typecheck, lint, migrate, vitest, build, e2e and the Docker image check in that order, stops at the first failure and removes the container on exit. Set `SKIP_DOCKER_IMAGE=1` to skip the image check. It needs Docker and Playwright's Chromium (`pnpm exec playwright install chromium`).
