import { sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { events } from "@/platform/db/schema";
import { NotFoundError, viaMeta } from "@/shared/errors";
import type { AssignmentStore } from "../application/assignment";
import { ASSIGNED_EVENT, planAssign, planClaim } from "../domain/assignment";
import { rowsOf } from "@/platform/db/sql-values";

export const drizzleAssignmentStore: AssignmentStore = {
  async change({ organizationId, conversationId, actorUserId, via, change, now }) {
    return db.transaction(async (tx) => {
      // The same lock the other conversation writers take, so a claim and a reclassification wait for each other. The row is
      const [row] = rowsOf<{ person_id: string; assigned_to: string | null }>(
        await tx.execute(sql`
          select r.person_id, r.assigned_to from conversations r
          where r.id = ${conversationId} and r.organization_id = ${organizationId}
          for no key update`),
      );
      if (!row) throw new NotFoundError("Reply handling not found");

      let targetIsMember = false;
      if (change.kind === "assign" && change.target !== null) {
        targetIsMember = rowsOf<{ one: number }>(await tx.execute(sql`select 1 as one from members where organization_id = ${organizationId} and user_id = ${change.target}`)).length > 0;
      }
      const plan = change.kind === "claim" ? planClaim(row.assigned_to, actorUserId) : planAssign({ current: row.assigned_to, expected: change.expected, target: change.target, targetIsMember });
      if (!plan.changed) return { conversationId, assignedTo: plan.assignedTo, previousAssignedTo: row.assigned_to, changed: false };

      // Not the context version, not updated_at: an assignment is not a reclassification, and the queue reads updated_at as
      // the time a conversation went into error.
      await tx.execute(sql`update conversations set assigned_to = ${plan.assignedTo}, assigned_source = ${plan.source} where id = ${conversationId} and organization_id = ${organizationId}`);

      const names = new Map(
        rowsOf<{ id: string; name: string }>(
          await tx.execute(sql`select id, name from users where id in (${sql.join([plan.from, plan.assignedTo].filter((id): id is string => id !== null).map((id) => sql`${id}::uuid`), sql`, `)})`),
        ).map((u) => [u.id, u.name] as const),
      );
      const side = (id: string | null) => ({ assignedTo: id, assigneeName: id ? (names.get(id) ?? null) : null });
      await tx.insert(events).values({
        organizationId,
        personId: row.person_id,
        conversationId,
        eventType: ASSIGNED_EVENT,
        actorType: "human",
        actorUserId,
        fromData: side(plan.from),
        toData: side(plan.assignedTo),
        meta: { source: "human", action: change.kind, ...viaMeta(via) },
        createdAt: now,
      });
      return { conversationId, assignedTo: plan.assignedTo, previousAssignedTo: row.assigned_to, changed: true };
    });
  },
};
