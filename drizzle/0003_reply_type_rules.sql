-- Type rules on reply types. Each type says who checks the AI's pick (check_mode: before | after | skip), whether the AI
-- writes a reply draft (reply_draft) and whether follow-ups keep going (follow_ups: continue | stop). system_role marks
-- the two types that drive fixed paths (stop_request, customer) in place of their keys. The stage rank and the review
-- settings go: the rules replace them, and auto_apply_confidence stays as the confidence floor. Each pick stores the rules
-- it used in reply_type_picks.rules. Default types take their new names where an organization kept the old one.
-- Written by hand: drizzle-kit asks whether the new columns rename the dropped ones.

-- ---- New columns. The defaults are the rules of a type a person adds.
ALTER TABLE "reply_types" ADD COLUMN "check_mode" text DEFAULT 'after' NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_types" ADD COLUMN "reply_draft" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_types" ADD COLUMN "follow_ups" text DEFAULT 'continue' NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_types" ADD COLUMN "system_role" text;--> statement-breakpoint
ALTER TABLE "reply_type_picks" ADD COLUMN "rules" jsonb;--> statement-breakpoint

-- ---- Backfill, from the rules the code applied by key and group until now:
--   no draft: the not_interested group and do_not_contact, out_of_office, left_company (reply-policy needsReply);
--   follow-ups stop: the not_interested group and the no-start keys (after-reply NO_START_KEYS);
--   checked before: review_required, the other group while review_other, the customer group while
--   customer_requires_review (classification-policy); else skip without a draft and after with one.
-- do_not_contact becomes the stop request type, which is always checked before and always active.
UPDATE "reply_types" SET
	"reply_draft" = NOT ("group_key" = 'not_interested' OR "key" IN ('do_not_contact', 'out_of_office', 'left_company')),
	"follow_ups" = CASE WHEN "group_key" = 'not_interested'
		OR "key" IN ('do_not_contact', 'out_of_office', 'left_company', 'wrong_contact', 'connected_to_different_contact', 'customer')
		THEN 'stop' ELSE 'continue' END,
	"system_role" = CASE WHEN "key" = 'do_not_contact' THEN 'stop_request' WHEN "key" = 'customer' AND "group_key" = 'customer' THEN 'customer' END;--> statement-breakpoint
UPDATE "reply_types" t SET "check_mode" = CASE
	WHEN t."system_role" = 'stop_request' OR t."review_required"
		OR (t."group_key" = 'other' AND coalesce(s."review_other", true))
		OR (t."group_key" = 'customer' AND coalesce(s."customer_requires_review", true)) THEN 'before'
	WHEN NOT t."reply_draft" THEN 'skip'
	ELSE 'after' END
FROM "reply_types" t2 LEFT JOIN "reply_handling_settings" s ON s."reply_type_set_id" = t2."reply_type_set_id"
WHERE t2."id" = t."id";--> statement-breakpoint
UPDATE "reply_types" SET "active" = true WHERE "system_role" = 'stop_request' AND NOT "active";--> statement-breakpoint
UPDATE "reply_type_picks" p SET "rules" = jsonb_build_object('checkMode', t."check_mode", 'replyDraft', t."reply_draft", 'followUps', t."follow_ups")
FROM "reply_types" t
WHERE t."id" = coalesce(p."applied_reply_type_id", p."proposed_reply_type_id") AND t."organization_id" = p."organization_id";--> statement-breakpoint

-- ---- Default names, descriptions and guidance, where the organization still has the old default text.
UPDATE "reply_types" t SET "name" = v.new_value FROM (VALUES
	('meeting_no_show', 'Meeting no show', 'Missed meeting'),
	('meeting_done', 'Meeting done', 'After a meeting'),
	('trial_user', 'Trial user', 'Trial question'),
	('customer', 'Existing customer', 'Customer question'),
	('do_not_contact', 'Do not contact', 'Asked to stop'),
	('not_required_right_now', 'Not required right now', 'Not now'),
	('already_using_a_tool', 'Already using a tool', 'Already has a tool'),
	('wrong_contact', 'Did not connect to different contact', 'Wrong person'),
	('connected_to_different_contact', 'Connected to different contact', 'Referred someone else'),
	('other', 'Other', 'Unclear')
) AS v(key, old_value, new_value)
WHERE t."key" = v.key AND t."name" = v.old_value;--> statement-breakpoint
UPDATE "reply_types" t SET "description" = v.new_value FROM (VALUES
	('other', 'The reply fits none of the other subcategories.', 'The reply fits none of the other reply types.')
) AS v(key, old_value, new_value)
WHERE t."key" = v.key AND t."description" = v.old_value;--> statement-breakpoint
UPDATE "reply_types" t SET "classification_guidance" = v.new_value FROM (VALUES
	('trial_requested', 'Pick this when the person asks to start, activate, or get access to a trial or a sandbox, or asks what the next step to begin is. Once they are already using the trial, pick Trial user.', 'Pick this when the person asks to start, activate, or get access to a trial or a sandbox, or asks what the next step to begin is. Once they are already using the trial, pick Trial question.'),
	('customer', 'Pick this when the sender is already a paying customer and writes about their account, an invoice, a renewal, or support for the product they use. A cold prospect who sounds enthusiastic is not a customer. This subcategory always goes to a person for review.', 'Pick this when the sender is already a paying customer and writes about their account, an invoice, a renewal, or support for the product they use. A cold prospect who sounds enthusiastic is not a customer.'),
	('do_not_contact', 'Pick this only for an explicit request to unsubscribe, stop emailing, remove the address, or never be contacted again. Irritation, a polite no, or a request to come back later do not qualify. Nothing is sent to this person afterward.', 'Pick this only for an explicit request to unsubscribe, stop emailing, remove the address, or never be contacted again. Irritation, a polite no, or a request to come back later do not qualify.'),
	('already_using_a_tool', 'Pick this when the person says a current vendor, product, agency, or in-house process already does the job and they see no reason to switch. A refusal without naming an existing solution belongs under Not required right now.', 'Pick this when the person says a current vendor, product, agency, or in-house process already does the job and they see no reason to switch. A refusal without naming an existing solution belongs under Not now.'),
	('wrong_contact', 'Pick this when the reply says the message reached the wrong person, or that someone else handles this, but gives no name, address, or introduction. If the reply names or copies a colleague, pick Connected to different contact.', 'Pick this when the reply says the message reached the wrong person, or that someone else handles this, but gives no name, address, or introduction. If the reply names or copies a colleague, pick Referred someone else.'),
	('out_of_office', 'Pick this for vacation, leave, travel, or other temporary absence notices, often automatic and with a return date. If the notice says the person has left the company, pick Left company. No reply is needed; the sequence resumes on schedule.', 'Pick this for vacation, leave, travel, or other temporary absence notices, often automatic and with a return date. If the notice says the person has left the company, pick Left company. No reply is needed.'),
	('other', 'Pick this only when no other subcategory fits the latest message. Prefer a specific subcategory whenever the intent is reasonably clear. Newsletters, bounces without a clear cause, and unrelated replies end up here.', 'Pick this only when no other reply type fits the latest message. Prefer a specific reply type whenever the intent is reasonably clear. Newsletters, bounces without a clear cause, and unrelated replies end up here.')
) AS v(key, old_value, new_value)
WHERE t."key" = v.key AND t."classification_guidance" = v.old_value;--> statement-breakpoint

-- ---- Dropped: the stage rank and the review settings. reply_types_sort_ck read stage_rank, so it comes back without it.
ALTER TABLE "reply_types" DROP CONSTRAINT "reply_types_sort_ck";--> statement-breakpoint
ALTER TABLE "reply_types" DROP COLUMN "review_required";--> statement-breakpoint
ALTER TABLE "reply_types" DROP COLUMN "stage_rank";--> statement-breakpoint
ALTER TABLE "reply_handling_settings" DROP COLUMN "review_other";--> statement-breakpoint
ALTER TABLE "reply_handling_settings" DROP COLUMN "customer_requires_review";--> statement-breakpoint

-- ---- Checks. A stop request type keeps STOP_REQUEST_RULES and stays active; a customer type stays in the customer
-- group; a set holds at most one type per role.
ALTER TABLE "reply_types" ADD CONSTRAINT "reply_types_sort_ck" CHECK ("reply_types"."sort_order" >= 0);--> statement-breakpoint
ALTER TABLE "reply_types" ADD CONSTRAINT "reply_types_rules_ck" CHECK ("reply_types"."check_mode" in ('before', 'after', 'skip') and "reply_types"."follow_ups" in ('continue', 'stop'));--> statement-breakpoint
ALTER TABLE "reply_types" ADD CONSTRAINT "reply_types_system_role_ck" CHECK ("reply_types"."system_role" is null or "reply_types"."system_role" in ('stop_request', 'customer'));--> statement-breakpoint
ALTER TABLE "reply_types" ADD CONSTRAINT "reply_types_stop_request_ck" CHECK ("reply_types"."system_role" is distinct from 'stop_request' or ("reply_types"."check_mode" = 'before' and not "reply_types"."reply_draft" and "reply_types"."follow_ups" = 'stop' and "reply_types"."active"));--> statement-breakpoint
ALTER TABLE "reply_types" ADD CONSTRAINT "reply_types_customer_ck" CHECK ("reply_types"."system_role" is distinct from 'customer' or "reply_types"."group_key" = 'customer');--> statement-breakpoint
CREATE UNIQUE INDEX "reply_types_set_system_role_uq" ON "reply_types" USING btree ("reply_type_set_id","system_role") WHERE "reply_types"."system_role" is not null;--> statement-breakpoint
ALTER TABLE "reply_type_picks" ADD CONSTRAINT "reply_type_picks_rules_ck" CHECK ("reply_type_picks"."rules" is null or jsonb_typeof("reply_type_picks"."rules") = 'object');--> statement-breakpoint

-- ---- A type's role never changes, like its key: the paths it drives would move to another type.
CREATE OR REPLACE FUNCTION public.reply_types_reject_key_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	RAISE EXCEPTION 'reply_types keys are immutable: key, group_key, reply_type_set_id and system_role cannot change'
		USING ERRCODE = 'integrity_constraint_violation', TABLE = 'reply_types';
END $$;--> statement-breakpoint
DROP TRIGGER "reply_types_keys_trg" ON "reply_types";--> statement-breakpoint
CREATE TRIGGER "reply_types_keys_trg" BEFORE UPDATE OF "key", "group_key", "reply_type_set_id", "system_role" ON "reply_types" FOR EACH ROW
	WHEN (old."key" IS DISTINCT FROM new."key" OR old."group_key" IS DISTINCT FROM new."group_key"
		OR old."reply_type_set_id" IS DISTINCT FROM new."reply_type_set_id" OR old."system_role" IS DISTINCT FROM new."system_role")
	EXECUTE FUNCTION public.reply_types_reject_key_change();
