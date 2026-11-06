CREATE TABLE "lead_fit_assessments" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"icp_item_id" uuid,
	"criteria" jsonb NOT NULL,
	"missing" jsonb NOT NULL,
	"brain_revisions" jsonb NOT NULL,
	"profile_hash" text NOT NULL,
	"latest_inbound_message_id" uuid,
	"run_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"assessed_by" uuid,
	"assessed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lead_fit_assessments_verdict_ck" CHECK ("lead_fit_assessments"."verdict" in ('fit', 'partial', 'not_fit', 'unknown')),
	CONSTRAINT "lead_fit_assessments_size_ck" CHECK (octet_length("lead_fit_assessments"."criteria"::text) + octet_length("lead_fit_assessments"."missing"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "mia_runs" DROP CONSTRAINT "mia_runs_capability_ck";--> statement-breakpoint
ALTER TABLE "mia_runs" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "mia_runs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "lead_fit_assessments" ADD CONSTRAINT "lead_fit_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_fit_assessments" ADD CONSTRAINT "lead_fit_assessments_assessed_by_users_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_fit_assessments" ADD CONSTRAINT "lead_fit_assessments_person_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_fit_assessments" ADD CONSTRAINT "lead_fit_assessments_icp_fk" FOREIGN KEY ("icp_item_id","organization_id") REFERENCES "public"."knowledge_documents"("id","organization_id") ON DELETE SET NULL ("icp_item_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_fit_assessments_org_verdict_idx" ON "lead_fit_assessments" USING btree ("organization_id","verdict");--> statement-breakpoint
ALTER TABLE "mia_runs" ADD CONSTRAINT "mia_runs_person_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mia_runs_one_fit_uq" ON "mia_runs" USING btree ("organization_id","person_id") WHERE "mia_runs"."capability" = 'lead_fit' and "mia_runs"."status" in ('queued', 'running', 'waiting_limit');--> statement-breakpoint
CREATE INDEX "mia_runs_org_batch_idx" ON "mia_runs" USING btree ("organization_id","batch_id") WHERE "mia_runs"."batch_id" is not null;--> statement-breakpoint
ALTER TABLE "mia_runs" ADD CONSTRAINT "mia_runs_fit_person_ck" CHECK (("mia_runs"."capability" = 'lead_fit') = ("mia_runs"."person_id" is not null and "mia_runs"."batch_id" is not null));--> statement-breakpoint
ALTER TABLE "mia_runs" ADD CONSTRAINT "mia_runs_capability_ck" CHECK ("mia_runs"."capability" in ('brain_fill_url', 'brain_fill_text', 'brain_sort', 'lead_fit'));