import { sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { events } from "@/platform/db/schema";
import { NotFoundError } from "@/shared/errors";
import type { AssignmentStore } from "../application/assignment";
import { ASSIGNED_EVENT, planAssign, planClaim } from "../domain/assignment";
import { visibleRecordSql } from "@/platform/db/conversation-visibility";
import { rowsOf } from "@/platform/db/sql-values";

export const drizzleAssignmentStore: AssignmentStore = {
  async change({ organizationId, recordId, actorUserId, change, now }) {
    return db.transaction(async (tx) => {
      // The same lock the other record writers take, so a claim and a reclassification wait for each other. The row is
      // read through the visibility rule: a record that exists only for a private thread answers 404.
      const [row] = rowsOf<{ person_id: string; assigned_to: string | null }>(
        await tx.execute(sql`
          select r.person_id, r.assigned_to from records r
          where r.id = ${recordId} and r.organization_id = ${organizationId} and ${visibleRecordSql("r")}
          for no key update`),
      );
      if (!row) throw new NotFoundError("Reply handling not found");

      let targetIsMember = false;
      if (change.kind === "assign" && change.target !== null) {
        targetIsMember = rowsOf<{ one: number }>(await tx.execute(sql`select 1 as one from members where organization_id = ${organizationId} and user_id = ${change.target}`)).length > 0;
      }
      const plan = change.kind === "claim" ? planClaim(row.assigned_to, actorUserId) : planAssign({ current: row.assigned_to, expected: change.expected, target: change.target, targetIsMember });
      if (!plan.changed) return { recordId, assignedTo: plan.assignedTo, previousAssignedTo: row.assigned_to, changed: false };

      // Not the context version, not updated_at: an assignment is not a reclassification, and the queue reads updated_at as
      // the time a record went into error.
      await tx.execute(sql`update records set assigned_to = ${plan.assignedTo}, assigned_source = ${plan.source} where id = ${recordId} and organization_id = ${organizationId}`);

      const names = new Map(
        rowsOf<{ id: string; name: string }>(
          await tx.execute(sql`select id, name from users where id in (${sql.join([plan.from, plan.assignedTo].filter((id): id is string => id !== null).map((id) => sql`${id}::uuid`), sql`, `)})`),
        ).map((u) => [u.id, u.name] as const),
      );
      const side = (id: string | null) => ({ assignedTo: id, assigneeName: id ? (names.get(id) ?? null) : null });
      await tx.insert(events).values({
        organizationId,
        personId: row.person_id,
        recordId,
        eventType: ASSIGNED_EVENT,
        actorType: "human",
        actorUserId,
        fromData: side(plan.from),
        toData: side(plan.assignedTo),
        meta: { source: "human", action: change.kind },
        createdAt: now,
      });
      return { recordId, assignedTo: plan.assignedTo, previousAssignedTo: row.assigned_to, changed: true };
    });
  },
};
