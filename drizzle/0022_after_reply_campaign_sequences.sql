-- After a reply (campaign-owned sequences): a campaign owns at most one follow-up sequence, its "After a reply" flow.
-- Hand-edited from the drizzle-kit output; the snapshot is the generated one.
--
--   * sequences.campaign_id is nullable. A sequence with a campaign is that campaign's flow; a sequence without one is a
--     legacy standalone sequence. Mode is state: `ai_drafts` is a campaign-owned sequence that is active and has a published
--     version, `handoff` is no row or an archived one.
--   * The composite key (campaign_id, organization_id) follows campaigns_id_org_uq, like every other campaign reference.
--     MATCH SIMPLE: a null campaign_id is not checked. ON DELETE CASCADE removes the flow with its campaign.
--   * The name stays unique per organization among legacy sequences only (partial unique index, same name as before).
--     A campaign-owned flow is named after its campaign, and campaign names are not unique, so they are exempt.
--   * One flow per campaign: partial unique index on campaign_id.
--   * Legacy standalone sequences are archived. The engine starts runs only from active sequences, so no new run starts
--     from them. Runs already in flight keep the version they are pinned to. Rows and their runs are kept.
--
-- Deleting a campaign: the cascade deletes the flow, its versions and their steps. The published-version triggers from 0016
-- allow that (pg_trigger_depth() > 1 inside a cascade). The RESTRICT keys from sequence_runs (sequence_id and
-- sequence_version_id) block it when any run exists; a campaign with runs has sent mail and is never a draft.
--
-- Locks: ADD COLUMN without a default is a catalog change. The foreign key is added NOT VALID and validated afterwards, as in
-- 0014 (the column is new, so every row passes). The unique indexes build over the sequences table, which holds a handful
-- of rows per organization. The migrator runs all pending migrations in one transaction.
ALTER TABLE "sequences" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_campaign_id_organization_id_campaigns_id_organization_id_fk" FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."campaigns"("id","organization_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "sequences" VALIDATE CONSTRAINT "sequences_campaign_id_organization_id_campaigns_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "sequences" DROP CONSTRAINT "sequences_org_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "sequences_org_name_uq" ON "sequences" USING btree ("organization_id","name") WHERE "sequences"."campaign_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sequences_campaign_uq" ON "sequences" USING btree ("campaign_id") WHERE "sequences"."campaign_id" is not null;--> statement-breakpoint
UPDATE "sequences" SET "status" = 'archived', "updated_at" = now() WHERE "campaign_id" IS NULL AND "status" <> 'archived';
