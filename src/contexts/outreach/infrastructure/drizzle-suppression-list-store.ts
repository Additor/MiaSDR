import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { recordAudit } from "@/platform/db/audit";
import { suppressionList } from "@/platform/db/schema";
import type { SuppressionListStore, SuppressionReason, SuppressionRow } from "../application/suppression-list";

const columns = { id: suppressionList.id, email: suppressionList.email, reason: suppressionList.reason, note: suppressionList.note, addedInSettings: suppressionList.addedInSettings, createdAt: suppressionList.createdAt };
const toRow = (row: { id: string; email: string; reason: string; note: string | null; addedInSettings: boolean; createdAt: Date }): SuppressionRow => ({ ...row, reason: row.reason as SuppressionReason });

/** `%` and `_` in a search are literal. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export const drizzleSuppressionListStore: SuppressionListStore = {
  async list(organizationId, { q, limit, offset }) {
    const where = and(eq(suppressionList.organizationId, organizationId), q ? like(suppressionList.email, `%${escapeLike(q)}%`) : undefined);
    const [rows, [{ total }]] = await Promise.all([
      db.select(columns).from(suppressionList).where(where).orderBy(desc(suppressionList.createdAt), suppressionList.email).limit(limit).offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(suppressionList).where(where),
    ]);
    return { rows: rows.map(toRow), total };
  },

  async existing(organizationId, emails) {
    if (emails.length === 0) return new Set();
    const rows = await db
      .select({ email: suppressionList.email })
      .from(suppressionList)
      .where(and(eq(suppressionList.organizationId, organizationId), inArray(suppressionList.email, [...emails])));
    return new Set(rows.map((r) => r.email));
  },

  async find(organizationId, id) {
    const [row] = await db.select(columns).from(suppressionList).where(and(eq(suppressionList.organizationId, organizationId), eq(suppressionList.id, id)));
    return row ? toRow(row) : null;
  },

  async remove(organizationId, id) {
    await db.delete(suppressionList).where(and(eq(suppressionList.organizationId, organizationId), eq(suppressionList.id, id), eq(suppressionList.addedInSettings, true)));
  },

  async audit(entry) {
    await recordAudit(db, { organizationId: entry.organizationId, actorUserId: entry.actorUserId, action: entry.action, entityType: "suppression", entityId: entry.entityId ?? undefined, meta: entry.meta });
  },
};
