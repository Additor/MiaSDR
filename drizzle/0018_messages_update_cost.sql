-- T8b-trigger-cost: messages_reject_immutable_update (0013) compared to_jsonb(NEW) with to_jsonb(OLD), which serializes the
-- whole row, including body_text, body_html and raw, twice for every update. markRead and setMessageImportant touch only
-- `important` or `opened_at`, so those updates paid for the largest columns of the row. This version compares column by
-- column with IS DISTINCT FROM and stops at the first change. The rule stays the same: only `important` and `opened_at` may change.
--
-- A column added to messages later is NOT compared by this function until someone adds it here. The guard test
-- src/platform/db/messages-trigger-columns.integration.test.ts lists information_schema.columns and fails for a column that
-- is neither compared in this definition nor named in its allow-list.
-- CREATE OR REPLACE keeps the trigger messages_immutable_trg (0013) attached.
CREATE OR REPLACE FUNCTION "messages_reject_immutable_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
		OR NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id"
		OR NEW."channel" IS DISTINCT FROM OLD."channel"
		OR NEW."account_ref" IS DISTINCT FROM OLD."account_ref"
		OR NEW."direction" IS DISTINCT FROM OLD."direction"
		OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
		OR NEW."provider_message_id" IS DISTINCT FROM OLD."provider_message_id"
		OR NEW."subject" IS DISTINCT FROM OLD."subject"
		OR NEW."from_address" IS DISTINCT FROM OLD."from_address"
		OR NEW."to_address" IS DISTINCT FROM OLD."to_address"
		OR NEW."cc" IS DISTINCT FROM OLD."cc"
		OR NEW."body_text" IS DISTINCT FROM OLD."body_text"
		OR NEW."body_html" IS DISTINCT FROM OLD."body_html"
		OR NEW."raw" IS DISTINCT FROM OLD."raw"
		OR NEW."sent_at" IS DISTINCT FROM OLD."sent_at"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'messages is append-only: only important and opened_at can change'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'messages';
	END IF;
	RETURN NEW;
END $$;
