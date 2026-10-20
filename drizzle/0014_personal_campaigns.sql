-- T5b-personal (DB-005): `campaigns.type` (regular | personal) and `conversations.private_campaign_id`.
-- Both columns are new, so every existing row already satisfies the constraints: type is 'regular' and the marker is null.
-- The constraints are still added NOT VALID and validated afterwards, as in 0012. The migrator runs all pending migrations in one transaction, so the ADD CONSTRAINT locks (ACCESS EXCLUSIVE for a CHECK, SHARE ROW EXCLUSIVE for a foreign key) last until commit. On a large table, run it in a maintenance window.
ALTER TABLE "campaigns" ADD COLUMN "type" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "private_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_type_ck" CHECK ("campaigns"."type" in ('regular', 'personal')) NOT VALID;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_personal_linkedin_ck" CHECK ("campaigns"."type" = 'regular' or "campaigns"."channel" = 'linkedin') NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_private_campaign_fk" FOREIGN KEY ("private_campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "campaigns" VALIDATE CONSTRAINT "campaigns_type_ck";--> statement-breakpoint
ALTER TABLE "campaigns" VALIDATE CONSTRAINT "campaigns_personal_linkedin_ck";--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_private_campaign_fk";--> statement-breakpoint
CREATE INDEX "conversations_private_idx" ON "conversations" USING btree ("organization_id","private_campaign_id") WHERE "conversations"."private_campaign_id" is not null;
