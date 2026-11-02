import { and, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { linkedinAccounts, linkedinConnectLinks } from "@/platform/db/schema";
import type { ConnectLink, LinkedInConnectStore } from "../application/linkedin-connect-ports";

const t = linkedinConnectLinks;

const toLink = (r: typeof t.$inferSelect): ConnectLink => ({
  id: r.id,
  organizationId: r.organizationId,
  providerName: r.providerName,
  secretHash: r.secretHash,
  status: r.status as ConnectLink["status"],
  expiresAt: r.expiresAt,
  providerAccountId: r.providerAccountId,
  lastError: r.lastError,
  createdAt: r.createdAt,
  completedAt: r.completedAt,
});

export const drizzleLinkedInConnectStore: LinkedInConnectStore = {
  async create(link) {
    await db.insert(t).values({ id: link.id, organizationId: link.organizationId, providerName: link.providerName, secretHash: link.secretHash, expiresAt: link.expiresAt, createdBy: link.createdBy });
  },

  async find(id) {
    const [row] = await db.select().from(t).where(eq(t.id, id));
    return row ? toLink(row) : null;
  },

  async complete(id, { providerAccountId, now }) {
    // The account row, when the sync created it, ties the link to it. A missing row leaves the column empty.
    const [link] = await db.select({ organizationId: t.organizationId }).from(t).where(eq(t.id, id));
    if (!link) return false;
    const [account] = await db
      .select({ id: linkedinAccounts.id })
      .from(linkedinAccounts)
      .where(and(eq(linkedinAccounts.organizationId, link.organizationId), eq(linkedinAccounts.providerAccountId, providerAccountId)));
    const rows = await db
      .update(t)
      .set({ status: "completed", completedAt: now, providerAccountId, linkedinAccountId: account?.id ?? null, lastError: null })
      .where(and(eq(t.id, id), eq(t.status, "pending")))
      .returning({ id: t.id });
    return rows.length === 1;
  },

  async fail(id, error) {
    const rows = await db.update(t).set({ status: "failed", lastError: error.slice(0, 500) }).where(and(eq(t.id, id), eq(t.status, "pending"))).returning({ id: t.id });
    return rows.length === 1;
  },

  async noteError(id, error) {
    await db.update(t).set({ lastError: error.slice(0, 500) }).where(and(eq(t.id, id), eq(t.status, "pending")));
  },

  async expireDue(organizationId, now) {
    const rows = await db
      .update(t)
      .set({ status: "expired" })
      .where(and(eq(t.organizationId, organizationId), eq(t.status, "pending"), lte(t.expiresAt, now)))
      .returning({ id: t.id });
    return rows.length;
  },

  async countPending(organizationId, now) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(and(eq(t.organizationId, organizationId), eq(t.status, "pending"), sql`${t.expiresAt} > ${now.toISOString()}::timestamptz`));
    return n;
  },

  async listRecent(organizationId, limit, now) {
    const rows = await db.select().from(t).where(eq(t.organizationId, organizationId)).orderBy(desc(t.createdAt)).limit(limit);
    return rows.map((r) => {
      const link = toLink(r);
      // A pending link past its expiry reads as expired even before the next sweep marks it.
      const status = link.status === "pending" && link.expiresAt.getTime() <= now.getTime() ? ("expired" as const) : link.status;
      return { id: link.id, status, expiresAt: link.expiresAt, createdAt: link.createdAt, completedAt: link.completedAt, lastError: link.lastError };
    });
  },
};
