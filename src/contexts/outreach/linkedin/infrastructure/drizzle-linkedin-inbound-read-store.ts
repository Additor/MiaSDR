import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { linkedinAccounts } from "@/platform/db/schema";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { defaultWorkingHours, type WorkingHours } from "../../domain/working-hours";
import type { LinkedInInboundPollStore } from "../application/linkedin-ports";
import { disconnectLinkedInAccount } from "./linkedin-account-state";
import { VENDORS_READ_BY_POLL } from "./linkedin-vendor-facts";

const a = linkedinAccounts;

/** Connected on a polled vendor, last read before `readBefore`, and held by nothing at `now`. */
const due = (readBefore: Date, now: Date) =>
  and(inArray(a.provider, VENDORS_READ_BY_POLL), eq(a.status, "connected"), or(isNull(a.inboundReadAt), lt(a.inboundReadAt, readBefore)), or(isNull(a.inboundLeaseUntil), lte(a.inboundLeaseUntil, now)));

/** Where reading an account's inbox has got to, for a vendor with no webhook for messages. */
export const drizzleLinkedInInboundPollStore: LinkedInInboundPollStore = {
  async listDue(readBefore, now) {
    const rows = await db
      .select({ id: a.id, organizationId: a.organizationId, provider: a.provider, providerAccountId: a.providerAccountId, workingHours: a.workingHours })
      .from(a)
      .where(due(readBefore, now))
      .orderBy(sql`${a.inboundReadAt} asc nulls first`, asc(a.id));
    // An account outside its hours stays due all night, so a zone is read once per organization, not once per account and tick.
    const organizations = [...new Set(rows.filter((row) => !row.workingHours).map((row) => row.organizationId))];
    const zones = new Map(await Promise.all(organizations.map(async (id) => [id, await organizationTimeZone(id)] as const)));
    return rows.map((row) => ({ ...row, workingHours: (row.workingHours as WorkingHours | null) ?? defaultWorkingHours(zones.get(row.organizationId) as string) }));
  },

  async claim(accountId, { readBefore, now, until }) {
    const [row] = await db
      .update(a)
      .set({ inboundLeaseUntil: until })
      .where(and(eq(a.id, accountId), due(readBefore, now)))
      .returning({ cursor: a.inboundCursor });
    return row ?? null;
  },

  async saveCursor(accountId, cursor, finishedRunStartedAt) {
    await db
      .update(a)
      .set({ inboundCursor: cursor, ...(finishedRunStartedAt ? { inboundReadAt: finishedRunStartedAt } : {}) })
      .where(eq(a.id, accountId));
  },

  async release(accountId, retryAt) {
    await db.update(a).set({ inboundLeaseUntil: retryAt }).where(eq(a.id, accountId));
  },

  disconnect: (accountId, error) => disconnectLinkedInAccount(db, accountId, error),
};
