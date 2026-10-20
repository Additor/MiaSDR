-- T5b review fix: a batch keeps its own result limit and target campaign, so searches added after every earlier search was
-- removed still get them. Both columns are new and nullable. The foreign key covers a column that is null everywhere, so it
-- validates at once. The backfill below copies the values from the batch's first search.
ALTER TABLE "linkedin_search_batches" ADD COLUMN "max_results" integer;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD COLUMN "target_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD CONSTRAINT "linkedin_search_batches_target_campaign_id_campaigns_id_fk" FOREIGN KEY ("target_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "linkedin_search_batches" b SET "max_results" = f."max_results", "target_campaign_id" = f."target_campaign_id"
FROM (
	SELECT DISTINCT ON ("batch_id") "batch_id", "max_results", "target_campaign_id"
	FROM "linkedin_search_queries"
	ORDER BY "batch_id", "created_at", "id"
) f
WHERE f."batch_id" = b."id";
