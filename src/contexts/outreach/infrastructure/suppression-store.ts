import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaignEnrollments, people, suppressionList } from "@/platform/db/schema";
import type { FollowUpStop } from "../application/inbound-ports";
import type { SuppressionStore } from "../email/application/unsubscribe";
import { LIVE_ENROLLMENT_STATUSES } from "../domain/enrollment-status";

/** Adds the address to the suppression list and stops its unfinished email sequences, in one transaction. */
export const createSuppressionStore = (followUps: FollowUpStop): SuppressionStore => ({
  async suppressEmail({ organizationId, email, reason, note }) {
    const normalized = email.trim().toLowerCase();
    return db.transaction(async (tx) => {
      await tx
        .insert(suppressionList)
        .values({ organizationId, email: normalized, reason, note: note ?? null })
        .onConflictDoNothing();
      const stopped = await tx
        .update(campaignEnrollments)
        .set({ status: reason === "bounced" ? "bounced" : "suppressed", nextSendAt: null, stopReason: reason })
        .where(
          and(
            eq(campaignEnrollments.organizationId, organizationId),
            eq(campaignEnrollments.channel, "email"),
            inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES]),
            inArray(
              campaignEnrollments.personId,
              tx
                .select({ id: people.id })
                .from(people)
                .where(and(eq(people.organizationId, organizationId), sql`lower(${people.email}) = ${normalized}`)),
            ),
          ),
        )
        .returning({ id: campaignEnrollments.id });
      // The follow-up sequence of a conversation stops in the same commit, with its unsent drafts.
      await followUps.endEmailRunsTx(tx, organizationId, normalized, reason === "bounced" ? "bounce" : reason === "manual" ? "suppressed" : "unsubscribed", new Date());
      return { stopped: stopped.length };
    });
  },
});
