-- Hand-written, no table changes: a final status is never left. Mirrors SEND_FINAL (src/contexts/outreach/domain/send-status.ts)
-- and ATTEMPT_FINAL (src/contexts/conversations/domain/send-attempt-status.ts). The stores already filter every UPDATE
-- on the allowed source statuses, so these triggers only catch a writer that skips the filter. An UPDATE that keeps the
-- status (sent -> sent, a changed error or body) passes.
--
-- One legitimate exit exists: the engines re-claim a failed send in the same statement that claims a step
-- (insert ... on conflict (enrollment_id, step_number) do update set status = 'sending', attempt = attempt + 1
-- where status = 'failed' and attempt < 3). The sends trigger lets exactly that move through.
CREATE FUNCTION "sends_reject_final_status_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
		RETURN NEW;
	END IF;
	IF OLD.status = 'failed' AND NEW.status = 'sending' AND OLD.attempt < 3 AND NEW.attempt = OLD.attempt + 1 THEN
		RETURN NEW;
	END IF;
	IF OLD.status IN ('sent', 'failed') THEN
		RAISE EXCEPTION 'sends status % is final and cannot change to %', OLD.status, NEW.status
			USING ERRCODE = 'check_violation', TABLE = 'sends';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION "send_attempts_reject_final_status_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status IN ('sent', 'reconciled', 'failed') THEN
		RAISE EXCEPTION 'send_attempts status % is final and cannot change to %', OLD.status, NEW.status
			USING ERRCODE = 'check_violation', TABLE = 'send_attempts';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "sends_final_status_trg" BEFORE UPDATE OF "status" ON "sends" FOR EACH ROW EXECUTE FUNCTION "sends_reject_final_status_change"();--> statement-breakpoint
CREATE TRIGGER "send_attempts_final_status_trg" BEFORE UPDATE OF "status" ON "send_attempts" FOR EACH ROW EXECUTE FUNCTION "send_attempts_reject_final_status_change"();
