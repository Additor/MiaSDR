CREATE TABLE "linkedin_open_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"linkedin_account_id" uuid NOT NULL,
	"provider_account_ref" text NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"api" text,
	"row_limit" integer,
	"submitted_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "linkedin_open_operations_subject_uq" UNIQUE("kind","subject_id"),
	CONSTRAINT "linkedin_open_operations_kind_ck" CHECK ("linkedin_open_operations"."kind" in ('invitation', 'message', 'lookup', 'search', 'reply_check'))
);
--> statement-breakpoint
ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_provider_ck";--> statement-breakpoint
ALTER TABLE "linkedin_accounts" DROP CONSTRAINT "linkedin_accounts_provider_ck";--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD COLUMN "inbox_gap_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linkedin_connect_links" ADD COLUMN "reconnect_account_id" uuid;--> statement-breakpoint
ALTER TABLE "linkedin_enrollment_details" ADD COLUMN "member_urn" text;--> statement-breakpoint
ALTER TABLE "linkedin_enrollment_details" ADD COLUMN "resolve_next_api" text;--> statement-breakpoint
ALTER TABLE "linkedin_enrollment_details" ADD COLUMN "resolve_next_account" uuid;--> statement-breakpoint
ALTER TABLE "linkedin_enrollment_details" ADD COLUMN "reply_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD COLUMN "provider_operation_id" text;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD COLUMN "provider_operation_account" text;--> statement-breakpoint
ALTER TABLE "linkedin_open_operations" ADD CONSTRAINT "linkedin_open_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_open_operations" ADD CONSTRAINT "linkedin_open_operations_linkedin_account_id_organization_id_linkedin_accounts_id_organization_id_fk" FOREIGN KEY ("linkedin_account_id","organization_id") REFERENCES "public"."linkedin_accounts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linkedin_open_operations_org_idx" ON "linkedin_open_operations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "linkedin_open_operations_account_idx" ON "linkedin_open_operations" USING btree ("linkedin_account_id");--> statement-breakpoint
CREATE INDEX "linkedin_open_operations_checked_idx" ON "linkedin_open_operations" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "linkedin_details_member_urn_idx" ON "linkedin_enrollment_details" USING btree ("member_urn");--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_provider_ck" CHECK ("inbound_events"."provider" in ('gmail', 'unipile', 'edges', 'gtmapi', 'linkedapi'));--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_provider_ck" CHECK ("linkedin_accounts"."provider" in ('unipile', 'edges', 'gtmapi', 'linkedapi'));