import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db, inTransaction } from "@/platform/db/client";
import { campaignEnrollments, campaignSenders, campaigns, linkedinAccounts, linkedinEnrollmentDetails, mailboxes, people } from "@/platform/db/schema";
import type { EnrollmentAdminStore, OutreachChannel, SenderRef } from "../application/enrollment-admin";
import { REMOVED_STATUS, canRemoveEnrollment } from "../domain/enrollment-status";
import { endEnrollmentsTx } from "./enrollment-end";
import { profileUrlFor } from "../linkedin/domain/linkedin";
import { insertSkippingContacts, notContactSql } from "./contact-guard";
import { doNotContactSql, suppressedSql } from "@/contexts/people/infrastructure/reachability";

const CHUNK = 500;

const senderLabel = (channel: OutreachChannel) =>
  channel === "email"
    ? { id: mailboxes.id, label: mailboxes.emailAddress, status: mailboxes.status }
    : { id: linkedinAccounts.id, label: sql<string>`coalesce(${linkedinAccounts.name}, ${linkedinAccounts.username}, ${linkedinAccounts.id}::text)`, status: linkedinAccounts.status };

const toRef = (row: { id: string; label: string; status: string }): SenderRef => ({ id: row.id, label: row.label, connected: row.status === "connected" });

export const drizzleEnrollmentAdminStore: EnrollmentAdminStore = {
  async enrollPicked(organizationId, campaignId, channel, personIds, handle) {
    const ids = [...new Set(personIds)];
    return inTransaction(handle, async (tx) => {
      const suppressed = sql<boolean>`${suppressedSql("people")}`;
      const dnc = sql<boolean>`${doNotContactSql("people")}`;
      // Qualified by hand: a single-table select renders bare column names, which a subquery would bind to its own table.
      const already = sql<boolean>`exists (select 1 from campaign_enrollments e where e.campaign_id = ${campaignId} and e.person_id = people.id and e.status <> 'removed')`;
      const removed = sql<boolean>`exists (select 1 from campaign_enrollments e where e.campaign_id = ${campaignId} and e.person_id = people.id and e.status = 'removed')`;
      const contact = sql<boolean>`not ${notContactSql}`;
      const found = new Map<string, { id: string; hasIdentity: boolean; slug: string | null; suppressed: boolean; dnc: boolean; contact: boolean; already: boolean; removed: boolean }>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const rows = await tx
          .select({
            id: people.id,
            slug: people.linkedinSlug,
            hasEmail: sql<boolean>`people.email is not null`,
            suppressed,
            dnc,
            contact,
            already,
            removed,
          })
          .from(people)
          // The organization filter is what keeps an id of another organization out. It reads as not found.
          .where(and(eq(people.organizationId, organizationId), inArray(people.id, ids.slice(i, i + CHUNK))));
        for (const r of rows) found.set(r.id, { id: r.id, slug: r.slug, hasIdentity: channel === "email" ? r.hasEmail : r.slug !== null, suppressed: channel === "email" && r.suppressed, dnc: r.dnc, contact: r.contact, already: r.already, removed: r.removed });
      }

      const counts = { requested: ids.length, added: 0, skippedMissingIdentity: 0, skippedDuplicate: 0, skippedRemoved: 0, skippedSuppressed: 0, skippedDoNotContact: 0, skippedContact: 0, skippedNotFound: 0 };
      const eligible: Array<{ id: string; slug: string | null }> = [];
      for (const id of ids) {
        const p = found.get(id);
        if (!p) counts.skippedNotFound += 1;
        else if (!p.hasIdentity) counts.skippedMissingIdentity += 1;
        else if (p.removed) counts.skippedRemoved += 1;
        else if (p.already) counts.skippedDuplicate += 1;
        else if (p.suppressed) counts.skippedSuppressed += 1;
        else if (p.dnc) counts.skippedDoNotContact += 1;
        else if (p.contact) counts.skippedContact += 1;
        else eligible.push(p);
      }
      eligible.sort((a, b) => (a.id < b.id ? -1 : 1));

      for (let i = 0; i < eligible.length; i += CHUNK) {
        const chunk = eligible.slice(i, i + CHUNK);
        const slugOf = new Map(chunk.map((p) => [p.id, p.slug as string]));
        const { inserted, skippedContact } = await insertSkippingContacts(tx, organizationId, chunk.map((p) => p.id), (sp, ids) =>
          sp
            .insert(campaignEnrollments)
            .values(ids.map((personId) => ({ organizationId, campaignId, personId, channel })))
            .onConflictDoNothing()
            .returning({ id: campaignEnrollments.id, personId: campaignEnrollments.personId }),
        );
        if (channel === "linkedin" && inserted.length > 0) {
          await tx
            .insert(linkedinEnrollmentDetails)
            .values(inserted.map((e) => ({ enrollmentId: e.id, organizationId, profileUrl: profileUrlFor(slugOf.get(e.personId) as string) })))
            .onConflictDoNothing();
        }
        counts.added += inserted.length;
        counts.skippedContact += skippedContact;
        // A concurrent enroll of the same person won the insert.
        counts.skippedDuplicate += chunk.length - skippedContact - inserted.length;
      }
      return counts;
    });
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

  async listSenders(organizationId, campaignId, channel) {
    const cols = senderLabel(channel);
    if (channel === "email") {
      const rows = await db
        .select(cols)
        .from(campaignSenders)
        .innerJoin(mailboxes, eq(mailboxes.id, campaignSenders.mailboxId))
        .where(and(eq(campaignSenders.organizationId, organizationId), eq(campaignSenders.campaignId, campaignId)))
        .orderBy(asc(mailboxes.emailAddress));
      return rows.map(toRef);
    }
    const rows = await db
      .select(cols)
      .from(campaignSenders)
      .innerJoin(linkedinAccounts, eq(linkedinAccounts.id, campaignSenders.linkedinAccountId))
      .where(and(eq(campaignSenders.organizationId, organizationId), eq(campaignSenders.campaignId, campaignId)))
      .orderBy(asc(linkedinAccounts.createdAt));
    return rows.map(toRef);
  },

  async findSenders(organizationId, channel, ids) {
    if (ids.length === 0) return [];
    const rows =
      channel === "email"
        ? await db.select(senderLabel("email")).from(mailboxes).where(and(eq(mailboxes.organizationId, organizationId), inArray(mailboxes.id, ids)))
        : await db.select(senderLabel("linkedin")).from(linkedinAccounts).where(and(eq(linkedinAccounts.organizationId, organizationId), inArray(linkedinAccounts.id, ids)));
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
              sql`not exists (select 1 from sends s where s.enrollment_id = ${campaignEnrollments.id} and s.status in ('sending', 'unknown', 'sent'))`,
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
