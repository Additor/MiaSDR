ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_provider_ck";--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD COLUMN "provider" text DEFAULT 'unipile' NOT NULL;--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD COLUMN "inbound_cursor" jsonb;--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD COLUMN "inbound_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_provider_ck" CHECK ("inbound_events"."provider" in ('gmail', 'unipile', 'edges'));--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_provider_ck" CHECK ("linkedin_accounts"."provider" in ('unipile', 'edges'));