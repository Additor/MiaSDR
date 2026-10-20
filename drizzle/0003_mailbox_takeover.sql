ALTER TABLE "mailboxes" ADD COLUMN "unavailable_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "taken_over_from_mailbox_id" uuid;