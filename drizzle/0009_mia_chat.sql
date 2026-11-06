CREATE TABLE "mia_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"role" text NOT NULL,
	"client_id" text,
	"status" text NOT NULL,
	"parts" jsonb NOT NULL,
	"usage" jsonb,
	"provider" text,
	"model" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mia_messages_client_uq" UNIQUE("thread_id","client_id"),
	CONSTRAINT "mia_messages_role_ck" CHECK ("mia_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "mia_messages_status_ck" CHECK ("mia_messages"."status" in ('streaming', 'complete', 'stopped', 'failed', 'interrupted')),
	CONSTRAINT "mia_messages_parts_size_ck" CHECK (octet_length("mia_messages"."parts"::text) <= 262144),
	CONSTRAINT "mia_messages_client_ck" CHECK (("mia_messages"."role" = 'user') = ("mia_messages"."client_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "mia_thread_people" (
	"thread_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"first_turn_id" uuid,
	"first_linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mia_thread_people_pk" PRIMARY KEY("thread_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "mia_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid,
	"title" text,
	"turn_token" uuid,
	"turn_started_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mia_threads_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "mia_threads_title_ck" CHECK ("mia_threads"."title" is null or length("mia_threads"."title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "mia_messages" ADD CONSTRAINT "mia_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_messages" ADD CONSTRAINT "mia_messages_thread_fk" FOREIGN KEY ("thread_id","organization_id") REFERENCES "public"."mia_threads"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_thread_people" ADD CONSTRAINT "mia_thread_people_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_thread_people" ADD CONSTRAINT "mia_thread_people_thread_fk" FOREIGN KEY ("thread_id","organization_id") REFERENCES "public"."mia_threads"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_thread_people" ADD CONSTRAINT "mia_thread_people_person_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_threads" ADD CONSTRAINT "mia_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_threads" ADD CONSTRAINT "mia_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mia_threads" ADD CONSTRAINT "mia_threads_person_fk" FOREIGN KEY ("person_id","organization_id") REFERENCES "public"."people"("id","organization_id") ON DELETE SET NULL ("person_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mia_messages_org_thread_idx" ON "mia_messages" USING btree ("organization_id","thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "mia_messages_org_created_idx" ON "mia_messages" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "mia_thread_people_org_person_idx" ON "mia_thread_people" USING btree ("organization_id","person_id");--> statement-breakpoint
CREATE INDEX "mia_threads_org_user_idx" ON "mia_threads" USING btree ("organization_id","user_id","last_message_at" DESC NULLS LAST);