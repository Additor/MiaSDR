ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_id_org_uq" UNIQUE("id","organization_id");--> statement-breakpoint
CREATE TABLE "mcp_rate_limits" (
	"organization_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "mcp_rate_limits_organization_id_token_id_bucket_pk" PRIMARY KEY("organization_id","token_id","bucket"),
	CONSTRAINT "mcp_rate_limits_count_ck" CHECK ("mcp_rate_limits"."count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "mcp_rate_limits" ADD CONSTRAINT "mcp_rate_limits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_rate_limits" ADD CONSTRAINT "mcp_rate_limits_token_fk" FOREIGN KEY ("token_id","organization_id") REFERENCES "public"."mcp_tokens"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
