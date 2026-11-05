CREATE TABLE "mia_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"input" jsonb NOT NULL,
	"checkpoint" jsonb,
	"step_count" integer DEFAULT 0 NOT NULL,
	"used_tokens" integer DEFAULT 0 NOT NULL,
	"suggestion_count" integer DEFAULT 0 NOT NULL,
	"provider" text,
	"model" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"failure_kind" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mia_runs_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "mia_runs_capability_ck" CHECK ("mia_runs"."capability" in ('brain_fill_url', 'brain_fill_text', 'brain_sort')),
	CONSTRAINT "mia_runs_status_ck" CHECK ("mia_runs"."status" in ('queued', 'running', 'waiting_limit', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "mia_runs_input_size_ck" CHECK (octet_length("mia_runs"."input"::text) <= 409600),
	CONSTRAINT "mia_runs_checkpoint_size_ck" CHECK ("mia_runs"."checkpoint" is null or octet_length("mia_runs"."checkpoint"::text) <= 4194304)
);
--> statement-breakpoint
CREATE TABLE "mia_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"run_id" uuid,
	"step_count" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"target_item_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mia_suggestions_step_uq" UNIQUE("run_id","step_count","ordinal"),
	CONSTRAINT "mia_suggestions_type_ck" CHECK ("mia_suggestions"."type" in ('new_item', 'item_change')),
	CONSTRAINT "mia_suggestions_status_ck" CHECK ("mia_suggestions"."status" in ('open', 'accepted', 'dismissed')),
	CONSTRAINT "mia_suggestions_payload_size_ck" CHECK (octet_length("mia_suggestions"."payload"::text) <= 262144),
	CONSTRAINT "mia_suggestions_title_ck" CHECK (length("mia_suggestions"."title") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "mia_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mia_runs" ADD CONSTRAINT "mia_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_runs" ADD CONSTRAINT "mia_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_suggestions" ADD CONSTRAINT "mia_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_suggestions" ADD CONSTRAINT "mia_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_suggestions" ADD CONSTRAINT "mia_suggestions_run_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."mia_runs"("id","organization_id") ON DELETE SET NULL ("run_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_suggestions" ADD CONSTRAINT "mia_suggestions_target_fk" FOREIGN KEY ("target_item_id","organization_id") REFERENCES "public"."knowledge_documents"("id","organization_id") ON DELETE SET NULL ("target_item_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_suggestions" ADD CONSTRAINT "mia_suggestions_created_item_fk" FOREIGN KEY ("created_item_id","organization_id") REFERENCES "public"."knowledge_documents"("id","organization_id") ON DELETE SET NULL ("created_item_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_usage_daily" ADD CONSTRAINT "mia_usage_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mia_runs_org_created_idx" ON "mia_runs" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mia_runs_due_idx" ON "mia_runs" USING btree ("next_attempt_at") WHERE "mia_runs"."status" in ('queued', 'waiting_limit');--> statement-breakpoint
CREATE INDEX "mia_runs_lease_idx" ON "mia_runs" USING btree ("lease_expires_at") WHERE "mia_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "mia_runs_one_fill_uq" ON "mia_runs" USING btree ("organization_id") WHERE "mia_runs"."capability" in ('brain_fill_url', 'brain_fill_text') and "mia_runs"."status" in ('queued', 'running', 'waiting_limit');--> statement-breakpoint
CREATE UNIQUE INDEX "mia_runs_one_sort_uq" ON "mia_runs" USING btree ("organization_id",("input"->>'itemId')) WHERE "mia_runs"."capability" = 'brain_sort' and "mia_runs"."status" in ('queued', 'running', 'waiting_limit');--> statement-breakpoint
CREATE INDEX "mia_suggestions_org_status_idx" ON "mia_suggestions" USING btree ("organization_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "mia_usage_daily_org_day_uq" ON "mia_usage_daily" USING btree ("organization_id","day");