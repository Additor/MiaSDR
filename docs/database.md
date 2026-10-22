# Database

## PostgreSQL version

MiaSDR supports **PostgreSQL 17 or newer**. The bundled Compose file runs PostgreSQL 17, and the CI `test`, `e2e` and `docker` jobs run it too. Nothing tests 15 or 16.

Two schema features need PostgreSQL 15, so the schema itself would apply on 15 and 16. The floor is a support statement, and the startup check enforces it:

- `UNIQUE NULLS NOT DISTINCT` in migration 0001 (`job_runs_job_slot_org_uq`), added in PostgreSQL 15.
- `ON DELETE SET NULL (column)` in migrations 0012, 0024, 0025 and 0028, added in PostgreSQL 15. It nulls one column of a composite foreign key and keeps `organization_id` set.

On PostgreSQL 14 or older the first migration fails with a bare syntax error. The app reads `server_version_num` when the server starts. It prints the detected and required versions and exits with code 1 on a server older than 17. `src/platform/db/postgres-version.ts` holds the check. It runs before migrations and whether or not `RUN_MIGRATIONS` is on.

The command `drizzle-kit migrate` does not run this check. Check the version yourself before you use it on a new server:

```sql
show server_version;
```

If you run 15 or 16, upgrade with `pg_upgrade` or a dump and restore before you update MiaSDR. `scripts/migrate.mjs` applies the same check.

## Migrations

Migrations live in `drizzle/` and run at boot under an advisory lock (`src/platform/db/migrate.ts`). Drizzle applies all pending migrations in one transaction, so a failed migration leaves nothing behind.

| # | File | What it does | Locks and rollback |
|---|------|--------------|--------------------|
| 0000 | `0000_init_identity_tenancy.sql` | Users, sessions, accounts, verifications, organizations, members, invitations, channel settings. | |
| 0001 | `0001_leads_outreach_integrations.sql` | People, companies, imports, campaigns, enrollments, mailboxes, sends, LinkedIn tables, integrations, `job_runs`. | Needs PostgreSQL 15 (`UNIQUE NULLS NOT DISTINCT`). |
| 0002 | `0002_conversations.sql` | Records, conversations, messages, classifications, drafts, send attempts, knowledge, events, notes, tasks, AI jobs. | |
| 0003 | `0003_mailbox_takeover.sql` | `mailboxes.unavailable_since` and `sends.taken_over_from_mailbox_id`. | |
| 0004 | `0004_linkedin_search_queue.sql` | Paging, limit and target campaign columns for the LinkedIn search queue. | |
| 0005 | `0005_remaining_port_sequences_grid.sql` | Sequence tables and all grid tables. | |
| 0006 | `0006_hardening_archive_views_index.sql` | `campaigns.archived_at`, `grid_user_views`, a messages read index. | |
| 0007 | `0007_gap_closure_schema.sql` | `audit_log`, `lead_ccs`, `linkedin_connect_links` and columns on sends, tasks, people and batches. | |
| 0008 | `0008_final_status_guard.sql` | Triggers that keep a final status on `sends` and `send_attempts` (see Final send status). | No table changes. |
| 0009 | `0009_knowledge_guidance_ai_cap.sql` | Adds `skipped` to `ai_jobs` status and backfills guidance for the seeded subcategories. | Fills blank fields only. |
| 0010 | `0010_enrollment_removed_status.sql` | Adds `removed` to the enrollment status CHECK. | |
| 0011 | `0011_read_indexes.sql` | Seven read indexes. | `IF NOT EXISTS`, so you can prebuild them `CONCURRENTLY`. |
| 0012 | `0012_foreign_keys_and_checks.sql` | Thirteen foreign keys and the business CHECKs, with a data pre-check. | Locks held until commit. Maintenance window on a large database. |
| 0013 | `0013_append_only_triggers.sql` | Makes `events`, `audit_log` and `messages` append-only. | No table changes. |
| 0014 | `0014_personal_campaigns.sql` | `campaigns.type` and `conversations.private_campaign_id`. | ACCESS EXCLUSIVE on `campaigns` until commit. |
| 0015 | `0015_search_batch_defaults.sql` | A search batch keeps its own result limit and target campaign. | |
| 0016 | `0016_immutable_identity_and_versions.sql` | Freezes conversation identity, subcategory keys, knowledge versions and published sequence versions. | SHARE ROW EXCLUSIVE per table. |
| 0017 | `0017_knowledge_latest_version_fk.sql` | Deferred foreign key from `knowledge_documents.latest_version` to its version row. | SHARE ROW EXCLUSIVE on both tables. |
| 0018 | `0018_messages_update_cost.sql` | Rewrites the messages update trigger to compare column by column. | No table lock. |
| 0019 | `0019_org_read_indexes.sql` | Four organization-scoped indexes. | SHARE until built. `IF NOT EXISTS`. |
| 0020 | `0020_cross_row_validators.sql` | Five cross-row validation triggers. | Checks new writes only. |
| 0021 | `0021_org_search_indexes.sql` | Two LinkedIn search indexes on `(organization_id, created_at)`. | `IF NOT EXISTS`. |
| 0022 | `0022_after_reply_campaign_sequences.sql` | `sequences.campaign_id` for the After a reply flow. Archives legacy sequences. | |
| 0023 | `0023_after_reply_enabled_at.sql` | `sequences.after_reply_enabled_at` with a backfill. | Catalog change only. |
| 0024 | `0024_people_company_composite_fk.sql` | Tenant-composite key for `people.company_id`. | SHARE ROW EXCLUSIVE on `people` and `companies`. |
| 0025 | `0025_lead_crm_split.sql` | Lead and contact lifecycle, `deal_stages`, `deals`. | ACCESS EXCLUSIVE on `people`. Roll forward only. |
| 0026 | `0026_existing_customer_label.sql` | Renames the seeded `customer` subcategory. | Data only. |
| 0027 | `0027_contacts_companies_crud.sql` | Company version and CRM listing, person creation key, `company_domain_aliases`, seven indexes. | ACCESS EXCLUSIVE on `companies` and `people`. Roll forward only. |
| 0028 | `0028_record_assigned_to.sql` | `records.assigned_to` and `assigned_source` for the Actions queue, with a backfill. | ACCESS EXCLUSIVE on `records`. Roll forward only. |

Migrations 0011 to 0013 (schema hardening) add constraints to existing tables. They check your data first:

- A reference whose target no longer exists (a send that points at a deleted mailbox, a note that points at a deleted record) is set to null. The migration prints a `NOTICE` that names the table, the column and the row count.
- A row that breaks a new rule and cannot be repaired by nulling (a test send without its mailbox, a classification confidence of 9.9, a blank message key) stops the migration with a message that names the table, the constraint, the count and a query that lists the rows. Fix the rows and start the app again.

`0011_read_indexes` uses `CREATE INDEX IF NOT EXISTS`, so you can build the seven indexes beforehand on a large database with `CREATE INDEX CONCURRENTLY` and the same names. The migration then skips them.

## Final send status

Migration 0008 adds `sends_final_status_trg` and `send_attempts_final_status_trg`. Once a send reaches `sent` or `failed`, or a send attempt reaches `sent`, `reconciled` or `failed`, an `UPDATE` that changes `status` raises SQLSTATE 23514 (`check_violation`). An update that keeps the status passes, so you can still change the error or the body.

The trigger allows one exit: a `failed` send may move back to `sending` when `attempt` is below 3 and the same update raises it by one. The engines re-claim a failed step that way in their `insert ... on conflict do update` statement. A test or a script that resets a final status by hand hits the trigger. Insert a new row instead.

## Append-only tables

`events`, `audit_log` and `messages` are append-only since migration 0013:

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

Migration 0016 freezes the rows that other rows point at by value or by version. Each rule is a trigger that raises SQLSTATE 23000:

- `conversations`: `channel`, `account_ref`, `provider_thread_id` and `provider_contact_id` cannot change. `status`, `private_campaign_id` and `updated_at` stay writable.
- `subcategories`: `key`, `category_key` and `pipeline_id` cannot change. Name, description, guidance, `active` and the order fields stay writable.
- `knowledge_document_versions`: append-only. An edit inserts a new version and raises `knowledge_documents.latest_version`. A direct `DELETE` raises like the ledger tables above (cascades pass, the purge flag allows it).
- `sequence_versions` and `sequence_steps`: `organization_id`, `sequence_id` and `version` never change. A published version freezes its `status`, its `published_at` and all of its steps. The draft-to-published update stays legal, and so does deleting a sequence, which cascades.

To change a frozen value, insert a new row (a new knowledge version, a new sequence draft). Deleting a row and recreating it works for a subcategory only while nothing references it. It does not work for a conversation: its messages are append-only and block the delete, so a wrong `channel` or thread id stays on that conversation and new mail goes to a new one. A one-off repair needs a migration that drops and re-adds the trigger. No setting bypasses the update triggers.

## After a reply storage

Migration 0022 stores the campaign setting After a reply in the existing sequence tables. It adds a nullable `sequences.campaign_id` with a composite foreign key to `campaigns` (`ON DELETE CASCADE`), a partial unique index on `(organization_id, name) WHERE campaign_id IS NULL` and a partial unique index on `(campaign_id) WHERE campaign_id IS NOT NULL`. It archives every legacy sequence. A campaign is in `ai_drafts` mode when it owns a sequence with status `active` and a published version. It is in `handoff` mode with no row, or with status `archived`. Published versions stay frozen by the 0016 triggers.

Migration 0023 adds `sequences.after_reply_enabled_at`, the moment the setting last turned on. Only the flow save writes it (a new flow, or a switch from archived to active). The engine starts runs only for replies that arrived no earlier than a margin before it, so other writes to the row (`updated_at`) do not move that cut-off. The migration backfills active campaign flows from `updated_at`.

Migration 0024 gives `people.company_id` the tenant-composite key the other child tables have: `people (company_id, organization_id)` references `companies (id, organization_id)` with `ON DELETE SET NULL (company_id)`, replacing the single-column key. It sets a `company_id` that points at a missing company or one of another organization to null first and prints a NOTICE with the count.

Migration 0025 splits leads from the CRM. `people` gains `lifecycle` (`lead` or `contact`, default `lead`) and `converted_at`, with two CHECKs (the value set, and `converted_at` set exactly for a contact) and a trigger that rejects a contact going back to lead and any change of `converted_at` once set. A partial index `(organization_id, converted_at DESC, id) WHERE lifecycle = 'contact'` serves the Contacts list; queries write the predicate as a literal so a generic plan can use it. Two new tables hold the CRM: `deal_stages` (one ordered pipeline per organization, `kind` of `open`, `won` or `lost` that a trigger keeps immutable, a `DEFERRABLE INITIALLY DEFERRED` unique `(organization_id, position)` so two positions can swap in one transaction, and a unique `(organization_id, lower(name))`) and `deals`. A deal points at its person with `(person_id, organization_id)` and at its stage with `(stage_id, organization_id, stage_kind)`, both `RESTRICT`, so a stage or a person with deals cannot be deleted and `stage_kind` always equals the stage's kind. The `closed_at` and `lost_reason` CHECKs read `stage_kind`. Triggers require the person to be a contact on insert and keep `person_id` and `organization_id` fixed. `source_enrollment_id` references `campaign_enrollments` with `ON DELETE SET NULL (source_enrollment_id)`. Two narrow triggers on `campaign_enrollments` (insert with a `pending` or `active` status, and an update of `status` into `pending` or `active` from another status) read the person `FOR SHARE` and raise `check_violation` with the message `contact_cannot_be_enrolled`. They do not fire on anything the send engine writes, so a send in flight never meets a conversion's locks. The migration seeds the five default stages (New, Meeting, Proposal, Won, Lost) for every existing organization and changes no existing row. An organization created later gets them on its first deal or stage write (`ensureStages` in `deals/infrastructure/drizzle-deal-store.ts`). Roll forward only: code from before the migration fails with `contact_cannot_be_enrolled` when it enrolls a contact.

Migration 0026 renames the seeded reply subcategory `customer` from "Customer" to "Existing customer" where the name is still the seeded one. It changes no schema.

Migration 0027 prepares contacts and companies for add, merge and delete ("Contacts and Companies CRUD" in `docs/decisions.md`). `companies` gains `crm_listed_at`, the time the company entered the CRM, which the Companies list reads together with "has a contact". The migration sets it to the earliest `converted_at` of each company that has a contact and leaves a company with only leads null; no trigger writes it later. `companies` also gains `version` (default 0, CHECK `version >= 0`), the optimistic lock that every company write bumps. `people` gains `creation_key`, the idempotency key of the Add contact request (CHECK 8 to 200 characters, unique per organization when set). A new table `company_domain_aliases` holds the other domains a merge gives a company: `(company_id, organization_id)` references `companies` with `ON DELETE CASCADE`, so a deleted company takes its aliases with it, and `(organization_id, domain)` is unique. A domain is either a company domain or an alias in one organization. The application serializes every writer of a domain on an advisory lock; two triggers back it up and raise SQLSTATE 23505 with the constraint names `company_domain_is_alias` (a company insert or domain change onto an alias) and `alias_is_company_domain` (an alias onto a company domain). `identity_exceptions_resolution_ck` now lets a `resolved` row keep its status with a null `resolved_person_id`, so deleting a person who resolved an unmatched sender no longer fails. Seven new indexes cover the foreign keys a contact delete deletes through (`records.latest_inbound_message_id`, `drafts.reply_for_message_id`, `drafts.conversation_id`, `lead_ccs.source_message_id`, `sequence_runs.trigger_message_id`, `sequence_runs.conversation_id`, `sequence_step_runs.sent_message_id`). They use `IF NOT EXISTS`, so on a large database you can build them first with `CREATE INDEX CONCURRENTLY` and the same names (see Organization-scoped indexes below). The column adds hold ACCESS EXCLUSIVE on `companies` and `people`, and the index builds hold off writes to `records`, `drafts`, `lead_ccs`, `sequence_runs` and `sequence_step_runs` until the migration commits. Roll forward only.

Migration 0031 drops `subcategory_sequence_assignments` and `record_sequence_overrides`. Nothing had read or written them since sequences moved onto campaigns, and the drop deletes their legacy rows. Both sat in `INDEX_DEBT`, which now holds 13 tables. Roll forward only.

## Knowledge versions

Migration 0017 adds `knowledge_documents_latest_version_fk`, a foreign key from `(id, latest_version)` to `knowledge_document_versions (document_id, version)`. It is `DEFERRABLE INITIALLY DEFERRED`, so the check runs at commit. Insert a document and its first version in one transaction. A document that commits without the version row, or a `latest_version` that names a missing version, fails with the constraint name. The migration stops and prints a query when it finds such documents already stored. Add the missing version row (or lower `latest_version` to a version that exists) and start again.

Like 0012 and 0014, 0017 runs in one transaction: the `ADD CONSTRAINT` takes `SHARE ROW EXCLUSIVE` on `knowledge_documents` and `knowledge_document_versions` until commit. The tables stay small in practice. On a large database, apply it in a maintenance window.

## Messages update trigger

Migration 0018 rewrites `messages_reject_immutable_update` to compare the columns of `messages` one by one. A column you add to `messages` is not compared until a new migration adds it to the function. `src/platform/db/__tests__/messages-trigger-columns.integration.test.ts` fails when a column is neither compared nor listed as writable.

## Cross-row rules

Migration 0020 adds five triggers for rules a foreign key cannot express. Each raises SQLSTATE 23000 and checks new writes only:

- `classifications.message_id` is an inbound message of the classification's own record.
- `classifications.previous_`, `proposed_` and `applied_subcategory_id` belong to the record's pipeline and to the matching `*_category_key`. A null key accepts any category.
- `drafts.channel` equals the channel of the draft's conversation.
- `drafts.reply_for_message_id` is an inbound message. It may live in another conversation of the same record, because the reply target is the record's latest inbound message.
- `send_attempts.account_ref` equals the account of the draft's conversation, compared with `lower()` on both sides. A blank value goes to `send_attempts_refs_ck`.

A reference to a row that does not exist is left to the foreign key, so its own constraint name appears in the error. The update triggers fire only when a checked column changes, so the `ON DELETE SET NULL` actions from 0012 never trip them.

The migration does not check existing rows. It counts the rows that already break each rule and prints a `NOTICE` with the count. Only the first rule (classification message) and the third (draft channel) add a listing query to the notice; for the other three, write the query from the rule above. Docker may hide `NOTICE` lines in the boot log. Those rows stay until someone updates a checked column on them. Before this release a sequence draft on a LinkedIn conversation was stored with channel `email`; such a draft shows up in the NOTICE.

## Organization-scoped indexes

Migration 0019 adds `grid_jobs_org_status_idx`, `sends_org_status_idx`, `ai_jobs_org_failed_idx` (partial, `status = 'failed'`) and `contact_policies_org_dnc_idx` (partial, `do_not_contact`). Each serves a query that filters one organization without a parent key. The other tables in `INDEX_DEBT` (`src/platform/db/schema-audit.ts`) are reached through an indexed parent key. Only an organization delete would scan them, and organization deletion is disabled in `auth.ts`. Migration 0021 adds `linkedin_search_batches_org_created_idx` and `linkedin_search_queries_org_created_idx` on `(organization_id, created_at)`, which serve `listBatches()` and `list()` in `drizzle-linkedin-search-store.ts`. That leaves 16 tables in `INDEX_DEBT`. The audit test pins that list at 16 names. `send_attempts` stays there: the LinkedIn daily `usage()` count filters by `account_ref` and joins `drafts` by `draft_id`, so no query reads it by organization alone.

Write cost: each index adds one btree insert per row written. `sends` and `grid_jobs` take the most writes. The two partial indexes touch only rows in the matching state. Build lock: `CREATE INDEX` takes a `SHARE` lock that blocks writes until it finishes, and the migrator cannot use `CONCURRENTLY`. On a large database, build the indexes first with `CREATE INDEX CONCURRENTLY` and the same names. Migrations 0019 and 0021 use `IF NOT EXISTS` and skip them.

`IF NOT EXISTS` also skips an index that an interrupted `CREATE INDEX CONCURRENTLY` left behind invalid, and the migration then reports success with an index Postgres never uses. After a manual build, check for invalid indexes and rebuild them:

```sql
select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid where not i.indisvalid;
drop index concurrently "sends_org_status_idx";  -- then create it again with CREATE INDEX CONCURRENTLY
```

## Tenant scope

Every table that holds customer data carries `organization_id uuid not null` with a foreign key to `organizations`. `src/platform/db/__tests__/schema-audit.integration.test.ts` checks this against `information_schema` and fails CI when a new table breaks the rule. The allow-lists in `src/platform/db/schema-audit.ts` name the exceptions and give a reason for each.

## Tables by context

Each context declares its tables in `src/contexts/<context>/infrastructure/schema.ts`. Analytics owns no tables and reads the others through its read model.

- identity: `users`, `sessions`, `accounts`, `verifications`
- tenancy: `organizations`, `members`, `invitations`, `channel_settings`, `audit_log`
- leads: `companies`, `company_domain_aliases`, `people`, `entity_columns`, `import_runs`
- outreach: `mailboxes`, `suppression_list`, `linkedin_accounts`, `linkedin_connect_links`, `campaigns`, `campaign_senders`, `campaign_enrollments`, `linkedin_enrollment_details`, `sends`, `linkedin_connections`, `linkedin_search_batches`, `linkedin_search_queries`, `linkedin_search_results`
- conversations: `pipelines`, `subcategories`, `pipeline_settings`, `records`, `conversations`, `messages`, `contact_policies`, `identity_exceptions`, `lead_ccs`, `events`, `classifications`, `drafts`, `send_attempts`, `knowledge_documents`, `knowledge_document_versions`, `draft_knowledge_citations`, `ai_jobs`, `notes`, `tasks`
- conversations, sequences (`sequences-schema.ts`): `sequences`, `sequence_versions`, `sequence_steps`, `sequence_runs`, `sequence_step_runs`
- deals: `deal_stages`, `deals`
- grid: `grid_folders`, `grid_workbooks`, `grid_tables`, `grid_user_views`, `grid_columns`, `grid_rows`, `grid_cell_runs`, `grid_jobs`, `grid_providers`, `grid_provider_credentials`
- integrations: `integration_accounts`, `integration_credentials`, `inbound_events`
- shared jobs (`src/platform/jobs/schema.ts`): `job_runs`

## Upgrading from before migration 0012

Migration 0012 runs in one transaction. Its `ADD CONSTRAINT` locks last until commit, so writes to the affected tables wait while the validation scans run. On a large database, apply it in a maintenance window.

Migrations 0016 to 0021 hold short locks. 0016 and 0020 create triggers: `CREATE TRIGGER` takes `SHARE ROW EXCLUSIVE` on the table, which blocks writes but not reads, until commit. 0018 only replaces a function and takes no table lock. 0017 adds the foreign key as described under Knowledge versions. 0019 and 0021 build indexes as described under Organization-scoped indexes. All of them run in the same single transaction as any other pending migration, so the locks last until commit.

Migration 0014 (personal campaigns) adds its constraints the same way: one transaction, locks held until commit (`ACCESS EXCLUSIVE` on `campaigns` for the CHECKs, `SHARE ROW EXCLUSIVE` on `conversations` and `campaigns` for the foreign key). On a large database, apply it in a maintenance window too.

The migration sets nullable pointers to null when their target is gone or belongs to another organization, and prints a `NOTICE` with the count. Docker may hide `NOTICE` lines in the boot log. A row it cannot repair, such as a test send whose mailbox is missing, aborts the migration with a message that names the table, constraint and count. Delete or fix those rows by hand, then restart. With `RUN_MIGRATIONS=true` the container restarts until you do.
