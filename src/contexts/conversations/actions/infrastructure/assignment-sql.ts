import { sql } from "drizzle-orm";
import { events } from "@/platform/db/schema";
import { ASSIGNED_EVENT, pickAssignee } from "../domain/assignment";
import type { Tx } from "../../infrastructure/drizzle-conversation-store";
import { rowsOf } from "@/platform/db/sql-values";

/**
 * Gives a record without an assignee to the creator of its person's newest regular-campaign enrollment that is not removed,
 * when that creator is still a member (`pickAssignee` skips one who left). Runs in the transaction that stores an inbound
 * message. It never replaces a person's choice: a record that has an assignee is left alone, and so is one a person set to
 * Nobody (`assigned_source = 'cleared'`). The update guards both again in case another transaction changed it first. Returns the assignee, or null when nobody was assigned.
 *
 * Reads outreach tables (campaigns, enrollments) and the membership table, read only, like the other stores of this context.
 * A personal campaign never counts: its threads are private and the record is not shown in the queue because of them.
 */
export async function autoAssignTx(tx: Tx, input: { organizationId: string; recordId: string; personId: string; now?: Date }): Promise<string | null> {
  const [held] = rowsOf<{ assigned_to: string | null; assigned_source: string | null }>(await tx.execute(sql`select assigned_to, assigned_source from records where id = ${input.recordId} and organization_id = ${input.organizationId}`));
  // A record that has an assignee stays as it is, and so does one a person left on Nobody.
  if (!held || held.assigned_to !== null || held.assigned_source === "cleared") return null;

  const candidates = rowsOf<{ user_id: string; is_member: boolean }>(
    await tx.execute(sql`
      select c.created_by as user_id, (m.user_id is not null) as is_member
      from campaign_enrollments e
      join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id and c.type = 'regular'
      left join members m on m.organization_id = c.organization_id and m.user_id = c.created_by
      where e.organization_id = ${input.organizationId} and e.person_id = ${input.personId} and e.status <> 'removed' and c.created_by is not null
      order by e.created_at desc, e.id desc`),
  );
  const assignee = pickAssignee(candidates.map((c) => ({ userId: c.user_id, isMember: c.is_member })));
  if (!assignee) return null;

  const updated = rowsOf<{ id: string }>(
    await tx.execute(sql`
      update records set assigned_to = ${assignee}, assigned_source = 'auto'
      where id = ${input.recordId} and organization_id = ${input.organizationId} and assigned_to is null and assigned_source is distinct from 'cleared'
      returning id`),
  );
  if (updated.length === 0) return null;

  const [named] = rowsOf<{ name: string }>(await tx.execute(sql`select name from users where id = ${assignee}`));
  await tx.insert(events).values({
    organizationId: input.organizationId,
    personId: input.personId,
    recordId: input.recordId,
    eventType: ASSIGNED_EVENT,
    actorType: "system",
    fromData: { assignedTo: null, assigneeName: null },
    toData: { assignedTo: assignee, assigneeName: named?.name ?? null },
    meta: { source: "auto" },
    ...(input.now ? { createdAt: input.now } : {}),
  });
  return assignee;
}
