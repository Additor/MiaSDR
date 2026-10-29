-- Guards the code relied on without the database holding them. A retried send may take any next attempt number: the
-- enrollment owns the cap, so the trigger keeps only the +1 step. A send in flight or unresolved cannot be deleted, and
-- an enrollment no longer drops its sends by cascade, so each delete of a send passes that guard. ai_jobs,
-- sequence_step_runs and inbound_events get a claim token for fencing a worker that lost its claim. A conversation holds
-- at most one draft in flight. Written by hand around the drizzle-kit output: the triggers and the preflight are not in
-- the schema.

-- ---- A failed send goes back to sending only as the next attempt. The cap lives in the enrollment.
CREATE OR REPLACE FUNCTION public.sends_reject_final_status_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
		RETURN NEW;
	END IF;
	IF OLD.status = 'failed' AND NEW.status = 'sending' AND NEW.attempt = OLD.attempt + 1 THEN
		RETURN NEW;
	END IF;
	IF OLD.status IN ('sent', 'failed') THEN
		RAISE EXCEPTION 'sends status % is final and cannot change to %', OLD.status, NEW.status
			USING ERRCODE = 'check_violation', TABLE = 'sends';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint

-- ---- Claim tokens. Null until a worker claims the row; old rows stay null.
ALTER TABLE "inbound_events" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD COLUMN "claim_token" uuid;--> statement-breakpoint

-- ---- An enrollment keeps its sends: a delete removes them first, through the guard below. NOT VALID skips a scan of
-- sends under the lock the drop takes: every row already matched the same key under the old constraint, and Postgres
-- checks new rows either way.
ALTER TABLE "sends" DROP CONSTRAINT "sends_enrollment_id_organization_id_campaign_enrollments_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_enrollment_id_organization_id_campaign_enrollments_id_organization_id_fk" FOREIGN KEY ("enrollment_id","organization_id") REFERENCES "public"."campaign_enrollments"("id","organization_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint

-- ---- A send in flight (sending) or unresolved (unknown) stays. Deleting the organization cascades past the guard.
CREATE FUNCTION public.sends_reject_unsettled_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF pg_trigger_depth() > 1 THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'sends row % is % and cannot be deleted until it settles', OLD.id, OLD.status
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'sends';
END $$;--> statement-breakpoint
CREATE TRIGGER sends_unsettled_no_delete_trg BEFORE DELETE ON public.sends FOR EACH ROW WHEN ((old.status = ANY (ARRAY['sending'::text, 'unknown'::text]))) EXECUTE FUNCTION public.sends_reject_unsettled_delete();--> statement-breakpoint

-- ---- One draft in flight per conversation. Only a send attempt settles an in-flight draft, so the migration stops on a
-- conversation that holds two and leaves the rows for a person to settle.
DO $$
DECLARE
	found text;
BEGIN
	SELECT string_agg(conversation_id::text || ': ' || ids, '; ') INTO found
	FROM (
		SELECT conversation_id, string_agg(id::text, ', ' ORDER BY id) AS ids
		FROM drafts WHERE status IN ('sending', 'delivery_uncertain')
		GROUP BY conversation_id HAVING count(*) > 1
	) d;
	IF found IS NOT NULL THEN
		RAISE EXCEPTION 'conversations hold more than one draft in flight (conversation: drafts): %', found
			USING ERRCODE = 'unique_violation', TABLE = 'drafts';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drafts_one_in_flight_uq" ON "drafts" USING btree ("conversation_id") WHERE "drafts"."status" in ('sending', 'delivery_uncertain');
