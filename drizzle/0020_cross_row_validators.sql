-- T8b-validators (DB-011): cross-row rules that a foreign key cannot express. Hand-written, no table changes.
--
--   1. classifications: message_id is an inbound message of the classification's own record.
--   2. classifications: previous, proposed and applied subcategory belong to the record's pipeline, and to the matching
--      *_category_key when that key is set (a null key tolerates any category).
--   3. drafts: channel equals the channel of the draft's conversation.
--   4. drafts: reply_for_message_id, when set, is an inbound message of the same organization. NOT "of the same
--      conversation": thread-context.ts sets it to the record's latest inbound message, which can live in another
--      conversation of the record (an email thread and a LinkedIn chat of one person).
--   5. send_attempts: account_ref, when set, equals the account of the draft's conversation, compared with lower() on both
--      sides (drizzle-reply-store.ts lowercases the mailbox address it stores; LinkedIn stores the account id).
--
-- Shape of every rule: one function, one BEFORE INSERT trigger, and one BEFORE UPDATE OF <columns> trigger with
-- WHEN (OLD.col IS DISTINCT FROM NEW.col OR ...). PostgreSQL does not allow OLD in the WHEN clause of an INSERT trigger,
-- so the two events need two triggers. The function also re-checks only the columns that changed, so an update that
-- touches nothing a rule reads (status, revision, ...) never runs it, and a foreign key action cannot trip it:
-- ON DELETE SET NULL (column) from 0012 writes NULL, and a NULL reference has nothing to validate.
--
-- Existing rows: the migration counts the rows that already break each rule and reports them with RAISE NOTICE. It never
-- aborts and never changes data. The triggers check new writes only (like a NOT VALID constraint); legacy rows stay as
-- they are until someone updates the checked columns. A NOTICE with count 0 is not printed.
--
-- Lock: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table until the transaction commits (the migrator runs all
-- pending migrations in one). The pre-flight scans read each table once.
DO $$
DECLARE
	n bigint;
BEGIN
	SELECT count(*) INTO n FROM classifications k
	WHERE EXISTS (SELECT 1 FROM messages m WHERE m.id = k.message_id AND m.organization_id = k.organization_id) AND NOT EXISTS (
		SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
		WHERE m.id = k.message_id AND m.organization_id = k.organization_id AND m.direction = 'inbound' AND c.record_id = k.record_id);
	IF n > 0 THEN
		RAISE NOTICE 'Migration 0020: % classification(s) point at a message that is not an inbound message of their record. They stay; new writes are checked. List: SELECT k.id FROM classifications k WHERE NOT EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = k.message_id AND m.direction = ''inbound'' AND c.record_id = k.record_id)', n;
	END IF;

	SELECT count(*) INTO n FROM classifications k JOIN records r ON r.id = k.record_id AND r.organization_id = k.organization_id
	WHERE EXISTS (
		SELECT 1 FROM (VALUES (k.previous_subcategory_id, k.previous_category_key), (k.proposed_subcategory_id, k.proposed_category_key), (k.applied_subcategory_id, k.applied_category_key)) AS v(sub_id, cat_key)
		WHERE v.sub_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM subcategories s WHERE s.id = v.sub_id AND s.organization_id = k.organization_id AND s.pipeline_id = r.pipeline_id
				AND (v.cat_key IS NULL OR s.category_key = v.cat_key)));
	IF n > 0 THEN
		RAISE NOTICE 'Migration 0020: % classification(s) hold a subcategory outside the record''s pipeline or category. They stay; new writes are checked.', n;
	END IF;

	SELECT count(*) INTO n FROM drafts d JOIN conversations c ON c.id = d.conversation_id AND c.organization_id = d.organization_id WHERE c.channel <> d.channel;
	IF n > 0 THEN
		RAISE NOTICE 'Migration 0020: % draft(s) have a channel that differs from their conversation (sequence drafts on LinkedIn threads were written as email before this release). They stay; new writes are checked. List: SELECT d.id, d.channel, c.channel FROM drafts d JOIN conversations c ON c.id = d.conversation_id WHERE c.channel <> d.channel', n;
	END IF;

	SELECT count(*) INTO n FROM drafts d
	WHERE d.reply_for_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.id = d.reply_for_message_id AND m.organization_id = d.organization_id AND m.direction <> 'inbound');
	IF n > 0 THEN
		RAISE NOTICE 'Migration 0020: % draft(s) reply to a message that is not inbound. They stay; new writes are checked.', n;
	END IF;

	SELECT count(*) INTO n FROM send_attempts a
	JOIN drafts d ON d.id = a.draft_id AND d.organization_id = a.organization_id
	JOIN conversations c ON c.id = d.conversation_id AND c.organization_id = d.organization_id
	WHERE a.account_ref IS NOT NULL AND lower(a.account_ref) <> lower(c.account_ref);
	IF n > 0 THEN
		RAISE NOTICE 'Migration 0020: % send attempt(s) name an account that differs from their conversation. They stay; new writes are checked.', n;
	END IF;
END $$;--> statement-breakpoint

-- Rule 1
CREATE FUNCTION "classifications_validate_message"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- A message that does not exist in the organization is left to the foreign key, which names its own constraint.
	IF EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.message_id AND m.organization_id = NEW.organization_id) AND NOT EXISTS (
		SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
		WHERE m.id = NEW.message_id AND m.organization_id = NEW.organization_id AND m.direction = 'inbound' AND c.record_id = NEW.record_id
	) THEN
		RAISE EXCEPTION 'classifications.message_id must be an inbound message of the classification''s record'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'classifications', COLUMN = 'message_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "classifications_message_ins_trg" BEFORE INSERT ON "classifications"
	FOR EACH ROW EXECUTE FUNCTION "classifications_validate_message"();--> statement-breakpoint
CREATE TRIGGER "classifications_message_upd_trg" BEFORE UPDATE OF "record_id", "message_id" ON "classifications"
	FOR EACH ROW WHEN (OLD."record_id" IS DISTINCT FROM NEW."record_id" OR OLD."message_id" IS DISTINCT FROM NEW."message_id")
	EXECUTE FUNCTION "classifications_validate_message"();--> statement-breakpoint

-- Rule 2. Checks a pair only when it is new or changed, and only when the subcategory id is set (SET NULL writes NULL).
CREATE FUNCTION "classification_subcategory_fits"(org uuid, pipe uuid, sub uuid, cat_key text) RETURNS boolean LANGUAGE sql STABLE AS $$
	-- A subcategory that does not exist in the organization is left to the foreign key.
	SELECT sub IS NULL
		OR NOT EXISTS (SELECT 1 FROM subcategories s WHERE s.id = sub AND s.organization_id = org)
		OR EXISTS (
			SELECT 1 FROM subcategories s
			WHERE s.id = sub AND s.organization_id = org AND s.pipeline_id = pipe AND (cat_key IS NULL OR s.category_key = cat_key));
$$;--> statement-breakpoint
CREATE FUNCTION "classifications_validate_subcategories"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	pipe uuid;
	moved boolean := TG_OP = 'INSERT';
BEGIN
	IF TG_OP = 'UPDATE' THEN moved := OLD.record_id IS DISTINCT FROM NEW.record_id; END IF;
	SELECT r.pipeline_id INTO pipe FROM records r WHERE r.id = NEW.record_id AND r.organization_id = NEW.organization_id;
	IF pipe IS NULL THEN RETURN NEW; END IF; -- the record foreign key reports a missing record
	IF (moved OR NEW.previous_subcategory_id IS DISTINCT FROM OLD.previous_subcategory_id OR NEW.previous_category_key IS DISTINCT FROM OLD.previous_category_key)
		AND NOT classification_subcategory_fits(NEW.organization_id, pipe, NEW.previous_subcategory_id, NEW.previous_category_key) THEN
		RAISE EXCEPTION 'classifications.previous_subcategory_id must belong to the record''s pipeline and to previous_category_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'classifications', COLUMN = 'previous_subcategory_id';
	END IF;
	IF (moved OR NEW.proposed_subcategory_id IS DISTINCT FROM OLD.proposed_subcategory_id OR NEW.proposed_category_key IS DISTINCT FROM OLD.proposed_category_key)
		AND NOT classification_subcategory_fits(NEW.organization_id, pipe, NEW.proposed_subcategory_id, NEW.proposed_category_key) THEN
		RAISE EXCEPTION 'classifications.proposed_subcategory_id must belong to the record''s pipeline and to proposed_category_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'classifications', COLUMN = 'proposed_subcategory_id';
	END IF;
	IF (moved OR NEW.applied_subcategory_id IS DISTINCT FROM OLD.applied_subcategory_id OR NEW.applied_category_key IS DISTINCT FROM OLD.applied_category_key)
		AND NOT classification_subcategory_fits(NEW.organization_id, pipe, NEW.applied_subcategory_id, NEW.applied_category_key) THEN
		RAISE EXCEPTION 'classifications.applied_subcategory_id must belong to the record''s pipeline and to applied_category_key'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'classifications', COLUMN = 'applied_subcategory_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "classifications_subcategories_ins_trg" BEFORE INSERT ON "classifications"
	FOR EACH ROW EXECUTE FUNCTION "classifications_validate_subcategories"();--> statement-breakpoint
CREATE TRIGGER "classifications_subcategories_upd_trg" BEFORE UPDATE OF "record_id", "previous_subcategory_id", "previous_category_key", "proposed_subcategory_id", "proposed_category_key", "applied_subcategory_id", "applied_category_key" ON "classifications"
	FOR EACH ROW WHEN (
		OLD."record_id" IS DISTINCT FROM NEW."record_id"
		OR OLD."previous_subcategory_id" IS DISTINCT FROM NEW."previous_subcategory_id"
		OR OLD."previous_category_key" IS DISTINCT FROM NEW."previous_category_key"
		OR OLD."proposed_subcategory_id" IS DISTINCT FROM NEW."proposed_subcategory_id"
		OR OLD."proposed_category_key" IS DISTINCT FROM NEW."proposed_category_key"
		OR OLD."applied_subcategory_id" IS DISTINCT FROM NEW."applied_subcategory_id"
		OR OLD."applied_category_key" IS DISTINCT FROM NEW."applied_category_key"
	) EXECUTE FUNCTION "classifications_validate_subcategories"();--> statement-breakpoint

-- Rule 3
CREATE FUNCTION "drafts_validate_channel"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	conversation_channel text;
BEGIN
	SELECT c.channel INTO conversation_channel FROM conversations c WHERE c.id = NEW.conversation_id AND c.organization_id = NEW.organization_id;
	IF conversation_channel IS NOT NULL AND conversation_channel <> NEW.channel THEN
		RAISE EXCEPTION 'drafts.channel (%) must equal the channel of its conversation (%)', NEW.channel, conversation_channel
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'drafts', COLUMN = 'channel';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "drafts_channel_ins_trg" BEFORE INSERT ON "drafts"
	FOR EACH ROW EXECUTE FUNCTION "drafts_validate_channel"();--> statement-breakpoint
CREATE TRIGGER "drafts_channel_upd_trg" BEFORE UPDATE OF "channel", "conversation_id" ON "drafts"
	FOR EACH ROW WHEN (OLD."channel" IS DISTINCT FROM NEW."channel" OR OLD."conversation_id" IS DISTINCT FROM NEW."conversation_id")
	EXECUTE FUNCTION "drafts_validate_channel"();--> statement-breakpoint

-- Rule 4. The reply target may live in another conversation of the same record, so only direction is checked.
CREATE FUNCTION "drafts_validate_reply_target"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- A message that does not exist in the organization is left to the foreign key (drafts_reply_message_fk).
	IF NEW.reply_for_message_id IS NOT NULL AND EXISTS (
		SELECT 1 FROM messages m WHERE m.id = NEW.reply_for_message_id AND m.organization_id = NEW.organization_id AND m.direction <> 'inbound'
	) THEN
		RAISE EXCEPTION 'drafts.reply_for_message_id must be an inbound message'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'drafts', COLUMN = 'reply_for_message_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "drafts_reply_target_ins_trg" BEFORE INSERT ON "drafts"
	FOR EACH ROW EXECUTE FUNCTION "drafts_validate_reply_target"();--> statement-breakpoint
CREATE TRIGGER "drafts_reply_target_upd_trg" BEFORE UPDATE OF "reply_for_message_id" ON "drafts"
	FOR EACH ROW WHEN (OLD."reply_for_message_id" IS DISTINCT FROM NEW."reply_for_message_id")
	EXECUTE FUNCTION "drafts_validate_reply_target"();--> statement-breakpoint

-- Rule 5
CREATE FUNCTION "send_attempts_validate_account"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	conversation_account text;
BEGIN
	-- A blank value is left to send_attempts_refs_ck, which names its own constraint.
	IF NEW.account_ref IS NULL OR length(btrim(NEW.account_ref)) = 0 THEN RETURN NEW; END IF;
	SELECT c.account_ref INTO conversation_account
	FROM drafts d JOIN conversations c ON c.id = d.conversation_id AND c.organization_id = d.organization_id
	WHERE d.id = NEW.draft_id AND d.organization_id = NEW.organization_id;
	IF conversation_account IS NOT NULL AND lower(conversation_account) <> lower(NEW.account_ref) THEN
		RAISE EXCEPTION 'send_attempts.account_ref (%) must equal the account of the draft''s conversation (%)', NEW.account_ref, conversation_account
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'send_attempts', COLUMN = 'account_ref';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "send_attempts_account_ins_trg" BEFORE INSERT ON "send_attempts"
	FOR EACH ROW EXECUTE FUNCTION "send_attempts_validate_account"();--> statement-breakpoint
CREATE TRIGGER "send_attempts_account_upd_trg" BEFORE UPDATE OF "account_ref", "draft_id" ON "send_attempts"
	FOR EACH ROW WHEN (OLD."account_ref" IS DISTINCT FROM NEW."account_ref" OR OLD."draft_id" IS DISTINCT FROM NEW."draft_id")
	EXECUTE FUNCTION "send_attempts_validate_account"();
