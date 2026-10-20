import { and, eq, inArray } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { people } from "@/platform/db/schema";
import type { LeadLifecycleStore, Lifecycle } from "../application/convert-to-contact";

/*
 * The `people.lifecycle` transition. A lead becomes a contact with one update that sets `lifecycle` and `converted_at`
 * (CHECK `people_converted_at_ck` ties them); a trigger refuses the way back and any later change of `converted_at`.
 */

const CHUNK = 500;

/**
 * Marks a lead as a contact at `at`. Idempotent: a person who is already a contact keeps the first `converted_at` and the
 * call returns false. Scoped to the organization, so another organization's id changes nothing.
 */
export async function markConverted(tx: DbHandle, organizationId: string, personId: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(people)
    .set({ lifecycle: "contact", convertedAt: at, updatedAt: at })
    .where(and(eq(people.organizationId, organizationId), eq(people.id, personId), eq(people.lifecycle, "lead")))
    .returning({ id: people.id });
  return rows.length > 0;
}

const asLifecycle = (value: string): Lifecycle => (value === "contact" ? "contact" : "lead");

export const drizzleLeadLifecycle: LeadLifecycleStore = {
  async lifecycleOf(tx, organizationId, personId) {
    const [row] = await tx.select({ lifecycle: people.lifecycle }).from(people).where(and(eq(people.organizationId, organizationId), eq(people.id, personId)));
    return row ? asLifecycle(row.lifecycle) : null;
  },

  async lifecycles(organizationId, personIds) {
    const result = new Map<string, Lifecycle>();
    for (let i = 0; i < personIds.length; i += CHUNK) {
      const rows = await db
        .select({ id: people.id, lifecycle: people.lifecycle })
        .from(people)
        .where(and(eq(people.organizationId, organizationId), inArray(people.id, personIds.slice(i, i + CHUNK))));
      for (const row of rows) result.set(row.id, asLifecycle(row.lifecycle));
    }
    return result;
  },

  markConverted,
};
