-- T8b-index-debt (DB-012): triage of the 22 INDEX_DEBT tables of schema-audit.ts. Four tables get an index because a
-- production query filters them by organization_id alone (the other filter columns are not covered by an existing key):
--   grid_jobs      (organization_id, status)         pendingIn() in enrichment-run-store.ts, before every run and cascade
--   sends          (organization_id, status)         analytics read model, CRM header "unconfirmed" count, lead delete guard
--   ai_jobs        (organization_id, failed_at)      partial, status = 'failed': listFailed() on the ops page
--   contact_policies (organization_id)               partial, do_not_contact: CRM header count
-- The other 18 tables are reached through a parent key that already has an index (events by person_id or record_id,
-- send_attempts by draft_id, ...). Their only organization-wide scan is the cascade of an organization delete, which
-- better-auth disables (disableOrganizationDeletion in identity/infrastructure/auth.ts). Their audit reason now says so.
--
-- Write cost: each index adds one btree insert per row written to its table. sends and grid_jobs take the most writes
-- (one row per send, one per enrichment cell). The two partial indexes only touch rows in the matching state.
-- Build lock: plain CREATE INDEX takes SHARE on the table, which blocks writes until it finishes, and the migrator runs
-- every pending migration in one transaction (no CONCURRENTLY here). IF NOT EXISTS lets an operator of a large database
-- build them first with CREATE INDEX CONCURRENTLY and the same names, then run the migration to skip them.
CREATE INDEX IF NOT EXISTS "sends_org_status_idx" ON "sends" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_jobs_org_failed_idx" ON "ai_jobs" USING btree ("organization_id","failed_at") WHERE "ai_jobs"."status" = 'failed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_policies_org_dnc_idx" ON "contact_policies" USING btree ("organization_id") WHERE "contact_policies"."do_not_contact";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grid_jobs_org_status_idx" ON "grid_jobs" USING btree ("organization_id","status");