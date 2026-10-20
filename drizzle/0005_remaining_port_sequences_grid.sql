CREATE SEQUENCE "public"."grid_row_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "record_sequence_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"source" text NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_sequence_overrides_source_ck" CHECK ("record_sequence_overrides"."source" in ('human', 'integration')),
	CONSTRAINT "record_sequence_overrides_time_ck" CHECK ("record_sequence_overrides"."cleared_at" is null or "record_sequence_overrides"."cleared_at" >= "record_sequence_overrides"."effective_at")
);
--> statement-breakpoint
CREATE TABLE "sequence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"sequence_version_id" uuid NOT NULL,
	"subcategory_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step_position" integer DEFAULT 1 NOT NULL,
	"start_step_position" integer DEFAULT 1 NOT NULL,
	"started_by" text NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"last_inbound_at_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_runs_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "sequence_runs_status_ck" CHECK ("sequence_runs"."status" in ('active', 'interrupted', 'paused', 'completed', 'cancelled')),
	CONSTRAINT "sequence_runs_started_by_ck" CHECK ("sequence_runs"."started_by" in ('ai_assignment', 'human_override')),
	CONSTRAINT "sequence_runs_positions_ck" CHECK ("sequence_runs"."start_step_position" > 0 and "sequence_runs"."current_step_position" >= "sequence_runs"."start_step_position")
);
--> statement-breakpoint
CREATE TABLE "sequence_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_run_id" uuid NOT NULL,
	"sequence_step_id" uuid NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"draft_id" uuid,
	"sent_message_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"expected_context_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_step_runs_run_step_uq" UNIQUE("sequence_run_id","sequence_step_id"),
	CONSTRAINT "sequence_step_runs_status_ck" CHECK ("sequence_step_runs"."status" in ('scheduled', 'drafting', 'awaiting_review', 'sent', 'skipped', 'cancelled', 'failed')),
	CONSTRAINT "sequence_step_runs_attempts_ck" CHECK ("sequence_step_runs"."attempt_count" >= 0 and "sequence_step_runs"."expected_context_version" >= 0),
	CONSTRAINT "sequence_step_runs_sent_ck" CHECK ("sequence_step_runs"."status" <> 'sent' or "sequence_step_runs"."sent_message_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"step_type" text NOT NULL,
	"name" text NOT NULL,
	"delay_minutes" integer NOT NULL,
	"subject_template" text,
	"body_template" text,
	"ai_instructions" text NOT NULL,
	"knowledge_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_steps_version_position_uq" UNIQUE("sequence_version_id","position"),
	CONSTRAINT "sequence_steps_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "sequence_steps_name_ck" CHECK (length(btrim("sequence_steps"."name")) > 0 and length(btrim("sequence_steps"."ai_instructions")) > 0),
	CONSTRAINT "sequence_steps_delay_ck" CHECK ("sequence_steps"."delay_minutes" >= 0),
	CONSTRAINT "sequence_steps_semantics_ck" CHECK (("sequence_steps"."position" = 1 and "sequence_steps"."step_type" = 'reply' and "sequence_steps"."delay_minutes" = 0) or ("sequence_steps"."position" > 1 and "sequence_steps"."step_type" = 'follow_up'))
);
--> statement-breakpoint
CREATE TABLE "sequence_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_versions_seq_version_uq" UNIQUE("sequence_id","version"),
	CONSTRAINT "sequence_versions_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "sequence_versions_version_ck" CHECK ("sequence_versions"."version" > 0),
	CONSTRAINT "sequence_versions_status_ck" CHECK ("sequence_versions"."status" in ('draft', 'published')),
	CONSTRAINT "sequence_versions_published_ck" CHECK (("sequence_versions"."status" = 'draft') = ("sequence_versions"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequences_org_name_uq" UNIQUE("organization_id","name"),
	CONSTRAINT "sequences_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "sequences_name_ck" CHECK (length(btrim("sequences"."name")) > 0),
	CONSTRAINT "sequences_status_ck" CHECK ("sequences"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "subcategory_sequence_assignments" (
	"subcategory_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grid_cell_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"column_key" text NOT NULL,
	"provider" text,
	"outcome" text NOT NULL,
	"cost_cents" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"request" jsonb,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_cell_runs_outcome_ck" CHECK ("grid_cell_runs"."outcome" in ('hit', 'miss', 'error', 'failed', 'skipped', 'cancelled')),
	CONSTRAINT "grid_cell_runs_cost_ck" CHECK ("grid_cell_runs"."cost_cents" >= 0 and ("grid_cell_runs"."latency_ms" is null or "grid_cell_runs"."latency_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE "grid_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" double precision NOT NULL,
	"auto_run" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_columns_table_key_uq" UNIQUE("table_id","key"),
	CONSTRAINT "grid_columns_type_ck" CHECK ("grid_columns"."type" in ('text', 'number', 'currency', 'boolean', 'date', 'url', 'email', 'image', 'select', 'multiselect', 'json', 'enrichment', 'integration_output', 'ai_output', 'http', 'ai', 'functions', 'message', 'waterfall', 'formula', 'merge')),
	CONSTRAINT "grid_columns_key_ck" CHECK ("grid_columns"."key" <> '' and length(btrim("grid_columns"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "grid_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_folders_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_folders_name_ck" CHECK (length(btrim("grid_folders"."name")) > 0),
	CONSTRAINT "grid_folders_parent_ck" CHECK ("grid_folders"."parent_id" is null or "grid_folders"."parent_id" <> "grid_folders"."id")
);
--> statement-breakpoint
CREATE TABLE "grid_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"column_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"error" text,
	"provider_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_jobs_cell_uq" UNIQUE("row_id","column_key"),
	CONSTRAINT "grid_jobs_status_ck" CHECK ("grid_jobs"."status" in ('queued', 'running', 'waiting', 'succeeded', 'failed')),
	CONSTRAINT "grid_jobs_attempts_ck" CHECK ("grid_jobs"."attempts" >= 0 and "grid_jobs"."max_attempts" >= 1),
	CONSTRAINT "grid_jobs_lock_ck" CHECK ("grid_jobs"."status" <> 'running' or "grid_jobs"."locked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "grid_provider_credentials" (
	"provider_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encryption_version" text DEFAULT 'v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_provider_credentials_envelope_ck" CHECK ("grid_provider_credentials"."encrypted_payload" like "grid_provider_credentials"."encryption_version" || ':%')
);
--> statement-breakpoint
CREATE TABLE "grid_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"default_cost_cents" numeric(12, 6) DEFAULT '0' NOT NULL,
	"rate_limit_per_min" integer,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_providers_org_key_uq" UNIQUE("organization_id","key"),
	CONSTRAINT "grid_providers_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_providers_key_ck" CHECK ("grid_providers"."key" ~ '^[a-z][a-z0-9_-]*$' and length(btrim("grid_providers"."name")) > 0),
	CONSTRAINT "grid_providers_cost_ck" CHECK ("grid_providers"."default_cost_cents" >= 0 and ("grid_providers"."rate_limit_per_min" is null or "grid_providers"."rate_limit_per_min" > 0))
);
--> statement-breakpoint
CREATE TABLE "grid_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"position" double precision NOT NULL,
	"cells" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cell_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT nextval('grid_row_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_rows_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_rows_cells_ck" CHECK (jsonb_typeof("grid_rows"."cells") = 'object' and jsonb_typeof("grid_rows"."cell_meta") = 'object')
);
--> statement-breakpoint
CREATE TABLE "grid_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workbook_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"auto_run" boolean DEFAULT true NOT NULL,
	"position" double precision NOT NULL,
	"view" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_tables_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_tables_name_ck" CHECK (length(btrim("grid_tables"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "grid_workbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_workbooks_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "grid_workbooks_name_ck" CHECK (length(btrim("grid_workbooks"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "record_sequence_overrides" ADD CONSTRAINT "record_sequence_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_sequence_overrides" ADD CONSTRAINT "record_sequence_overrides_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_sequence_overrides" ADD CONSTRAINT "record_sequence_overrides_sequence_id_organization_id_sequences_id_organization_id_fk" FOREIGN KEY ("sequence_id","organization_id") REFERENCES "public"."sequences"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_record_id_organization_id_records_id_organization_id_fk" FOREIGN KEY ("record_id","organization_id") REFERENCES "public"."records"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_conversation_id_organization_id_conversations_id_organization_id_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_sequence_id_organization_id_sequences_id_organization_id_fk" FOREIGN KEY ("sequence_id","organization_id") REFERENCES "public"."sequences"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_sequence_version_id_organization_id_sequence_versions_id_organization_id_fk" FOREIGN KEY ("sequence_version_id","organization_id") REFERENCES "public"."sequence_versions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_subcategory_id_organization_id_subcategories_id_organization_id_fk" FOREIGN KEY ("subcategory_id","organization_id") REFERENCES "public"."subcategories"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_trigger_message_id_organization_id_messages_id_organization_id_fk" FOREIGN KEY ("trigger_message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_sequence_run_id_organization_id_sequence_runs_id_organization_id_fk" FOREIGN KEY ("sequence_run_id","organization_id") REFERENCES "public"."sequence_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_sequence_step_id_organization_id_sequence_steps_id_organization_id_fk" FOREIGN KEY ("sequence_step_id","organization_id") REFERENCES "public"."sequence_steps"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_draft_id_organization_id_drafts_id_organization_id_fk" FOREIGN KEY ("draft_id","organization_id") REFERENCES "public"."drafts"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_runs" ADD CONSTRAINT "sequence_step_runs_sent_message_id_organization_id_messages_id_organization_id_fk" FOREIGN KEY ("sent_message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_version_id_organization_id_sequence_versions_id_organization_id_fk" FOREIGN KEY ("sequence_version_id","organization_id") REFERENCES "public"."sequence_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_versions" ADD CONSTRAINT "sequence_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_versions" ADD CONSTRAINT "sequence_versions_sequence_id_organization_id_sequences_id_organization_id_fk" FOREIGN KEY ("sequence_id","organization_id") REFERENCES "public"."sequences"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategory_sequence_assignments" ADD CONSTRAINT "subcategory_sequence_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategory_sequence_assignments" ADD CONSTRAINT "subcategory_sequence_assignments_subcategory_id_organization_id_subcategories_id_organization_id_fk" FOREIGN KEY ("subcategory_id","organization_id") REFERENCES "public"."subcategories"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategory_sequence_assignments" ADD CONSTRAINT "subcategory_sequence_assignments_sequence_id_organization_id_sequences_id_organization_id_fk" FOREIGN KEY ("sequence_id","organization_id") REFERENCES "public"."sequences"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_cell_runs" ADD CONSTRAINT "grid_cell_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_cell_runs" ADD CONSTRAINT "grid_cell_runs_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_cell_runs" ADD CONSTRAINT "grid_cell_runs_row_id_organization_id_grid_rows_id_organization_id_fk" FOREIGN KEY ("row_id","organization_id") REFERENCES "public"."grid_rows"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_columns" ADD CONSTRAINT "grid_columns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_columns" ADD CONSTRAINT "grid_columns_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_folders" ADD CONSTRAINT "grid_folders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_folders" ADD CONSTRAINT "grid_folders_parent_id_organization_id_grid_folders_id_organization_id_fk" FOREIGN KEY ("parent_id","organization_id") REFERENCES "public"."grid_folders"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_jobs" ADD CONSTRAINT "grid_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_jobs" ADD CONSTRAINT "grid_jobs_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_jobs" ADD CONSTRAINT "grid_jobs_row_id_organization_id_grid_rows_id_organization_id_fk" FOREIGN KEY ("row_id","organization_id") REFERENCES "public"."grid_rows"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_provider_credentials" ADD CONSTRAINT "grid_provider_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_provider_credentials" ADD CONSTRAINT "grid_provider_credentials_provider_id_organization_id_grid_providers_id_organization_id_fk" FOREIGN KEY ("provider_id","organization_id") REFERENCES "public"."grid_providers"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_providers" ADD CONSTRAINT "grid_providers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_rows" ADD CONSTRAINT "grid_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_rows" ADD CONSTRAINT "grid_rows_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_tables" ADD CONSTRAINT "grid_tables_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_tables" ADD CONSTRAINT "grid_tables_workbook_id_organization_id_grid_workbooks_id_organization_id_fk" FOREIGN KEY ("workbook_id","organization_id") REFERENCES "public"."grid_workbooks"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_workbooks" ADD CONSTRAINT "grid_workbooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_workbooks" ADD CONSTRAINT "grid_workbooks_folder_id_organization_id_grid_folders_id_organization_id_fk" FOREIGN KEY ("folder_id","organization_id") REFERENCES "public"."grid_folders"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_sequence_overrides_active_uq" ON "record_sequence_overrides" USING btree ("record_id") WHERE "record_sequence_overrides"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "record_sequence_overrides_record_idx" ON "record_sequence_overrides" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_runs_one_active_uq" ON "sequence_runs" USING btree ("record_id") WHERE "sequence_runs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sequence_runs_record_created_idx" ON "sequence_runs" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_step_runs_draft_uq" ON "sequence_step_runs" USING btree ("draft_id") WHERE "sequence_step_runs"."draft_id" is not null;--> statement-breakpoint
CREATE INDEX "sequence_step_runs_due_idx" ON "sequence_step_runs" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_versions_one_draft_uq" ON "sequence_versions" USING btree ("sequence_id") WHERE "sequence_versions"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "sequences_org_status_idx" ON "sequences" USING btree ("organization_id","status","name");--> statement-breakpoint
CREATE INDEX "subcategory_sequence_assignments_sequence_idx" ON "subcategory_sequence_assignments" USING btree ("sequence_id");--> statement-breakpoint
CREATE INDEX "grid_cell_runs_cell_idx" ON "grid_cell_runs" USING btree ("row_id","column_key");--> statement-breakpoint
CREATE INDEX "grid_cell_runs_table_created_idx" ON "grid_cell_runs" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE INDEX "grid_columns_table_pos_idx" ON "grid_columns" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "grid_folders_org_parent_idx" ON "grid_folders" USING btree ("organization_id","parent_id");--> statement-breakpoint
CREATE INDEX "grid_jobs_claim_idx" ON "grid_jobs" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE INDEX "grid_jobs_table_status_idx" ON "grid_jobs" USING btree ("table_id","status");--> statement-breakpoint
CREATE INDEX "grid_rows_table_pos_idx" ON "grid_rows" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "grid_rows_table_version_idx" ON "grid_rows" USING btree ("table_id","version");--> statement-breakpoint
CREATE INDEX "grid_tables_workbook_pos_idx" ON "grid_tables" USING btree ("workbook_id","position");--> statement-breakpoint
CREATE INDEX "grid_workbooks_org_folder_idx" ON "grid_workbooks" USING btree ("organization_id","folder_id");
--> statement-breakpoint
-- Hand-added: bump the row version on every cell write so clients can poll version > cursor.
CREATE FUNCTION "grid_rows_bump_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW.version := nextval('grid_row_version_seq');
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "grid_rows_bump_version_trg" BEFORE UPDATE OF "cells", "cell_meta" ON "grid_rows" FOR EACH ROW EXECUTE FUNCTION "grid_rows_bump_version"();
