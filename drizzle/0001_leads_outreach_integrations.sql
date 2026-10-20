CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"name" text,
	"linkedin_url" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_org_domain_uq" UNIQUE("organization_id","domain"),
	CONSTRAINT "companies_id_org_uq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "entity_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_core" boolean DEFAULT false NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_columns_org_entity_key_uq" UNIQUE("organization_id","entity","key"),
	CONSTRAINT "entity_columns_entity_ck" CHECK ("entity_columns"."entity" in ('people', 'companies')),
	CONSTRAINT "entity_columns_key_ck" CHECK ("entity_columns"."key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filename" text,
	"destination" text DEFAULT 'database' NOT NULL,
	"destination_campaign_id" uuid,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_destination_ck" CHECK ("import_runs"."destination" in ('database', 'campaign'))
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text,
	"linkedin_slug" text,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"title" text,
	"profile_picture_url" text,
	"phone" text,
	"company_id" uuid,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_id_org_uq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"provider_event_key" text,
	"event_type" text NOT NULL,
	"account_ref" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_events_provider_ck" CHECK ("inbound_events"."provider" in ('gmail', 'unipile')),
	CONSTRAINT "inbound_events_status_ck" CHECK ("inbound_events"."status" in ('pending', 'processing', 'done', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "integration_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_accounts_org_key_uq" UNIQUE("organization_id","key"),
	CONSTRAINT "integration_accounts_kind_ck" CHECK ("integration_accounts"."kind" in ('enrichment', 'platform', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encryption_version" text DEFAULT 'v1' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"mailbox_id" uuid,
	"linkedin_account_id" uuid,
	"next_send_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"merge_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_campaign_person_uq" UNIQUE("campaign_id","person_id"),
	CONSTRAINT "enrollments_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "enrollments_channel_ck" CHECK ("campaign_enrollments"."channel" in ('email', 'linkedin')),
	CONSTRAINT "enrollments_status_ck" CHECK ("campaign_enrollments"."status" in ('pending', 'active', 'replied', 'completed', 'bounced', 'suppressed', 'failed', 'cancelled')),
	CONSTRAINT "enrollments_step_ck" CHECK ("campaign_enrollments"."current_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "campaign_senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"mailbox_id" uuid,
	"linkedin_account_id" uuid,
	CONSTRAINT "campaign_senders_one_ck" CHECK (("campaign_senders"."mailbox_id" is null) <> ("campaign_senders"."linkedin_account_id" is null))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "campaigns_channel_ck" CHECK ("campaigns"."channel" in ('email', 'linkedin')),
	CONSTRAINT "campaigns_status_ck" CHECK ("campaigns"."status" in ('draft', 'active', 'paused', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "linkedin_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"linkedin_id" text NOT NULL,
	"username" text,
	"name" text,
	"headline" text,
	"profile_data" jsonb,
	"status" text DEFAULT 'connected' NOT NULL,
	"is_premium" boolean DEFAULT false NOT NULL,
	"daily_invite_limit" integer DEFAULT 20 NOT NULL,
	"limit_reached_until" timestamp with time zone,
	"search_leads_today" integer DEFAULT 0 NOT NULL,
	"working_hours" jsonb,
	"next_allowed_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_accounts_provider_account_id_unique" UNIQUE("provider_account_id"),
	CONSTRAINT "linkedin_accounts_linkedin_id_unique" UNIQUE("linkedin_id"),
	CONSTRAINT "linkedin_accounts_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "linkedin_accounts_status_ck" CHECK ("linkedin_accounts"."status" in ('connected', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "linkedin_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"linkedin_account_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"name" text,
	"headline" text,
	"profile_url" text,
	"chat_id" text,
	"enrollment_id" uuid,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_connections_enrollment_id_unique" UNIQUE("enrollment_id"),
	CONSTRAINT "linkedin_connections_provider_account_uq" UNIQUE("provider_id","linkedin_account_id")
);
--> statement-breakpoint
CREATE TABLE "linkedin_enrollment_details" (
	"enrollment_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" text,
	"profile_url" text,
	"connection_state" text DEFAULT 'none' NOT NULL,
	"request_sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"invite_retry_count" integer DEFAULT 0 NOT NULL,
	"resolve_retry_count" integer DEFAULT 0 NOT NULL,
	"resolve_next_attempt_at" timestamp with time zone,
	"resolve_last_error" text,
	CONSTRAINT "linkedin_details_state_ck" CHECK ("linkedin_enrollment_details"."connection_state" in ('none', 'request_sent', 'connected'))
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"url" text NOT NULL,
	"company_name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"cursor" text,
	"total_count" integer,
	"leads_fetched" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"current_account_id" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_search_queries_status_ck" CHECK ("linkedin_search_queries"."status" in ('queued', 'running', 'paused_limit', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"profile_url" text NOT NULL,
	"name" text,
	"headline" text,
	"location" text,
	"network_distance" text,
	"followers_count" integer,
	"shared_connections_count" integer,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_search_results_query_url_uq" UNIQUE("query_id","profile_url")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'connecting' NOT NULL,
	"last_error" text,
	"last_tested_at" timestamp with time zone,
	"gmail_history_cursor" text,
	"gmail_watch_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"daily_send_limit" integer DEFAULT 30 NOT NULL,
	"signature_html" text,
	"working_hours" jsonb,
	"next_send_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_email_address_unique" UNIQUE("email_address"),
	CONSTRAINT "mailboxes_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "mailboxes_status_ck" CHECK ("mailboxes"."status" in ('connecting', 'connected', 'failed', 'disabled')),
	CONSTRAINT "mailboxes_limit_ck" CHECK ("mailboxes"."daily_send_limit" between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"mailbox_id" uuid,
	"linkedin_account_id" uuid,
	"subject" text,
	"body" text,
	"rfc_message_id" text,
	"provider_message_id" text,
	"thread_id" text,
	"in_reply_to" text,
	"references" text[],
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sends_enrollment_step_uq" UNIQUE("enrollment_id","step_number"),
	CONSTRAINT "sends_channel_ck" CHECK ("sends"."channel" in ('email', 'linkedin')),
	CONSTRAINT "sends_status_ck" CHECK ("sends"."status" in ('sending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_org_email_uq" UNIQUE("organization_id","email"),
	CONSTRAINT "suppression_reason_ck" CHECK ("suppression_list"."reason" in ('unsubscribed', 'bounced', 'manual', 'complaint'))
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"job" text NOT NULL,
	"slot" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_job_slot_org_uq" UNIQUE NULLS NOT DISTINCT("job","slot","organization_id"),
	CONSTRAINT "job_runs_status_ck" CHECK ("job_runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_columns" ADD CONSTRAINT "entity_columns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_account_id_integration_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_campaign_id_organization_id_campaigns_id_organization_id_fk" FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_person_id_organization_id_people_id_organization_id_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_mailbox_id_organization_id_mailboxes_id_organization_id_fk" FOREIGN KEY ("mailbox_id","organization_id") REFERENCES "public"."mailboxes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "campaign_enrollments_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_senders" ADD CONSTRAINT "campaign_senders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_senders" ADD CONSTRAINT "campaign_senders_campaign_id_organization_id_campaigns_id_organization_id_fk" FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_senders" ADD CONSTRAINT "campaign_senders_mailbox_id_organization_id_mailboxes_id_organization_id_fk" FOREIGN KEY ("mailbox_id","organization_id") REFERENCES "public"."mailboxes"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_senders" ADD CONSTRAINT "campaign_senders_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connections" ADD CONSTRAINT "linkedin_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_connections" ADD CONSTRAINT "linkedin_connections_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_enrollment_details" ADD CONSTRAINT "linkedin_enrollment_details_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_enrollment_details" ADD CONSTRAINT "linkedin_enrollment_details_enrollment_id_organization_id_campaign_enrollments_id_organization_id_fk" FOREIGN KEY ("enrollment_id","organization_id") REFERENCES "public"."campaign_enrollments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_batches" ADD CONSTRAINT "linkedin_search_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_queries" ADD CONSTRAINT "linkedin_search_queries_batch_id_linkedin_search_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."linkedin_search_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD CONSTRAINT "linkedin_search_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_results" ADD CONSTRAINT "linkedin_search_results_query_id_linkedin_search_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."linkedin_search_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_enrollment_id_organization_id_campaign_enrollments_id_organization_id_fk" FOREIGN KEY ("enrollment_id","organization_id") REFERENCES "public"."campaign_enrollments"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_runs_org_created_idx" ON "import_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "people_org_email_uq" ON "people" USING btree ("organization_id",lower("email")) WHERE "people"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "people_org_linkedin_uq" ON "people" USING btree ("organization_id","linkedin_slug") WHERE "people"."linkedin_slug" is not null;--> statement-breakpoint
CREATE INDEX "people_org_company_idx" ON "people" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_provider_key_uq" ON "inbound_events" USING btree ("provider","provider_event_key") WHERE "inbound_events"."provider_event_key" is not null;--> statement-breakpoint
CREATE INDEX "inbound_events_claim_idx" ON "inbound_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "enrollments_due_idx" ON "campaign_enrollments" USING btree ("channel","next_send_at") WHERE "campaign_enrollments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "enrollments_person_idx" ON "campaign_enrollments" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_senders_mailbox_uq" ON "campaign_senders" USING btree ("campaign_id","mailbox_id") WHERE "campaign_senders"."mailbox_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_senders_linkedin_uq" ON "campaign_senders" USING btree ("campaign_id","linkedin_account_id") WHERE "campaign_senders"."linkedin_account_id" is not null;--> statement-breakpoint
CREATE INDEX "campaigns_org_status_idx" ON "campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "linkedin_details_resolve_idx" ON "linkedin_enrollment_details" USING btree ("resolve_next_attempt_at");--> statement-breakpoint
CREATE INDEX "linkedin_search_queries_claim_idx" ON "linkedin_search_queries" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "mailboxes_org_idx" ON "mailboxes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sends_mailbox_day_idx" ON "sends" USING btree ("mailbox_id","claimed_at");--> statement-breakpoint
CREATE INDEX "sends_linkedin_day_idx" ON "sends" USING btree ("linkedin_account_id","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sends_rfc_message_uq" ON "sends" USING btree ("rfc_message_id") WHERE "sends"."rfc_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sends_provider_message_uq" ON "sends" USING btree ("channel","provider_message_id") WHERE "sends"."provider_message_id" is not null;