CREATE TABLE "stop_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stop_reviews_message_uq" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "stop_reviews" ADD CONSTRAINT "stop_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_reviews" ADD CONSTRAINT "stop_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_reviews" ADD CONSTRAINT "stop_reviews_message_fk" FOREIGN KEY ("message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stop_reviews_org_idx" ON "stop_reviews" USING btree ("organization_id");--> statement-breakpoint
-- A stop request whose picks no longer wait counts as reviewed, as the send gate read it until now. An agent's undo, seen
-- mark or type change since the pick is no person's review, so that reply stays open.
INSERT INTO "stop_reviews" ("organization_id", "message_id", "reviewed_at")
SELECT DISTINCT k."organization_id", k."message_id", now()
FROM "reply_type_picks" k
LEFT JOIN "reply_types" t ON t."id" = k."proposed_reply_type_id"
WHERE (coalesce((k."response"->>'stopRequested')::boolean, false) OR t."system_role" = 'stop_request')
  AND NOT EXISTS (
    SELECT 1 FROM "reply_type_picks" w
    JOIN "records" r ON r."id" = w."record_id"
    WHERE w."message_id" = k."message_id"
      AND (w."status" = 'proposed'
        OR (w."status" = 'auto_applied' AND w."acknowledged_at" IS NULL
          AND w."applied_reply_type_id" IS NOT DISTINCT FROM r."reply_type_id" AND w."applied_group_key" IS NOT DISTINCT FROM r."group_key"))
  )
  AND NOT EXISTS (
    SELECT 1 FROM "events" e
    WHERE e."record_id" = k."record_id" AND e."created_at" >= k."created_at" AND e."meta" ? 'via'
      AND e."event_type" IN ('reply_type.changed', 'reply_type_pick.undone', 'reply_type_pick.acknowledged')
  );
