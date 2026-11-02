CREATE TABLE "mcp_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"action" text,
	"kind" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"client_name" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_calls_kind_ck" CHECK ("mcp_tool_calls"."kind" in ('read', 'write')),
	CONSTRAINT "mcp_tool_calls_duration_ck" CHECK ("mcp_tool_calls"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_token_fk" FOREIGN KEY ("token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_org_created_idx" ON "mcp_tool_calls" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_created_idx" ON "mcp_tool_calls" USING btree ("created_at");