CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_ck" CHECK (length(btrim("audit_log"."action")) > 0)
);
--> statement-breakpoint
CREATE TABLE "linkedin_connect_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"provider_account_id" text,
	"linkedin_account_id" uuid,
	"last_error" text,
	"created_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_connect_links_provider_name_unique" UNIQUE("provider_name"),
	CONSTRAINT "linkedin_connect_links_status_ck" CHECK ("linkedin_connect_links"."status" in ('pending', 'completed', 'expired', 'failed')),
	CONSTRAINT "linkedin_connect_links_hash_ck" CHECK ("linkedin_connect_links"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "linkedin_connect_links_done_ck" CHECK (("linkedin_connect_links"."status" = 'completed') = ("linkedin_connect_links"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "lead_ccs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"email" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_message_id" uuid,
	CONSTRAINT "lead_ccs_email_ck" CHECK ("lead_ccs"."email" = lower(btrim("lead_ccs"."email")) and position('@' in "lead_ccs"."email") > 1),
	CONSTRAINT "lead_ccs_seen_ck" CHECK ("lead_ccs"."last_seen_at" >= "lead_ccs"."first_seen_at")
);
--> statement-breakpoint
ALTER TABLE "sends" ALTER COLUMN "enrollment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sends" ALTER COLUMN "step_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "raw" jsonb;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "raw" jsonb;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "replay_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "last_replayed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD COLUMN "daily_message_limit" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD COLUMN "source_filename" text;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD COLUMN "rows_total" integer;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD COLUMN "rows_rejected" integer;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD COLUMN "rejections" jsonb;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD COLUMN "source_row" integer;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD COLUMN "rerun_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "kind" text DEFAULT 'campaign' NOT NULL;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "to_address" text;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "cc" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_by" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connect_links" ADD CONSTRAINT "linkedin_connect_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connect_links" ADD CONSTRAINT "linkedin_connect_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connect_links" ADD CONSTRAINT "linkedin_connect_links_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ccs" ADD CONSTRAINT "lead_ccs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ccs" ADD CONSTRAINT "lead_ccs_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ccs" ADD CONSTRAINT "lead_ccs_source_message_id_organization_id_messages_id_organization_id_fk" FOREIGN KEY ("source_message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_action_idx" ON "audit_log" USING btree ("organization_id","action","created_at");--> statement-breakpoint
CREATE INDEX "linkedin_connect_links_org_idx" ON "linkedin_connect_links" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_ccs_person_email_uq" ON "lead_ccs" USING btree ("person_id","email");--> statement-breakpoint
CREATE INDEX "lead_ccs_org_email_idx" ON "lead_ccs" USING btree ("organization_id","email");--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD CONSTRAINT "linkedin_search_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_events_org_status_idx" ON "inbound_events" USING btree ("organization_id","provider","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_search_queries_batch_url_uq" ON "linkedin_search_queries" USING btree ("batch_id","url");--> statement-breakpoint
CREATE INDEX "linkedin_search_queries_batch_idx" ON "linkedin_search_queries" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "sends_mailbox_test_idx" ON "sends" USING btree ("mailbox_id","claimed_at") WHERE "sends"."kind" = 'test';--> statement-breakpoint
CREATE INDEX "tasks_org_open_due_idx" ON "tasks" USING btree ("organization_id","due_at") WHERE not "tasks"."is_completed";--> statement-breakpoint
CREATE INDEX "tasks_assignee_open_idx" ON "tasks" USING btree ("assigned_to","due_at") WHERE not "tasks"."is_completed";--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_raw_size_ck" CHECK ("companies"."raw" is null or octet_length("companies"."raw"::text) <= 262144);--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_raw_size_ck" CHECK ("people"."raw" is null or octet_length("people"."raw"::text) <= 262144);--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_replay_ck" CHECK ("inbound_events"."replay_count" >= 0);--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_invite_limit_ck" CHECK ("linkedin_accounts"."daily_invite_limit" between 1 and 100);--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_message_limit_ck" CHECK ("linkedin_accounts"."daily_message_limit" between 1 and 200);--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_kind_ck" CHECK ("sends"."kind" in ('campaign', 'test'));--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_kind_shape_ck" CHECK (("sends"."kind" = 'campaign' and "sends"."enrollment_id" is not null and "sends"."step_number" is not null)
        or ("sends"."kind" = 'test' and "sends"."enrollment_id" is null and "sends"."step_number" is null and "sends"."channel" = 'email'
            and "sends"."mailbox_id" is not null and "sends"."to_address" is not null));--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_cc_email_only_ck" CHECK ("drafts"."channel" = 'email' or cardinality("drafts"."cc") = 0);