-- After a reply: a dedicated "turned on at" timestamp. The engine starts runs only for replies that arrived no earlier than
-- a margin before the flow was turned on. It read sequences.updated_at for that, which any other write moves forward.
--
--   * sequences.after_reply_enabled_at is nullable and written only by the flow save, when the flow switches from off to on.
--   * Backfill: every active campaign-owned flow takes its updated_at, the value the engine read until now.
--
-- Locks: ADD COLUMN without a default is a catalog change. The backfill touches the few campaign-owned rows of the table.
-- The migrator runs all pending migrations in one transaction.
ALTER TABLE "sequences" ADD COLUMN "after_reply_enabled_at" timestamp with time zone;--> statement-breakpoint
UPDATE "sequences" SET "after_reply_enabled_at" = "updated_at" WHERE "campaign_id" IS NOT NULL AND "status" = 'active';
