import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db, inTransaction } from "@/platform/db/client";
import { campaignEnrollments, campaignSenders, campaigns, linkedinAccounts, linkedinEnrollmentDetails, mailboxes } from "@/platform/db/schema";
import type { EnrollmentAdminStore, OutreachChannel, SenderRef } from "../application/enrollment-admin";
import { REMOVED_STATUS, canRemoveEnrollment } from "../domain/enrollment-status";
import { endEnrollmentsTx } from "./enrollment-end";
import { enrollPickedTx } from "./enrollment-eligibility";
import { SEND_COUNTED } from "../domain/send-status";
import { sqlValues } from "@/platform/db/sql-values";

const senderLabel = (channel: OutreachChannel) =>
  channel === "email"
    ? { id: mailboxes.id, label: mailboxes.emailAddress, status: mailboxes.status }
    : { id: linkedinAccounts.id, label: sql<string>`coalesce(${linkedinAccounts.name}, ${linkedinAccounts.username}, ${linkedinAccounts.id}::text)`, status: linkedinAccounts.status };

const toRef = (row: { id: string; label: string; status: string }): SenderRef => ({ id: row.id, label: row.label, connected: row.status === "connected" });

export const drizzleEnrollmentAdminStore: EnrollmentAdminStore = {
  enrollPicked(organizationId, campaignId, channel, personIds, options, handle) {
    return inTransaction(handle, (tx) => enrollPickedTx(tx, organizationId, campaignId, channel, personIds, options));
  },

  async removeEnrollments(organizationId, campaignId, channel, enrollmentIds, now) {
    const ids = [...new Set(enrollmentIds)];
    return db.transaction(async (tx) => {
      // The campaign join pins the campaign, the organization and the channel, so a foreign or mismatched id is simply absent.
      const found = await tx
        .select({ id: campaignEnrollments.id, status: campaignEnrollments.status })
        .from(campaignEnrollments)
        .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
        .where(
          and(
            eq(campaignEnrollments.organizationId, organizationId),
            eq(campaignEnrollments.campaignId, campaignId),
            eq(campaigns.channel, channel),
            inArray(campaignEnrollments.id, ids),
          ),
        )
        .orderBy(asc(campaignEnrollments.id))
        .for("update", { of: campaignEnrollments });
      const removable = found.filter((e) => canRemoveEnrollment(e.status)).map((e) => e.id);
      let live: string[] = [];
      if (removable.length > 0) {
        // The status condition repeats in the UPDATE, so a writer that raced us (a reply, a bounce) keeps its final status.
        const changed = await endEnrollmentsTx(tx, and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.id, removable)), { status: "removed", reason: "removed" }, now);
        live = changed.map((r) => r.id);
        if (channel === "linkedin" && live.length > 0) {
          await tx.update(linkedinEnrollmentDetails).set({ resolveNextAttemptAt: null }).where(inArray(linkedinEnrollmentDetails.enrollmentId, live));
        }
      }
      const alreadyRemoved = found.filter((e) => e.status === REMOVED_STATUS).length;
      const skippedFinal = found.length - live.length - alreadyRemoved;
      return { requested: ids.length, removed: live.length, alreadyRemoved, skippedFinal, notFound: ids.length - found.length };
    });
  },

  async listSenders(organizationId, campaignId, channel, tx) {
    const cols = senderLabel(channel);
    const handle = tx ?? db;
    if (channel === "email") {
      const rows = await handle
        .select(cols)
        .from(campaignSenders)
        .innerJoin(mailboxes, eq(mailboxes.id, campaignSenders.mailboxId))
        .where(and(eq(campaignSenders.organizationId, organizationId), eq(campaignSenders.campaignId, campaignId)))
        .orderBy(asc(mailboxes.emailAddress));
      return rows.map(toRef);
    }
    const rows = await handle
      .select(cols)
      .from(campaignSenders)
      .innerJoin(linkedinAccounts, eq(linkedinAccounts.id, campaignSenders.linkedinAccountId))
      .where(and(eq(campaignSenders.organizationId, organizationId), eq(campaignSenders.campaignId, campaignId)))
      .orderBy(asc(linkedinAccounts.createdAt));
    return rows.map(toRef);
  },

  async findSenders(organizationId, channel, ids, tx) {
    if (ids.length === 0) return [];
    const handle = tx ?? db;
    const rows =
      channel === "email"
        ? await handle.select(senderLabel("email")).from(mailboxes).where(and(eq(mailboxes.organizationId, organizationId), inArray(mailboxes.id, ids)))
        : await handle.select(senderLabel("linkedin")).from(linkedinAccounts).where(and(eq(linkedinAccounts.organizationId, organizationId), inArray(linkedinAccounts.id, ids)));
    return rows.map(toRef);
  },

  async listAvailableSenders(organizationId, channel) {
    const rows =
      channel === "email"
        ? await db.select(senderLabel("email")).from(mailboxes).where(eq(mailboxes.organizationId, organizationId)).orderBy(asc(mailboxes.emailAddress))
        : await db.select(senderLabel("linkedin")).from(linkedinAccounts).where(eq(linkedinAccounts.organizationId, organizationId)).orderBy(asc(linkedinAccounts.createdAt));
    return rows.map(toRef);
  },

  async replaceSenders(organizationId, campaignId, channel, ids, handle) {
    await inTransaction(handle, async (tx) => {
      // An emptied list inserts nothing, so no foreign key check would make it wait for an agent's launch that holds the
      // campaign row; the key share stands in for one, and the launch then reads the list the change left.
      if (ids.length === 0) await tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, campaignId))).for("key share");
      await tx.delete(campaignSenders).where(and(eq(campaignSenders.organizationId, organizationId), eq(campaignSenders.campaignId, campaignId)));
      if (ids.length === 0) return;
      await tx
        .insert(campaignSenders)
        .values(ids.map((id) => ({ organizationId, campaignId, ...(channel === "email" ? { mailboxId: id } : { linkedinAccountId: id }) })));
      if (channel === "linkedin") {
        // A pending lead not yet invited, pinned to an account that left the list, goes back to the resolve step so a listed account picks it up.
        const stale = await tx
          .update(campaignEnrollments)
          .set({ linkedinAccountId: null, updatedAt: new Date() })
          .where(
            and(
              eq(campaignEnrollments.organizationId, organizationId),
              eq(campaignEnrollments.campaignId, campaignId),
              eq(campaignEnrollments.channel, "linkedin"),
              eq(campaignEnrollments.status, "pending"),
              eq(campaignEnrollments.currentStep, 0),
              isNotNull(campaignEnrollments.linkedinAccountId),
              notInArray(campaignEnrollments.linkedinAccountId, ids),
              sql`not exists (select 1 from sends s where s.enrollment_id = ${campaignEnrollments.id} and s.status in ${sqlValues(SEND_COUNTED)})`,
            ),
          )
          .returning({ id: campaignEnrollments.id });
        const staleIds = stale.map((r) => r.id);
        if (staleIds.length > 0) {
          await tx
            .update(linkedinEnrollmentDetails)
            .set({ providerId: null, resolveRetryCount: 0, resolveNextAttemptAt: null, resolveLastError: null })
            .where(inArray(linkedinEnrollmentDetails.enrollmentId, staleIds));
        }
      }
    });
  },
};
