import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { linkedinAccounts } from "@/platform/db/schema";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { defaultWorkingHours, type WorkingHours } from "../../domain/working-hours";
import type { LinkedInInboundPollStore } from "../application/linkedin-ports";
import { disconnectLinkedInAccount, VENDORS_READ_BY_POLL } from "./linkedin-account-state";

/** Where reading an account's inbox has got to, for a vendor with no webhook for messages. */
export const drizzleLinkedInInboundPollStore: LinkedInInboundPollStore = {
  async listDue(readBefore) {
    const rows = await db
      .select({
        id: linkedinAccounts.id,
        organizationId: linkedinAccounts.organizationId,
        provider: linkedinAccounts.provider,
        providerAccountId: linkedinAccounts.providerAccountId,
        cursor: linkedinAccounts.inboundCursor,
        workingHours: linkedinAccounts.workingHours,
      })
      .from(linkedinAccounts)
      .where(
        and(
          inArray(linkedinAccounts.provider, VENDORS_READ_BY_POLL),
          eq(linkedinAccounts.status, "connected"),
          or(isNull(linkedinAccounts.inboundReadAt), lt(linkedinAccounts.inboundReadAt, readBefore)),
        ),
      )
      .orderBy(sql`${linkedinAccounts.inboundReadAt} asc nulls first`, asc(linkedinAccounts.id));
    return Promise.all(
      rows.map(async (row) => ({ ...row, workingHours: (row.workingHours as WorkingHours | null) ?? defaultWorkingHours(await organizationTimeZone(row.organizationId)) })),
    );
  },

  async saveCursor(accountId, cursor, finishedRunStartedAt) {
    await db
      .update(linkedinAccounts)
      .set({ inboundCursor: cursor, ...(finishedRunStartedAt ? { inboundReadAt: finishedRunStartedAt } : {}) })
      .where(eq(linkedinAccounts.id, accountId));
  },

  disconnect: (accountId, error) => disconnectLinkedInAccount(db, accountId, error),
};
