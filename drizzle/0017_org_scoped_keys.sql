ALTER TABLE "identity_exceptions" DROP CONSTRAINT "identity_exceptions_event_uq";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_idempotency_uq";--> statement-breakpoint
ALTER TABLE "send_attempts" DROP CONSTRAINT "send_attempts_idempotency_key_unique";--> statement-breakpoint
DROP INDEX "conversations_thread_uq";--> statement-breakpoint
DROP INDEX "messages_provider_id_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_org_thread_uq" ON "conversations" USING btree ("organization_id","channel","account_ref","provider_thread_id") WHERE "conversations"."provider_thread_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_org_idempotency_uq" ON "messages" USING btree ("organization_id","channel","account_ref","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_org_provider_id_uq" ON "messages" USING btree ("organization_id","channel","account_ref","provider_message_id") WHERE "messages"."provider_message_id" is not null;--> statement-breakpoint
ALTER TABLE "identity_exceptions" ADD CONSTRAINT "identity_exceptions_event_uq" UNIQUE("organization_id","channel","account_ref","source_event_key");--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_org_idempotency_uq" UNIQUE("organization_id","idempotency_key");