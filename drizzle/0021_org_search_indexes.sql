-- T8b-index-debt follow-up: two more tables are read by organization_id alone (drizzle-linkedin-search-store.ts):
--   linkedin_search_batches (organization_id, created_at)   listBatches(): the organization's bulk batches, newest first
--   linkedin_search_queries (organization_id, created_at)   list(): the organization's single searches, newest first
-- Write cost: one btree insert per search or batch created, both low-volume tables. Build lock: plain CREATE INDEX takes
-- SHARE on the table until it finishes; both tables hold at most thousands of rows. IF NOT EXISTS lets an operator build
-- them first with CREATE INDEX CONCURRENTLY, as for 0019 (docs/database.md).
CREATE INDEX IF NOT EXISTS "linkedin_search_batches_org_created_idx" ON "linkedin_search_batches" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_search_queries_org_created_idx" ON "linkedin_search_queries" USING btree ("organization_id","created_at");