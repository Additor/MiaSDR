# Database

## PostgreSQL version

MiaSDR supports **PostgreSQL 17 or newer**. The bundled Compose file runs PostgreSQL 17, and the CI `test`, `e2e` and `docker` jobs run it too. Nothing tests 15 or 16.

Two schema features need PostgreSQL 15, so the schema itself would apply on 15 and 16. The floor is a support statement, and the startup check enforces it:

- `UNIQUE NULLS NOT DISTINCT` on `job_runs_job_slot_org_uq`, added in PostgreSQL 15.
- `ON DELETE SET NULL (column)` on twenty-six composite foreign keys, added in PostgreSQL 15. It nulls one column of a composite foreign key and keeps `organization_id` set.

On PostgreSQL 14 or older the first migration fails with a bare syntax error. The app reads `server_version_num` when the server starts. It prints the detected and required versions and exits with code 1 on a server older than 17. `src/platform/db/postgres-version.ts` holds the check. It runs before migrations and whether or not `RUN_MIGRATIONS` is on.

The command `drizzle-kit migrate` does not run this check. Check the version yourself before you use it on a new server:

```sql
show server_version;
```

If you run 15 or 16, upgrade with `pg_upgrade` or a dump and restore before you update MiaSDR. `scripts/migrate.mjs` applies the same check.

## Migrations

Migrations live in `drizzle/` and run at boot under an advisory lock (`src/platform/db/migrate.ts`). Drizzle applies all pending migrations in one transaction, so a failed migration leaves nothing behind.

`0000_baseline.sql` creates the whole schema in one file. The part above its marker comes from `drizzle-kit generate` over `src/platform/db/schema.ts`, with two kinds of edit: `ON DELETE SET NULL (column)` on composite foreign keys and the deferred unique key on `deal_stages`. Below the marker sits SQL that Drizzle cannot express: three foreign keys that would make the table types circular, and the functions and triggers that the sections below describe.

A database built before this baseline holds the same tables under older migration conversations, so the baseline fails on it with `already exists`. Start that one from an empty database.

### Adding a migration

1. Change the context's `schema.ts`.
2. Run `pnpm exec drizzle-kit generate --name <what_it_does>`. It writes the next numbered file and its snapshot.
3. Edit the SQL by hand for what Drizzle cannot express (the forms listed above), and add triggers or functions there too.
4. A migration that changes existing rows gets a test: build a scratch database at the migration before it (helpers in `src/test-support/migration-test-kit.ts`), fill it, apply the new file and check what it did to those rows. The rules the new schema enforces belong in a schema test on the shared database.

A released migration never changes. A new index on a large table holds a `SHARE` lock that blocks writes until the build finishes, and the migrator cannot use `CONCURRENTLY`. Write such an index with `CREATE INDEX IF NOT EXISTS`, so an operator can build it first with `CREATE INDEX CONCURRENTLY` and the same name, and the migration then skips it.

## Final send status

`sends_final_status_trg` and `send_attempts_final_status_trg` guard a final status. Once a send reaches `sent` or `failed`, or a send attempt reaches `sent`, `reconciled` or `failed`, an `UPDATE` that changes `status` raises SQLSTATE 23514 (`check_violation`). An update that keeps the status passes, so you can still change the error or the body.

The trigger allows one exit: a `failed` send may move back to `sending` when the same update raises `attempt` by one. The engines re-claim a failed step that way in their `insert ... on conflict do update` statement. The trigger holds no cap, and neither does the upsert: `scheduleRetry` ends the enrollment at `MAX_SEND_ATTEMPTS`, and a claim picks only live enrollments. One path goes past the cap on purpose: a person who removes a lead while its last attempt is in flight or unknown, then restores it, gets one more attempt per restore, because the removal kept `scheduleRetry` from ending the enrollment. A test or a script that resets a final status by hand hits the trigger. Insert a new row instead.

`sends_unsettled_no_delete_trg` refuses a `DELETE` of a send in `sending` or `unknown` (SQLSTATE 23000). A worker holds a provider call in flight for the first, and nobody knows whether the second reached the person. The foreign key from `sends` to `campaign_enrollments` takes no action, so an enrollment delete fails while its sends remain, and the code removes them first through this guard. Deleting an organization cascades past it.

## Claims and drafts in flight

`ai_jobs`, `follow_up_step_runs`, `inbound_events` and `mia_runs` carry a nullable `claim_token`. A worker writes a new token on each claim, and a settle filters on it with `heldBy` (`src/platform/db/claim.ts`), so a worker that lost its claim changes nothing. A settle, a stop, a pause and the expiry sweep clear the token. The writes that take no claim (a stop, a pause, a resume, a skip, the reconcile of drafts, the expiry sweep) sit in `FENCE_EXEMPT` in `src/architecture/claim-fences.test.ts` with their reason.

`drafts_one_in_flight_uq` holds at most one draft per conversation in `sending` or `delivery_uncertain` (`IN_FLIGHT_DRAFT_STATUSES`). A second one raises SQLSTATE 23505.

## Lock modes

A row lock that serializes writers on `conversations` or `threads` takes `FOR NO KEY UPDATE`. It conflicts with itself, so the writers still queue, but it lets through the `FOR KEY SHARE` that a foreign key check takes when a draft or a message is inserted. Two orders meet on these rows: a reply send locks the thread and its draft insert takes a key share on the conversation, while an AI draft write, a typed draft, the follow-up engine, a reclassification and ingest lock the conversation and their inserts take a key share on the thread. With `FOR UPDATE` on both sides the two waited on each other (40P01); `linkedin-reply.integration.test.ts` holds the case.

`FOR UPDATE` stays where a row goes away or must hold back key shares:
- A contact delete locks the person's conversations and threads `FOR UPDATE` (`lockPersonForDelete`), because it deletes them.
- A reply send locks its conversation `FOR UPDATE` on both channels. It holds back an ingest's message insert, whose transaction would go on to retire drafts and update the conversation, a cycle with the send's draft lock.

One order for the conflicting locks: the conversation before its threads. Marking reply handling done takes the conversation `FOR NO KEY UPDATE` and then `FOR SHARE` on its threads, which waits for a send in progress ("Reply send rules" in `docs/decisions.md`). The reply send locks the thread first, but on the conversation it takes only the key share of its draft insert, which no writer lock blocks. A contact delete takes conversations, then threads, both `FOR UPDATE`, and gives way on its held-lock timeout when a send meets it.

The organization's `agent-send:<organization id>` advisory lock (`agent-access/infrastructure/agent-send-lock.ts`) orders agent sends against the changes that can stop them:

| Path | Order |
| --- | --- |
| Agent email reply | conversation `FOR UPDATE`, draft `FOR UPDATE`, then `agent-send` exclusive; the policy and the counts follow in later statements |
| Agent LinkedIn reply | conversation, draft, `agent-send` exclusive, then account: a member removal takes `agent-send`, then the account |
| Agent campaign start or resume | campaign `FOR UPDATE`, then `agent-send` shared |
| Agent enroll | campaign `FOR SHARE`, `agent-send` shared, then `agent-enroll:<organization id>` exclusive; the day's count follows |
| Emptying a campaign's senders | campaign `FOR KEY SHARE` before the delete |
| Member change (role change, removal), MCP token revoke, MCP settings save | `agent-send` exclusive before any row lock; a removal then locks members |

An agent action that starts after one of the changes answers sees the new state; one that already holds the lock finishes first. A person's send or enroll takes no advisory lock, and no send locks members. A person's enroll takes no campaign lock; its insert's foreign key check waits for a start that holds the campaign. A removal revokes the person's MCP tokens in the same transaction. Token creation locks the creator's member row `FOR UPDATE`, so it waits for a removal in progress and then finds no member row.

## Append-only tables

`events`, `audit_log` and `messages` are append-only:

- `UPDATE` on `events` and `audit_log` raises (SQLSTATE 23000). The one exception is the foreign key action that clears `actor_user_id` when a user is deleted.
- `UPDATE` on `messages` raises unless only `important` or `opened_at` changes.
- A direct `DELETE` on any of the three raises. A delete that comes from a cascade (deleting an organization) passes.

To remove rows on purpose (a retention job, a manual clean-up), set the purge flag inside the transaction:

```sql
begin;
select set_config('miasdr.allow_purge', 'on', true);
delete from events where created_at < now() - interval '2 years';
commit;
```

The flag lasts for that transaction. `TRUNCATE` is not guarded.

## Immutable identity and versions

Triggers freeze the rows that other rows point at by value or by version. Each rule is a trigger that raises SQLSTATE 23000:

- `threads`: `channel`, `account_ref`, `provider_thread_id` and `provider_contact_id` cannot change. `status` and `updated_at` stay writable.
- `reply_types`: `key`, `group_key`, `reply_type_set_id` and `system_role` cannot change. The app writes the other columns only when it seeds a set: name, description, guidance, the type rules (`reply_draft`, `follow_ups`) and `sort_order`.
- `knowledge_document_versions`: append-only. An edit of a Brain item's fields inserts a new version and raises `knowledge_documents.latest_version`. A direct `DELETE` raises like the ledger tables above (cascades pass, the purge flag allows it).
- `follow_up_versions` and `follow_up_steps`: `organization_id`, `flow_id` and `version` never change. A published version freezes its `status`, its `published_at` and all of its steps. The draft-to-published update stays legal, and so does deleting a flow, which cascades.

To change a frozen value, insert a new row (a new knowledge version, a new draft version of a flow). Deleting a row and recreating it works for a reply type only while nothing references it. It does not work for a conversation: its messages are append-only and block the delete, so a wrong `channel` or thread id stays on that conversation and new mail goes to a new one. A one-off repair needs a migration that drops and re-adds the trigger. No setting bypasses the update triggers.

## Follow-ups after a reply storage

The campaign setting Follow-ups after a reply (`after-reply` in code) lives in the `follow_up_*` tables. `follow_up_flows.campaign_id` is required, with a composite foreign key to `campaigns` (`ON DELETE CASCADE`) and a unique index on `(campaign_id)`. A campaign is in `ai_drafts` mode when it owns a flow with status `active` and a published version. It is in `handoff` mode with no row, or with status `archived`. The triggers under Immutable identity and versions keep published versions frozen.

`follow_up_flows.after_reply_enabled_at` holds the moment the setting last turned on. Only the flow save writes it (a new flow, or a switch from archived to active). The engine starts runs only for replies that arrived no earlier than a margin before it, so other writes to the row (`updated_at`) do not move that cut-off.

## Reply type rules

`reply_types.reply_draft` (boolean, default true) and `follow_ups` (`continue` or `stop`, default `continue`) hold the type rules, and `system_role` (`stop_request`, `customer` or null) marks the stop request and customer types. `reply_types_rules_ck` and `reply_types_system_role_ck` hold the allowed values, and `reply_types_keys_trg` makes `system_role` immutable. Checks hold the fixed parts. `reply_types_stop_request_ck` keeps the stop request type checked before, without a draft, with follow-ups stopped, and active. `reply_types_customer_ck` keeps the customer type in the customer group. `reply_types_set_system_role_uq` allows one type per role in a set.

`reply_type_picks.rules` is a JSON object with the rules the pick used (`replyDraft`, `followUps`), or null for a pick that names no type.

## Leads and the CRM

`people.lifecycle` is `lead` or `contact` (default `lead`), and `converted_at` is set exactly for a contact. Two CHECKs hold those rules, and `people_lifecycle_trg` rejects a contact going back to lead and any change of `converted_at` once set. A partial index `(organization_id, converted_at DESC, id) WHERE lifecycle = 'contact'` serves the Contacts list; queries write the predicate as a literal so a generic plan can use it. `people (company_id, organization_id)` references `companies (id, organization_id)` with `ON DELETE SET NULL (company_id)`.

Two tables hold the CRM. `deal_stages` is one ordered pipeline per organization: `kind` is `open`, `won` or `lost` and a trigger keeps it immutable, a `DEFERRABLE INITIALLY DEFERRED` unique `(organization_id, position)` lets two positions swap in one transaction, and `(organization_id, lower(name))` is unique. A deal points at its person with `(person_id, organization_id)` and at its stage with `(stage_id, organization_id, stage_kind)`, both `RESTRICT`, so a stage or a person with deals cannot be deleted and `stage_kind` always equals the stage's kind. The `closed_at` and `lost_reason` CHECKs read `stage_kind`. Triggers require the person to be a contact on insert and keep `person_id` and `organization_id` fixed. `source_enrollment_id` references `campaign_enrollments` with `ON DELETE SET NULL (source_enrollment_id)`. An organization gets the five default stages (New, Meeting, Proposal, Won, Lost) on its first deal or stage write (`ensureStages` in `deals/infrastructure/drizzle-deal-store.ts`).

Two narrow triggers on `campaign_enrollments` (insert with a `pending` or `active` status, and an update of `status` into `pending` or `active` from another status) read the person `FOR SHARE` and raise `check_violation` with the message `contact_cannot_be_enrolled`. They do not fire on anything the send engine writes, so a send in flight never meets a conversion's locks.

## Contacts and companies

These columns and tables back add, merge and delete ("Contacts and Companies CRUD" in `docs/decisions.md`). `companies.crm_listed_at` is the time the company entered the CRM, which the Companies list reads together with "has a contact"; no trigger writes it. `companies.version` (default 0, CHECK `version >= 0`) is the optimistic lock that every company write bumps. `people.creation_key` is the idempotency key of the Add contact request (CHECK 8 to 200 characters, unique per organization when set).

`company_domain_aliases` holds the other domains a merge gives a company: `(company_id, organization_id)` references `companies` with `ON DELETE CASCADE`, so a deleted company takes its aliases with it, and `(organization_id, domain)` is unique. A domain is either a company domain or an alias in one organization. The application serializes every writer of a domain on an advisory lock; two triggers back it up and raise SQLSTATE 23505 with the constraint names `company_domain_is_alias` (a company insert or domain change onto an alias) and `alias_is_company_domain` (an alias onto a company domain).

`identity_exceptions_resolution_ck` lets a `resolved` row keep its status with a null `resolved_person_id`, so deleting a person who resolved an unmatched sender succeeds. Indexes cover the foreign keys a contact delete deletes through (`conversations.latest_inbound_message_id`, `drafts.reply_for_message_id`, `drafts.thread_id`, `lead_ccs.source_message_id`, `follow_up_runs.trigger_message_id`, `follow_up_runs.thread_id`, `follow_up_step_runs.sent_message_id`).

## Brain item versions

`knowledge_documents_latest_version_fk` is a foreign key from `(id, latest_version)` to `knowledge_document_versions (document_id, version)`. It is `DEFERRABLE INITIALLY DEFERRED`, so the check runs at commit. Insert an item and its first version in one transaction. An item that commits without the version row, or a `latest_version` that names a missing version, fails with the constraint name.

## Messages update trigger

`messages_reject_immutable_update` compares the columns of `messages` one by one. A column you add to `messages` is not compared until a new migration adds it to the function. `src/platform/db/__tests__/messages-trigger-columns.integration.test.ts` fails when a column is neither compared nor listed as writable.

## Cross-row rules

Five triggers hold rules a foreign key cannot express. Each raises SQLSTATE 23000:

- `reply_type_picks.message_id` is an inbound message of the pick's own conversation.
- `reply_type_picks.previous_`, `proposed_` and `applied_reply_type_id` belong to the conversation's reply type set and to the matching `*_group_key`. A null key accepts any group.
- `drafts.channel` equals the channel of the draft's conversation.
- `drafts.reply_for_message_id` is an inbound message of the draft's own conversation, in the same organization. It may live in another conversation of that conversation, because the reply target is the conversation's latest inbound message. The update trigger also checks when `conversation_id` changes.
- `send_attempts.account_ref` equals the account of the draft's conversation, compared with `lower()` on both sides. A blank value goes to `send_attempts_refs_ck`.

A reference to a row that does not exist is left to the foreign key, so its own constraint name appears in the error. The update triggers fire only when a checked column changes, so the `ON DELETE SET NULL` actions never trip them.

## Organization-scoped indexes

`grid_jobs_org_status_idx`, `sends_org_status_idx`, `ai_jobs_org_failed_idx` (partial, `status = 'failed'`), `contact_policies_org_dnc_idx` (partial, `do_not_contact`), `linkedin_search_batches_org_created_idx` and `linkedin_search_queries_org_created_idx` each serve a query that filters one organization without a parent key. The 12 tables in `INDEX_DEBT` (`src/platform/db/schema-audit.ts`) are reached through an indexed parent key. Only an organization delete would scan them, and organization deletion is disabled in `auth.ts`. The audit test pins that list. `send_attempts` left it with the agent limit indexes (`send_attempts_agent_org_idx`, `_user_idx`, `_account_idx`, partial on `origin = 'agent'`), which count one organization's agent sends of the day.

Write cost: each index adds one btree insert per row written. `sends` and `grid_jobs` take the most writes. The two partial indexes touch only rows in the matching state.

When you build an index by hand with `CREATE INDEX CONCURRENTLY` ahead of a migration (see Adding a migration), an interrupted build leaves the index invalid, and `IF NOT EXISTS` then skips it. The migration reports success with an index Postgres never uses. After a manual build, check for invalid indexes and rebuild them:

```sql
select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid where not i.indisvalid;
drop index concurrently "sends_org_status_idx";  -- then create it again with CREATE INDEX CONCURRENTLY
```

## Tenant scope

Every table that holds customer data carries `organization_id uuid not null` with a foreign key to `organizations`. `src/platform/db/__tests__/schema-audit.integration.test.ts` checks this against `information_schema` and fails CI when a new table breaks the rule. The allow-lists in `src/platform/db/schema-audit.ts` name the exceptions and give a reason for each. The audit also fails on a foreign key between two tables with `organization_id` that leaves that column out of the key; `SCOPED_BY_SIBLING_KEY` names the three keys that another composite key on the same row already scopes.

## Tables by context

Each context declares its tables in `src/contexts/<context>/infrastructure/schema.ts`. Analytics owns no tables and reads the others through its read model.

- identity: `users`, `sessions`, `accounts`, `verifications`
- tenancy: `organizations`, `members`, `invitations`, `channel_settings`, `audit_log`
- agent-access: `mcp_tokens`, `mcp_rate_limits`, `mcp_tool_calls`, `mcp_agent_usage`
- people: `companies`, `company_domain_aliases`, `people`, `entity_columns`, `import_runs`, `contact_policies`, `suppression_list`, `lead_fit_assessments`
- outreach: `mailboxes`, `linkedin_accounts`, `linkedin_connect_links`, `campaigns`, `campaign_senders`, `campaign_enrollments`, `linkedin_enrollment_details`, `sends`, `linkedin_connections`, `linkedin_search_batches`, `linkedin_search_queries`, `linkedin_search_results`, `inbound_events`
- brain: `knowledge_documents`, `knowledge_document_versions` (Brain items; the tables keep their older name)
- conversations: `reply_type_sets`, `reply_types`, `reply_handling_settings`, `conversations`, `threads`, `messages`, `identity_exceptions`, `lead_ccs`, `events`, `reply_type_picks`, `drafts`, `send_attempts`, `ai_jobs`, `notes`, `tasks`
- conversations, follow-ups (`follow-ups-schema.ts`): `follow_up_flows`, `follow_up_versions`, `follow_up_steps`, `follow_up_runs`, `follow_up_step_runs`
- deals: `deal_stages`, `deals`
- mia: `mia_runs`, `mia_suggestions`, `mia_usage_daily`, `mia_threads`, `mia_messages`, `mia_thread_people`
- grid: `grid_folders`, `grid_workbooks`, `grid_tables`, `grid_user_views`, `grid_columns`, `grid_rows`, `grid_cell_runs`, `grid_jobs`, `grid_providers`
- integrations: `integration_accounts`, `integration_credentials`
- shared jobs (`src/platform/jobs/schema.ts`): `job_runs`
