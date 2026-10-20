-- T8b-immutability (rest of DB-010): rows that other rows point at by value or by version must not change under them.
-- Hand-written, no table changes, like 0008 and 0013.
--
--   * conversations: channel, account_ref, provider_thread_id and provider_contact_id are the thread's identity. Messages
--     repeat channel and account_ref, and the inbound lookup finds the thread by (channel, account_ref, provider_thread_id).
--     status, private_campaign_id, record_id and updated_at stay writable.
--   * subcategories: key, category_key and pipeline_id. Classifications and records store the keys by value.
--   * knowledge_document_versions: append-only. A draft cites a version id, so its text must stay as it was.
--   * sequence_versions and sequence_steps: a published version is frozen. Runs are pinned to it. The draft-to-published
--     transition stays legal, and so does deleting a published version through the cascade from its sequence.
--
-- Every UPDATE trigger is BEFORE UPDATE OF <columns> ... WHEN (<column> IS DISTINCT FROM ...), so an update that does not
-- touch the columns, or writes the same value back, costs one comparison. No foreign key action writes these columns: the
-- only SET NULL actions in the schema target other columns (the test pins that with a pg_constraint scan).
CREATE FUNCTION "conversations_reject_identity_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'conversations identity is immutable: channel, account_ref, provider_thread_id and provider_contact_id cannot change'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'conversations';
END $$;--> statement-breakpoint
CREATE TRIGGER "conversations_identity_trg" BEFORE UPDATE OF "channel", "account_ref", "provider_thread_id", "provider_contact_id" ON "conversations"
	FOR EACH ROW WHEN (
		OLD."channel" IS DISTINCT FROM NEW."channel"
		OR OLD."account_ref" IS DISTINCT FROM NEW."account_ref"
		OR OLD."provider_thread_id" IS DISTINCT FROM NEW."provider_thread_id"
		OR OLD."provider_contact_id" IS DISTINCT FROM NEW."provider_contact_id"
	) EXECUTE FUNCTION "conversations_reject_identity_change"();--> statement-breakpoint
CREATE FUNCTION "subcategories_reject_key_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'subcategories keys are immutable: key, category_key and pipeline_id cannot change'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'subcategories';
END $$;--> statement-breakpoint
CREATE TRIGGER "subcategories_keys_trg" BEFORE UPDATE OF "key", "category_key", "pipeline_id" ON "subcategories"
	FOR EACH ROW WHEN (
		OLD."key" IS DISTINCT FROM NEW."key"
		OR OLD."category_key" IS DISTINCT FROM NEW."category_key"
		OR OLD."pipeline_id" IS DISTINCT FROM NEW."pipeline_id"
	) EXECUTE FUNCTION "subcategories_reject_key_change"();--> statement-breakpoint
CREATE FUNCTION "knowledge_versions_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'knowledge_document_versions is append-only: rows cannot be updated, insert a new version instead'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'knowledge_document_versions';
END $$;--> statement-breakpoint
CREATE TRIGGER "knowledge_versions_no_update_trg" BEFORE UPDATE ON "knowledge_document_versions"
	FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION "knowledge_versions_reject_update"();--> statement-breakpoint
-- Same delete rule as the ledgers (0013): a cascade from the document or the organization passes, a direct delete needs
-- the transaction-local purge flag.
CREATE TRIGGER "knowledge_versions_no_delete_trg" BEFORE DELETE ON "knowledge_document_versions"
	FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();--> statement-breakpoint
CREATE FUNCTION "sequence_versions_reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
		OR OLD.sequence_id IS DISTINCT FROM NEW.sequence_id
		OR OLD.version IS DISTINCT FROM NEW.version THEN
		RAISE EXCEPTION 'sequence_versions identity is immutable: organization_id, sequence_id and version cannot change'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sequence_versions';
	END IF;
	IF OLD.status = 'published' THEN
		RAISE EXCEPTION 'a published sequence version is frozen: status and published_at cannot change'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sequence_versions';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "sequence_versions_frozen_trg" BEFORE UPDATE OF "organization_id", "sequence_id", "version", "status", "published_at" ON "sequence_versions"
	FOR EACH ROW WHEN (
		OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
		OR OLD."sequence_id" IS DISTINCT FROM NEW."sequence_id"
		OR OLD."version" IS DISTINCT FROM NEW."version"
		OR OLD."status" IS DISTINCT FROM NEW."status"
		OR OLD."published_at" IS DISTINCT FROM NEW."published_at"
	) EXECUTE FUNCTION "sequence_versions_reject_change"();--> statement-breakpoint
CREATE FUNCTION "sequence_versions_reject_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF pg_trigger_depth() > 1 OR current_setting('miasdr.allow_purge', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'a published sequence version cannot be deleted directly (delete the sequence, or set miasdr.allow_purge to on inside a transaction)'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sequence_versions';
END $$;--> statement-breakpoint
CREATE TRIGGER "sequence_versions_no_delete_trg" BEFORE DELETE ON "sequence_versions"
	FOR EACH ROW WHEN (OLD."status" = 'published') EXECUTE FUNCTION "sequence_versions_reject_delete"();--> statement-breakpoint
-- Steps carry the content of a version. Insert, update and delete are refused while the owning version is published.
-- During a cascade delete the version row is already gone (the lookup finds nothing) or pg_trigger_depth() > 1.
CREATE FUNCTION "sequence_steps_reject_published_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	old_version uuid;
	new_version uuid;
	frozen boolean;
BEGIN
	IF TG_OP <> 'INSERT' THEN old_version := OLD.sequence_version_id; END IF;
	IF TG_OP <> 'DELETE' THEN new_version := NEW.sequence_version_id; END IF;
	IF TG_OP = 'DELETE' AND (pg_trigger_depth() > 1 OR current_setting('miasdr.allow_purge', true) = 'on') THEN
		RETURN OLD;
	END IF;
	SELECT EXISTS (SELECT 1 FROM sequence_versions v WHERE v.status = 'published' AND v.id IN (old_version, new_version)) INTO frozen;
	IF frozen THEN
		RAISE EXCEPTION 'sequence_steps of a published sequence version are frozen: edit a new draft instead'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sequence_steps';
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "sequence_steps_frozen_trg" BEFORE INSERT OR UPDATE OR DELETE ON "sequence_steps"
	FOR EACH ROW EXECUTE FUNCTION "sequence_steps_reject_published_change"();
