ALTER TABLE "campaigns" ADD COLUMN "person_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Nobody knows who paused a campaign before this column, so a person resumes every campaign paused at upgrade time.
UPDATE "campaigns" SET "person_paused" = true WHERE "status" = 'paused';
