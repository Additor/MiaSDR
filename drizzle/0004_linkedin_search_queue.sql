ALTER TABLE "linkedin_search_queries" DROP CONSTRAINT "linkedin_search_queries_status_ck";--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD COLUMN "search_day" text;--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD COLUMN "search_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD COLUMN "max_results" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD COLUMN "target_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD COLUMN "imported_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD COLUMN "pages_fetched" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD COLUMN "next_page_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_target_campaign_id_campaigns_id_fk" FOREIGN KEY ("target_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD CONSTRAINT "linkedin_search_results_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_status_ck" CHECK ("linkedin_search_queries"."status" in ('queued', 'running', 'paused', 'paused_limit', 'completed', 'failed', 'cancelled'));