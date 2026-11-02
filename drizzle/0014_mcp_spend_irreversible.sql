CREATE TABLE "mcp_agent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "mcp_agent_usage_org_day_kind_uq" UNIQUE("organization_id","day","kind"),
	CONSTRAINT "mcp_agent_usage_kind_ck" CHECK ("mcp_agent_usage"."kind" in ('spend_cents', 'search_leads', 'irreversible')),
	CONSTRAINT "mcp_agent_usage_amount_ck" CHECK ("mcp_agent_usage"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "spend_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "irreversible_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_agent_usage" ADD CONSTRAINT "mcp_agent_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_agent_usage_day_idx" ON "mcp_agent_usage" USING btree ("day");--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_spend_epoch_ck" CHECK ("mcp_tokens"."spend_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_irreversible_epoch_ck" CHECK ("mcp_tokens"."irreversible_epoch" >= 0);