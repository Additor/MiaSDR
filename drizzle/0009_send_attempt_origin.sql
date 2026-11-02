ALTER TABLE "send_attempts" ADD COLUMN "origin" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD COLUMN "mcp_token_id" uuid;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_mcp_token_fk" FOREIGN KEY ("mcp_token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE SET NULL ("mcp_token_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "send_attempts_agent_org_idx" ON "send_attempts" USING btree ("organization_id","created_at") WHERE "send_attempts"."origin" = 'agent';--> statement-breakpoint
CREATE INDEX "send_attempts_agent_user_idx" ON "send_attempts" USING btree ("organization_id","actor_user_id","created_at") WHERE "send_attempts"."origin" = 'agent';--> statement-breakpoint
CREATE INDEX "send_attempts_agent_account_idx" ON "send_attempts" USING btree ("organization_id","account_ref","created_at") WHERE "send_attempts"."origin" = 'agent';--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_origin_ck" CHECK ("send_attempts"."origin" in ('person', 'agent') and ("send_attempts"."origin" = 'agent' or ("send_attempts"."mcp_token_id" is null and "send_attempts"."client_name" is null))) NOT VALID;--> statement-breakpoint
ALTER TABLE "send_attempts" VALIDATE CONSTRAINT "send_attempts_origin_ck";