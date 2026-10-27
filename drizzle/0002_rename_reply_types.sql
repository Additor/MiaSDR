-- Renames the reply taxonomy to its product names. Nothing changes in behavior.
--   pipelines -> reply_type_sets, subcategories -> reply_types, pipeline_settings -> reply_handling_settings,
--   classifications -> reply_type_picks; category_key -> group_key, subcategory_id -> reply_type_id,
--   pipeline_id -> reply_type_set_id, records.category_source/category_locked -> reply_type_source/reply_type_locked.
-- Keys, checks, triggers and functions take the new table names. The stored events take the new event types
-- (stage.moved -> reply_type.changed, classification.* -> reply_type_pick.*) and the new JSON keys in from_data,
-- to_data and meta. Written by hand: drizzle-kit asks about each rename interactively.

-- ---- Tables
ALTER TABLE "pipelines" RENAME TO "reply_type_sets";--> statement-breakpoint
ALTER TABLE "subcategories" RENAME TO "reply_types";--> statement-breakpoint
ALTER TABLE "pipeline_settings" RENAME TO "reply_handling_settings";--> statement-breakpoint
ALTER TABLE "classifications" RENAME TO "reply_type_picks";--> statement-breakpoint

-- ---- Columns
ALTER TABLE "reply_types" RENAME COLUMN "pipeline_id" TO "reply_type_set_id";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME COLUMN "category_key" TO "group_key";--> statement-breakpoint
ALTER TABLE "reply_handling_settings" RENAME COLUMN "pipeline_id" TO "reply_type_set_id";--> statement-breakpoint
ALTER TABLE "records" RENAME COLUMN "pipeline_id" TO "reply_type_set_id";--> statement-breakpoint
ALTER TABLE "records" RENAME COLUMN "category_key" TO "group_key";--> statement-breakpoint
ALTER TABLE "records" RENAME COLUMN "subcategory_id" TO "reply_type_id";--> statement-breakpoint
ALTER TABLE "records" RENAME COLUMN "category_source" TO "reply_type_source";--> statement-breakpoint
ALTER TABLE "records" RENAME COLUMN "category_locked" TO "reply_type_locked";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME COLUMN "previous_category_key" TO "previous_group_key";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME COLUMN "previous_subcategory_id" TO "previous_reply_type_id";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME COLUMN "proposed_category_key" TO "proposed_group_key";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME COLUMN "proposed_subcategory_id" TO "proposed_reply_type_id";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME COLUMN "applied_category_key" TO "applied_group_key";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME COLUMN "applied_subcategory_id" TO "applied_reply_type_id";--> statement-breakpoint
ALTER TABLE "sequence_runs" RENAME COLUMN "subcategory_id" TO "reply_type_id";--> statement-breakpoint

-- ---- Keys and checks. Postgres cuts a name at 63 bytes; it cuts the long foreign key names on both sides the same way.
ALTER TABLE "reply_type_sets" RENAME CONSTRAINT "pipelines_pkey" TO "reply_type_sets_pkey";--> statement-breakpoint
ALTER TABLE "reply_type_sets" RENAME CONSTRAINT "pipelines_org_name_uq" TO "reply_type_sets_org_name_uq";--> statement-breakpoint
ALTER TABLE "reply_type_sets" RENAME CONSTRAINT "pipelines_id_org_uq" TO "reply_type_sets_id_org_uq";--> statement-breakpoint
ALTER TABLE "reply_type_sets" RENAME CONSTRAINT "pipelines_name_ck" TO "reply_type_sets_name_ck";--> statement-breakpoint
ALTER TABLE "reply_type_sets" RENAME CONSTRAINT "pipelines_organization_id_organizations_id_fk" TO "reply_type_sets_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER INDEX "pipelines_one_default_uq" RENAME TO "reply_type_sets_one_default_uq";--> statement-breakpoint

ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_pkey" TO "reply_types_pkey";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_pipeline_key_uq" TO "reply_types_set_key_uq";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_id_pipeline_category_uq" TO "reply_types_id_set_group_uq";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_id_org_uq" TO "reply_types_id_org_uq";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_category_ck" TO "reply_types_group_ck";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_key_ck" TO "reply_types_key_ck";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_sort_ck" TO "reply_types_sort_ck";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_organization_id_organizations_id_fk" TO "reply_types_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "reply_types" RENAME CONSTRAINT "subcategories_pipeline_id_organization_id_pipelines_id_organization_id_fk" TO "reply_types_reply_type_set_id_organization_id_reply_type_sets_id_organization_id_fk";--> statement-breakpoint

ALTER TABLE "reply_handling_settings" RENAME CONSTRAINT "pipeline_settings_pkey" TO "reply_handling_settings_pkey";--> statement-breakpoint
ALTER TABLE "reply_handling_settings" RENAME CONSTRAINT "pipeline_settings_confidence_ck" TO "reply_handling_settings_confidence_ck";--> statement-breakpoint
ALTER TABLE "reply_handling_settings" RENAME CONSTRAINT "pipeline_settings_instructions_ck" TO "reply_handling_settings_instructions_ck";--> statement-breakpoint
ALTER TABLE "reply_handling_settings" RENAME CONSTRAINT "pipeline_settings_organization_id_organizations_id_fk" TO "reply_handling_settings_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "reply_handling_settings" RENAME CONSTRAINT "pipeline_settings_pipeline_id_organization_id_pipelines_id_organization_id_fk" TO "reply_handling_settings_reply_type_set_id_organization_id_reply_type_sets_id_organization_id_fk";--> statement-breakpoint

ALTER TABLE "records" RENAME CONSTRAINT "records_person_pipeline_uq" TO "records_person_reply_type_set_uq";--> statement-breakpoint
ALTER TABLE "records" RENAME CONSTRAINT "records_category_ck" TO "records_group_ck";--> statement-breakpoint
ALTER TABLE "records" RENAME CONSTRAINT "records_category_source_pair_ck" TO "records_reply_type_source_pair_ck";--> statement-breakpoint
ALTER TABLE "records" RENAME CONSTRAINT "records_subcategory_needs_category_ck" TO "records_reply_type_needs_group_ck";--> statement-breakpoint
ALTER TABLE "records" RENAME CONSTRAINT "records_pipeline_id_organization_id_pipelines_id_organization_id_fk" TO "records_reply_type_set_id_organization_id_reply_type_sets_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "records" RENAME CONSTRAINT "records_subcategory_id_pipeline_id_category_key_subcategories_id_pipeline_id_category_key_fk" TO "records_reply_type_id_reply_type_set_id_group_key_reply_types_id_reply_type_set_id_group_key_fk";--> statement-breakpoint

ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_pkey" TO "reply_type_picks_pkey";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_id_org_uq" TO "reply_type_picks_id_org_uq";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_message_version_uq" TO "reply_type_picks_message_version_uq";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_status_ck" TO "reply_type_picks_status_ck";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_confidence_ck" TO "reply_type_picks_confidence_ck";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_confidence_range_ck" TO "reply_type_picks_confidence_range_ck";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_context_version_ck" TO "reply_type_picks_context_version_ck";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_category_keys_ck" TO "reply_type_picks_group_keys_ck";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_organization_id_organizations_id_fk" TO "reply_type_picks_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_record_id_organization_id_records_id_organization_id_fk" TO "reply_type_picks_record_id_organization_id_records_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_message_id_organization_id_messages_id_organization_id_fk" TO "reply_type_picks_message_id_organization_id_messages_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_previous_subcategory_fk" TO "reply_type_picks_previous_reply_type_fk";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_proposed_subcategory_fk" TO "reply_type_picks_proposed_reply_type_fk";--> statement-breakpoint
ALTER TABLE "reply_type_picks" RENAME CONSTRAINT "classifications_applied_subcategory_fk" TO "reply_type_picks_applied_reply_type_fk";--> statement-breakpoint
ALTER INDEX "classifications_record_created_idx" RENAME TO "reply_type_picks_record_created_idx";--> statement-breakpoint

ALTER TABLE "sequence_runs" RENAME CONSTRAINT "sequence_runs_subcategory_id_organization_id_subcategories_id_organization_id_fk" TO "sequence_runs_reply_type_id_organization_id_reply_types_id_organization_id_fk";--> statement-breakpoint

-- ---- Functions. A trigger holds its function by oid, so a rename keeps every trigger attached. The bodies name tables
-- and columns as text, so each one is written again. No trigger calls classification_subcategory_fits directly, so it is
-- dropped and created under its new name with new parameter names.
DROP FUNCTION public.classification_subcategory_fits(uuid, uuid, uuid, text);--> statement-breakpoint
ALTER FUNCTION public.classifications_validate_message() RENAME TO reply_type_picks_validate_message;--> statement-breakpoint
ALTER FUNCTION public.classifications_validate_subcategories() RENAME TO reply_type_picks_validate_reply_types;--> statement-breakpoint
ALTER FUNCTION public.subcategories_reject_key_change() RENAME TO reply_types_reject_key_change;--> statement-breakpoint

CREATE FUNCTION public.reply_type_pick_type_fits(org uuid, type_set uuid, type_id uuid, grp text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
	-- A reply type that does not exist in the organization is left to the foreign key.
	SELECT type_id IS NULL
		OR NOT EXISTS (SELECT 1 FROM reply_types t WHERE t.id = type_id AND t.organization_id = org)
		OR EXISTS (
			SELECT 1 FROM reply_types t
			WHERE t.id = type_id AND t.organization_id = org AND t.reply_type_set_id = type_set AND (grp IS NULL OR t.group_key = grp));
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reply_type_picks_validate_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	-- A message that does not exist in the organization is left to the foreign key, which names its own constraint.
	IF EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.message_id AND m.organization_id = NEW.organization_id) AND NOT EXISTS (
		SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
		WHERE m.id = NEW.message_id AND m.organization_id = NEW.organization_id AND m.direction = 'inbound' AND c.record_id = NEW.record_id
	) THEN
		RAISE EXCEPTION 'reply_type_picks.message_id must be an inbound message of the pick''s record'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_type_picks', COLUMN = 'message_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reply_type_picks_validate_reply_types() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	type_set uuid;
	moved boolean := TG_OP = 'INSERT';
BEGIN
	IF TG_OP = 'UPDATE' THEN moved := OLD.record_id IS DISTINCT FROM NEW.record_id; END IF;
	SELECT r.reply_type_set_id INTO type_set FROM records r WHERE r.id = NEW.record_id AND r.organization_id = NEW.organization_id;
	IF type_set IS NULL THEN RETURN NEW; END IF; -- the record foreign key reports a missing record
	IF (moved OR NEW.previous_reply_type_id IS DISTINCT FROM OLD.previous_reply_type_id OR NEW.previous_group_key IS DISTINCT FROM OLD.previous_group_key)
		AND NOT reply_type_pick_type_fits(NEW.organization_id, type_set, NEW.previous_reply_type_id, NEW.previous_group_key) THEN
		RAISE EXCEPTION 'reply_type_picks.previous_reply_type_id must belong to the record''s reply type set and to previous_group_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_type_picks', COLUMN = 'previous_reply_type_id';
	END IF;
	IF (moved OR NEW.proposed_reply_type_id IS DISTINCT FROM OLD.proposed_reply_type_id OR NEW.proposed_group_key IS DISTINCT FROM OLD.proposed_group_key)
		AND NOT reply_type_pick_type_fits(NEW.organization_id, type_set, NEW.proposed_reply_type_id, NEW.proposed_group_key) THEN
		RAISE EXCEPTION 'reply_type_picks.proposed_reply_type_id must belong to the record''s reply type set and to proposed_group_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_type_picks', COLUMN = 'proposed_reply_type_id';
	END IF;
	IF (moved OR NEW.applied_reply_type_id IS DISTINCT FROM OLD.applied_reply_type_id OR NEW.applied_group_key IS DISTINCT FROM OLD.applied_group_key)
		AND NOT reply_type_pick_type_fits(NEW.organization_id, type_set, NEW.applied_reply_type_id, NEW.applied_group_key) THEN
		RAISE EXCEPTION 'reply_type_picks.applied_reply_type_id must belong to the record''s reply type set and to applied_group_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_type_picks', COLUMN = 'applied_reply_type_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reply_types_reject_key_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	RAISE EXCEPTION 'reply_types keys are immutable: key, group_key and reply_type_set_id cannot change'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_types';
END $$;--> statement-breakpoint

-- ---- Triggers. Their column lists and WHEN clauses follow the column renames on their own.
ALTER TRIGGER "classifications_message_ins_trg" ON "reply_type_picks" RENAME TO "reply_type_picks_message_ins_trg";--> statement-breakpoint
ALTER TRIGGER "classifications_message_upd_trg" ON "reply_type_picks" RENAME TO "reply_type_picks_message_upd_trg";--> statement-breakpoint
ALTER TRIGGER "classifications_subcategories_ins_trg" ON "reply_type_picks" RENAME TO "reply_type_picks_reply_types_ins_trg";--> statement-breakpoint
ALTER TRIGGER "classifications_subcategories_upd_trg" ON "reply_type_picks" RENAME TO "reply_type_picks_reply_types_upd_trg";--> statement-breakpoint
ALTER TRIGGER "subcategories_keys_trg" ON "reply_types" RENAME TO "reply_types_keys_trg";--> statement-breakpoint

-- ---- Stored events. events_no_update_trg keeps events append-only, so it is off for these two statements only; the
-- ALTER TABLE lock keeps every other writer out until the trigger is back on.
ALTER TABLE "events" DISABLE TRIGGER "events_no_update_trg";--> statement-breakpoint
UPDATE "events" SET
	"event_type" = CASE "event_type" WHEN 'stage.moved' THEN 'reply_type.changed' ELSE 'reply_type_pick.' || substr("event_type", length('classification.') + 1) END,
	"from_data" = CASE WHEN jsonb_typeof("from_data") = 'object' THEN (
		SELECT coalesce(jsonb_object_agg(CASE e.key
			WHEN 'categoryKey' THEN 'groupKey' WHEN 'subcategoryId' THEN 'replyTypeId'
			WHEN 'categorySource' THEN 'replyTypeSource' WHEN 'categoryLocked' THEN 'replyTypeLocked' ELSE e.key END, e.value), '{}'::jsonb)
		FROM jsonb_each("from_data") e) ELSE "from_data" END,
	"to_data" = CASE WHEN jsonb_typeof("to_data") = 'object' THEN (
		SELECT coalesce(jsonb_object_agg(CASE e.key
			WHEN 'categoryKey' THEN 'groupKey' WHEN 'subcategoryId' THEN 'replyTypeId'
			WHEN 'categorySource' THEN 'replyTypeSource' WHEN 'categoryLocked' THEN 'replyTypeLocked' ELSE e.key END, e.value), '{}'::jsonb)
		FROM jsonb_each("to_data") e) ELSE "to_data" END,
	"meta" = CASE WHEN "meta" ? 'classificationId' THEN ("meta" - 'classificationId') || jsonb_build_object('replyTypePickId', "meta" -> 'classificationId') ELSE "meta" END
WHERE "event_type" = 'stage.moved' OR "event_type" LIKE 'classification.%';--> statement-breakpoint
ALTER TABLE "events" ENABLE TRIGGER "events_no_update_trg";
