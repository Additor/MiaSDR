CREATE TABLE "grid_user_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"view" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_user_views_table_user_uq" UNIQUE("table_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grid_user_views" ADD CONSTRAINT "grid_user_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_user_views" ADD CONSTRAINT "grid_user_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_user_views" ADD CONSTRAINT "grid_user_views_table_id_organization_id_grid_tables_id_organization_id_fk" FOREIGN KEY ("table_id","organization_id") REFERENCES "public"."grid_tables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_org_direction_sent_idx" ON "messages" USING btree ("organization_id","direction","sent_at");