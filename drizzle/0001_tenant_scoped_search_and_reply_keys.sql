-- Six keys between organization-scoped tables become composite (column, organization_id) keys, so a search row or an
-- identity exception cannot point into another organization. drizzle-kit generated the statements above the marker;
-- the unique keys moved ahead of the foreign keys that need them, and the set-null keys null only their own column.
ALTER TABLE "linkedin_search_batches" DROP CONSTRAINT "linkedin_search_batches_target_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" DROP CONSTRAINT "linkedin_search_queries_batch_id_linkedin_search_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" DROP CONSTRAINT "linkedin_search_queries_target_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "linkedin_search_results" DROP CONSTRAINT "linkedin_search_results_query_id_linkedin_search_queries_id_fk";
--> statement-breakpoint
ALTER TABLE "linkedin_search_results" DROP CONSTRAINT "linkedin_search_results_person_id_people_id_fk";
--> statement-breakpoint
ALTER TABLE "identity_exceptions" DROP CONSTRAINT "identity_exceptions_resolved_person_id_people_id_fk";
--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD CONSTRAINT "linkedin_search_batches_id_org_uq" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_id_org_uq" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD CONSTRAINT "linkedin_search_batches_target_campaign_fk" FOREIGN KEY ("target_campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE SET NULL ("target_campaign_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_batch_fk" FOREIGN KEY ("batch_id","organization_id") REFERENCES "public"."linkedin_search_batches"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_target_campaign_fk" FOREIGN KEY ("target_campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE SET NULL ("target_campaign_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD CONSTRAINT "linkedin_search_results_query_fk" FOREIGN KEY ("query_id","organization_id") REFERENCES "public"."linkedin_search_queries"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD CONSTRAINT "linkedin_search_results_person_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE SET NULL ("person_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_resolved_person_fk" FOREIGN KEY ("resolved_person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE SET NULL ("resolved_person_id") ON UPDATE no action;--> statement-breakpoint

-- ---- Written by hand below this marker: a draft's reply target must be an inbound message of the draft's own record.
-- It may sit in another conversation of that record. The update trigger also fires when record_id changes.
CREATE OR REPLACE FUNCTION public.drafts_validate_reply_target() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	target_direction text;
	target_record uuid;
BEGIN
	IF NEW.reply_for_message_id IS NULL THEN
		RETURN NEW;
	END IF;
	SELECT m.direction, cv.record_id INTO target_direction, target_record
	FROM messages m JOIN conversations cv ON cv.id = m.conversation_id AND cv.organization_id = m.organization_id
	WHERE m.id = NEW.reply_for_message_id AND m.organization_id = NEW.organization_id;
	-- A message that does not exist in the organization is left to the foreign key (drafts_reply_message_fk).
	IF NOT FOUND THEN
		RETURN NEW;
	END IF;
	IF target_direction <> 'inbound' THEN
		RAISE EXCEPTION 'drafts.reply_for_message_id must be an inbound message'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'drafts', COLUMN = 'reply_for_message_id';
	END IF;
	IF target_record <> NEW.record_id THEN
		RAISE EXCEPTION 'drafts.reply_for_message_id must be a message of the draft''s record'
			USING ERRCODE = 'integrity_constraint_violation', TABLE = 'drafts', COLUMN = 'reply_for_message_id';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER drafts_reply_target_upd_trg ON public.drafts;--> statement-breakpoint
CREATE TRIGGER drafts_reply_target_upd_trg BEFORE UPDATE OF reply_for_message_id, record_id ON public.drafts FOR EACH ROW WHEN (((old.reply_for_message_id IS DISTINCT FROM new.reply_for_message_id) OR (old.record_id IS DISTINCT FROM new.record_id))) EXECUTE FUNCTION public.drafts_validate_reply_target();
