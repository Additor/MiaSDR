-- T8-fks-checks (DB-008, DB-009): thirteen missing foreign keys and the business CHECK constraints. Written by
-- `drizzle-kit generate` from the TS schema, then edited by hand:
--   * named constraints, short enough that Postgres does not truncate them;
--   * `ON DELETE SET NULL (column)` (Postgres 15) so organization_id stays set when the pointer is nulled;
--   * a pre-check before each constraint: a nullable reference whose parent is missing (or belongs to another
--     organization) is set to null with a NOTICE that names the count; anything else aborts with a message that names
--     the table, the problem, the count and a query that lists the rows. The migrator runs every pending migration in
--     one transaction, so an abort leaves nothing from this file behind;
--   * every constraint is added NOT VALID and validated afterwards. The migrator runs all pending migrations in one transaction, so the ADD CONSTRAINT locks (ACCESS EXCLUSIVE for a CHECK, SHARE ROW EXCLUSIVE for a foreign key) last until commit. On a large table, run it in a maintenance window.
-- Two keys exist only here (Drizzle cannot express them in the TS schema, reasons in the schema files):
-- records.latest_inbound_message_id and import_runs.destination_campaign_id.
-- Left out on purpose: knowledge_documents.latest_version -> knowledge_document_versions. It needs a DEFERRABLE key and
-- the document and its first version in one transaction. The application does that, but integration tests and the route
-- matrix seeder insert the two rows in separate statements, and they must pass unchanged.

CREATE FUNCTION pg_temp.t8_abort_if_rows(problem text, count_sql text, list_sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
	EXECUTE count_sql INTO n;
	IF n > 0 THEN
		RAISE EXCEPTION 'Migration 0012 stopped: % row(s) %. List them with: %. Fix them, then run the migration again.', n, problem, list_sql;
	END IF;
END $$;--> statement-breakpoint
CREATE FUNCTION pg_temp.t8_null_orphans(child regclass, col text, parent regclass, parent_key text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
	EXECUTE format(
		'UPDATE %s c SET %I = NULL WHERE c.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s p WHERE p.%I = c.%I AND p.organization_id = c.organization_id)',
		child, col, col, parent, parent_key, col);
	GET DIAGNOSTICS n = ROW_COUNT;
	IF n > 0 THEN
		RAISE NOTICE 'Migration 0012: set %.% to null on % row(s) whose % row is missing or belongs to another organization.', child, col, n, parent;
	END IF;
END $$;--> statement-breakpoint
-- Validates a CHECK that was added NOT VALID. It counts the violating rows from the constraint's own definition first, so
-- the failure names the table, the constraint and the count instead of a bare check_violation.
CREATE FUNCTION pg_temp.t8_validate_check(tbl regclass, cname text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE def text; expr text; n bigint;
BEGIN
	SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = tbl AND conname = cname;
	expr := regexp_replace(regexp_replace(def, '^CHECK ', ''), ' NOT VALID$', '');
	EXECUTE format('SELECT count(*) FROM %s WHERE (%s) IS FALSE', tbl, expr) INTO n;
	IF n > 0 THEN
		RAISE EXCEPTION 'Migration 0012 stopped: % row(s) in % violate the new constraint %. List them with: SELECT * FROM % WHERE NOT (%). Fix them, then run the migration again.', n, tbl, cname, tbl, expr;
	END IF;
	EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', tbl, cname);
END $$;--> statement-breakpoint

-- Pre-checks for the foreign keys.
SELECT pg_temp.t8_abort_if_rows(
	'are test sends whose mailbox no longer exists (a test send needs its mailbox)',
	'SELECT count(*) FROM sends s WHERE s.kind = ''test'' AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.id = s.mailbox_id AND m.organization_id = s.organization_id)',
	'SELECT id FROM sends s WHERE kind = ''test'' AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.id = s.mailbox_id AND m.organization_id = s.organization_id)');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('classifications', 'previous_subcategory_id', 'subcategories', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('classifications', 'proposed_subcategory_id', 'subcategories', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('classifications', 'applied_subcategory_id', 'subcategories', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('drafts', 'reply_for_message_id', 'messages', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('records', 'latest_inbound_message_id', 'messages', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('sends', 'mailbox_id', 'mailboxes', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('sends', 'taken_over_from_mailbox_id', 'mailboxes', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('sends', 'linkedin_account_id', 'linkedin_accounts', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('linkedin_connections', 'enrollment_id', 'campaign_enrollments', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('linkedin_search_queries', 'current_account_id', 'linkedin_accounts', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('notes', 'record_id', 'records', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('tasks', 'record_id', 'records', 'id');--> statement-breakpoint
SELECT pg_temp.t8_null_orphans('import_runs', 'destination_campaign_id', 'campaigns', 'id');--> statement-breakpoint

-- Foreign keys, NOT VALID first.
ALTER TABLE "linkedin_connections" ADD CONSTRAINT "linkedin_connections_enrollment_fk" FOREIGN KEY ("enrollment_id", "organization_id") REFERENCES "campaign_enrollments" ("id", "organization_id") ON DELETE SET NULL ("enrollment_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_current_account_fk" FOREIGN KEY ("current_account_id", "organization_id") REFERENCES "linkedin_accounts" ("id", "organization_id") ON DELETE SET NULL ("current_account_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_mailbox_fk" FOREIGN KEY ("mailbox_id", "organization_id") REFERENCES "mailboxes" ("id", "organization_id") ON DELETE NO ACTION NOT VALID;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_taken_over_mailbox_fk" FOREIGN KEY ("taken_over_from_mailbox_id", "organization_id") REFERENCES "mailboxes" ("id", "organization_id") ON DELETE NO ACTION NOT VALID;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_linkedin_account_fk" FOREIGN KEY ("linkedin_account_id", "organization_id") REFERENCES "linkedin_accounts" ("id", "organization_id") ON DELETE NO ACTION NOT VALID;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_previous_subcategory_fk" FOREIGN KEY ("previous_subcategory_id", "organization_id") REFERENCES "subcategories" ("id", "organization_id") ON DELETE SET NULL ("previous_subcategory_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_proposed_subcategory_fk" FOREIGN KEY ("proposed_subcategory_id", "organization_id") REFERENCES "subcategories" ("id", "organization_id") ON DELETE SET NULL ("proposed_subcategory_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_applied_subcategory_fk" FOREIGN KEY ("applied_subcategory_id", "organization_id") REFERENCES "subcategories" ("id", "organization_id") ON DELETE SET NULL ("applied_subcategory_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_reply_message_fk" FOREIGN KEY ("reply_for_message_id", "organization_id") REFERENCES "messages" ("id", "organization_id") ON DELETE SET NULL ("reply_for_message_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_record_fk" FOREIGN KEY ("record_id", "organization_id") REFERENCES "records" ("id", "organization_id") ON DELETE SET NULL ("record_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_record_fk" FOREIGN KEY ("record_id", "organization_id") REFERENCES "records" ("id", "organization_id") ON DELETE SET NULL ("record_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_latest_inbound_message_fk" FOREIGN KEY ("latest_inbound_message_id", "organization_id") REFERENCES "messages" ("id", "organization_id") ON DELETE SET NULL ("latest_inbound_message_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_destination_campaign_fk" FOREIGN KEY ("destination_campaign_id", "organization_id") REFERENCES "campaigns" ("id", "organization_id") ON DELETE SET NULL ("destination_campaign_id") NOT VALID;--> statement-breakpoint

-- Validate the foreign keys. The pre-checks above leave no orphan, so these only scan.
ALTER TABLE "linkedin_connections" VALIDATE CONSTRAINT "linkedin_connections_enrollment_fk";--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" VALIDATE CONSTRAINT "linkedin_search_queries_current_account_fk";--> statement-breakpoint
ALTER TABLE "sends" VALIDATE CONSTRAINT "sends_mailbox_fk";--> statement-breakpoint
ALTER TABLE "sends" VALIDATE CONSTRAINT "sends_taken_over_mailbox_fk";--> statement-breakpoint
ALTER TABLE "sends" VALIDATE CONSTRAINT "sends_linkedin_account_fk";--> statement-breakpoint
ALTER TABLE "classifications" VALIDATE CONSTRAINT "classifications_previous_subcategory_fk";--> statement-breakpoint
ALTER TABLE "classifications" VALIDATE CONSTRAINT "classifications_proposed_subcategory_fk";--> statement-breakpoint
ALTER TABLE "classifications" VALIDATE CONSTRAINT "classifications_applied_subcategory_fk";--> statement-breakpoint
ALTER TABLE "drafts" VALIDATE CONSTRAINT "drafts_reply_message_fk";--> statement-breakpoint
ALTER TABLE "notes" VALIDATE CONSTRAINT "notes_record_fk";--> statement-breakpoint
ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_record_fk";--> statement-breakpoint
ALTER TABLE "records" VALIDATE CONSTRAINT "records_latest_inbound_message_fk";--> statement-breakpoint
ALTER TABLE "import_runs" VALIDATE CONSTRAINT "import_runs_destination_campaign_fk";--> statement-breakpoint

-- CHECK constraints, NOT VALID first, then counted and validated.
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_attempts_range_ck" CHECK ("ai_jobs"."attempts" >= 0 and "ai_jobs"."max_attempts" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_completion_ck" CHECK ("ai_jobs"."status" not in ('succeeded', 'skipped') or "ai_jobs"."completed_at" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_confidence_range_ck" CHECK ("classifications"."confidence" is null or "classifications"."confidence" between 0 and 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_context_version_ck" CHECK ("classifications"."expected_context_version" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_category_keys_ck" CHECK (("classifications"."previous_category_key" is null or "classifications"."previous_category_key" in ('customer', 'interested', 'not_interested', 'other'))
        and ("classifications"."proposed_category_key" is null or "classifications"."proposed_category_key" in ('customer', 'interested', 'not_interested', 'other'))
        and ("classifications"."applied_category_key" is null or "classifications"."applied_category_key" in ('customer', 'interested', 'not_interested', 'other'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_ref_ck" CHECK (length(btrim("conversations"."account_ref")) > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_context_version_ck" CHECK ("drafts"."expected_context_version" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_ck" CHECK (length(btrim("events"."event_type")) > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_channel_ck" CHECK ("identity_exceptions"."channel" in ('email', 'linkedin', 'whatsapp')) NOT VALID;--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_keys_ck" CHECK (length(btrim("identity_exceptions"."account_ref")) > 0 and length(btrim("identity_exceptions"."source_event_key")) > 0 and length(btrim("identity_exceptions"."reason")) > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_keys_ck" CHECK (length(btrim("messages"."idempotency_key")) > 0 and length(btrim("messages"."account_ref")) > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "pipeline_settings" ADD CONSTRAINT "pipeline_settings_instructions_ck" CHECK (jsonb_typeof("pipeline_settings"."draft_instructions") = 'array' and jsonb_typeof("pipeline_settings"."classification_instructions") = 'array'
        and length("pipeline_settings"."draft_instructions"::text) <= 100000 and length("pipeline_settings"."classification_instructions"::text) <= 100000) NOT VALID;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_active_channel_ck" CHECK ("records"."active_channel" is null or "records"."active_channel" in ('email', 'linkedin', 'whatsapp')) NOT VALID;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_refs_ck" CHECK (length(btrim("send_attempts"."idempotency_key")) > 0
        and ("send_attempts"."request_id" is null or length(btrim("send_attempts"."request_id")) > 0)
        and ("send_attempts"."provider" is null or length(btrim("send_attempts"."provider")) > 0)
        and ("send_attempts"."account_ref" is null or length(btrim("send_attempts"."account_ref")) > 0)) NOT VALID;--> statement-breakpoint
SELECT pg_temp.t8_validate_check('ai_jobs', 'ai_jobs_attempts_range_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('ai_jobs', 'ai_jobs_completion_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('classifications', 'classifications_confidence_range_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('classifications', 'classifications_context_version_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('classifications', 'classifications_category_keys_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('conversations', 'conversations_account_ref_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('drafts', 'drafts_context_version_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('events', 'events_type_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('identity_exceptions', 'identity_exceptions_channel_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('identity_exceptions', 'identity_exceptions_keys_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('messages', 'messages_keys_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('pipeline_settings', 'pipeline_settings_instructions_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('records', 'records_active_channel_ck');--> statement-breakpoint
SELECT pg_temp.t8_validate_check('send_attempts', 'send_attempts_refs_ck');
