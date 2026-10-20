-- Actions work queue ("Actions work queue" in docs/decisions.md). Additive.
--
--   * records.assigned_to: the member who handles the replies of the record. Null means unassigned. It is not the deal's owner
--     (deals.owner_user_id) and not a task's assignee (tasks.assigned_to).
--   * records.assigned_source: 'auto' when the campaign creator was assigned on the first inbound message or by the backfill
--     below, 'human' when a person claimed or assigned, 'cleared' when a person chose Nobody (the next inbound message then does
--     not hand the record back to the campaign creator). Read as an assignee's source only while assigned_to is set. It is not
--     tied to assigned_to by a pair CHECK, because the foreign key below nulls assigned_to alone.
--   * records_assigned_to_fk: (organization_id, assigned_to) -> members (organization_id, user_id), ON DELETE SET NULL
--     (assigned_to). Removing a member deletes the members row and leaves the users row, so a plain key to users would keep the
--     record assigned to someone who left, and would accept a user of another organization. members_organization_user_uq gives
--     the key its unique target. Drizzle writes the key without the column list; it is edited by hand here, like 0012.
--   * records_assigned_source_ck: a known source, and a source whenever assigned_to is set.
--   * records_org_assigned_idx: the queue reads a person's records by assignee and state, and the key above reads this index
--     when a member is deleted.
--   * Backfill: every record without an assignee gets the creator of the person's newest campaign enrollment that is not
--     removed, in a regular campaign, when that creator is still a member. Rule 'pickAssignee' of domain/assignment.ts: the
--     newest enrollment whose creator is a member wins, and a creator who left is skipped. No event is written for it.
--
-- Locks: the column adds and the key take ACCESS EXCLUSIVE and SHARE ROW EXCLUSIVE on records until commit (the migrator runs all
-- pending migrations in one transaction). The key is added on a column that is still null everywhere, so its check scans only.
-- The backfill updates every record that has a matching enrollment. Size the window on a copy before release, as for 0025.
--
-- Rollback: roll forward only. Dropping the two columns undoes it.

ALTER TABLE "records" ADD COLUMN "assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "assigned_source" text;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_assigned_to_fk" FOREIGN KEY ("organization_id","assigned_to") REFERENCES "public"."members"("organization_id","user_id") ON DELETE SET NULL ("assigned_to") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_assigned_source_ck" CHECK (("records"."assigned_source" is null or "records"."assigned_source" in ('auto', 'human', 'cleared')) and ("records"."assigned_to" is null or "records"."assigned_source" is not null));--> statement-breakpoint
UPDATE "records" r SET "assigned_to" = a.user_id, "assigned_source" = 'auto'
FROM (
	SELECT DISTINCT ON (r2.id) r2.id AS record_id, c.created_by AS user_id
	FROM "records" r2
	JOIN "campaign_enrollments" e ON e.person_id = r2.person_id AND e.organization_id = r2.organization_id AND e.status <> 'removed'
	JOIN "campaigns" c ON c.id = e.campaign_id AND c.organization_id = e.organization_id AND c.type = 'regular'
	JOIN "members" m ON m.organization_id = c.organization_id AND m.user_id = c.created_by
	ORDER BY r2.id, e.created_at DESC, e.id DESC
) a
WHERE r.id = a.record_id AND r.assigned_to IS NULL;--> statement-breakpoint
CREATE INDEX "records_org_assigned_idx" ON "records" USING btree ("organization_id","assigned_to","workflow_state");
