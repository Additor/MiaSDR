-- T8-indexes (DB-007): seven read indexes. Hand-edited after `drizzle-kit generate`: IF NOT EXISTS lets an operator of a
-- large database create them first with CREATE INDEX CONCURRENTLY (same names). The migrator runs in one transaction,
-- so this file cannot use CONCURRENTLY itself.
-- Plain ascending columns: a backward scan serves `order by created_at desc, id desc`, and `desc nulls last` indexes
-- would not match the default `desc` (nulls first) that the queries use.
CREATE INDEX IF NOT EXISTS "people_org_created_idx" ON "people" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_org_name_idx" ON "people" USING btree ("organization_id",lower("full_name"),"id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "classifications_record_created_idx" ON "classifications" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_person_created_idx" ON "events" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_exceptions_org_status_created_idx" ON "identity_exceptions" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_documents_org_active_idx" ON "knowledge_documents" USING btree ("organization_id","active","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "send_attempts_draft_created_idx" ON "send_attempts" USING btree ("draft_id","created_at");