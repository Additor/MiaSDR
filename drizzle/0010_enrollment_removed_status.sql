ALTER TABLE "campaign_enrollments" DROP CONSTRAINT "enrollments_status_ck";--> statement-breakpoint
ALTER TABLE "campaign_enrollments" ADD CONSTRAINT "enrollments_status_ck" CHECK ("campaign_enrollments"."status" in ('pending', 'active', 'replied', 'completed', 'bounced', 'suppressed', 'failed', 'cancelled', 'removed'));
