-- T8-triggers (DB-010 core): `events`, `audit_log` and `messages` are append-only. Hand-written, no table changes, like 0008.
--
-- Updates
--   * events, audit_log: always raise, except the foreign key action that sets actor_user_id to null when a user is
--     deleted. That action runs inside the referential trigger (pg_trigger_depth() > 1) and changes nothing else.
--   * messages: raise unless only `important` or `opened_at` changed (setMessageImportant and markRead write those two).
-- Deletes (all three tables)
--   * raise, unless the delete runs inside another trigger (pg_trigger_depth() > 1: the cascade from organizations), or the
--     transaction set `miasdr.allow_purge` to 'on': select set_config('miasdr.allow_purge', 'on', true).
--   * the retention job (src/platform/jobs/prune.ts) never touches these tables. The setting is the hook for a future one.
-- TRUNCATE is not guarded: it needs table ownership, which the application role does not use.
CREATE FUNCTION "ledger_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF pg_trigger_depth() > 1 AND NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
		AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION '% is append-only: rows cannot be updated', TG_TABLE_NAME
		USING ERRCODE = 'integrity_constraint_violation', TABLE = TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE FUNCTION "messages_reject_immutable_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (to_jsonb(NEW) - 'important' - 'opened_at') = (to_jsonb(OLD) - 'important' - 'opened_at') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'messages is append-only: only important and opened_at can change'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'messages';
END $$;--> statement-breakpoint
CREATE FUNCTION "ledger_reject_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF pg_trigger_depth() > 1 OR current_setting('miasdr.allow_purge', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION '% is append-only: rows cannot be deleted directly (set miasdr.allow_purge to on inside a transaction to purge)', TG_TABLE_NAME
		USING ERRCODE = 'integrity_constraint_violation', TABLE = TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER "events_no_update_trg" BEFORE UPDATE ON "events" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_update"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update_trg" BEFORE UPDATE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_update"();--> statement-breakpoint
CREATE TRIGGER "messages_immutable_trg" BEFORE UPDATE ON "messages" FOR EACH ROW EXECUTE FUNCTION "messages_reject_immutable_update"();--> statement-breakpoint
CREATE TRIGGER "events_no_delete_trg" BEFORE DELETE ON "events" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_delete_trg" BEFORE DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "messages_no_delete_trg" BEFORE DELETE ON "messages" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();
