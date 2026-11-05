ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_provider_ck";--> statement-breakpoint
ALTER TABLE "linkedin_accounts" DROP CONSTRAINT "linkedin_accounts_provider_ck";--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD COLUMN "invites_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_provider_ck" CHECK ("inbound_events"."provider" in ('gmail', 'unipile', 'edges', 'gtmapi'));--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_provider_ck" CHECK ("linkedin_accounts"."provider" in ('unipile', 'edges', 'gtmapi'));