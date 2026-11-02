CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"token_hint" text,
	"oauth_grant_id" text,
	"scopes" text[] NOT NULL,
	"policy_epoch" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "mcp_tokens_oauth_grant_uq" UNIQUE("oauth_grant_id"),
	CONSTRAINT "mcp_tokens_kind_ck" CHECK ("mcp_tokens"."kind" in ('pat', 'oauth')),
	CONSTRAINT "mcp_tokens_secret_ck" CHECK (("mcp_tokens"."kind" = 'pat' and "mcp_tokens"."token_hash" is not null and "mcp_tokens"."oauth_grant_id" is null) or ("mcp_tokens"."kind" = 'oauth' and "mcp_tokens"."oauth_grant_id" is not null and "mcp_tokens"."token_hash" is null and "mcp_tokens"."token_hint" is null)),
	CONSTRAINT "mcp_tokens_name_ck" CHECK (length(btrim("mcp_tokens"."name")) between 1 and 100),
	CONSTRAINT "mcp_tokens_policy_epoch_ck" CHECK ("mcp_tokens"."policy_epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tokens_org_user_idx" ON "mcp_tokens" USING btree ("organization_id","user_id");