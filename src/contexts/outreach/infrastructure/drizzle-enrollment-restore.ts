import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "@/platform/db/audit";
import { db, type DbHandle } from "@/platform/db/client";
import { campaignEnrollments, campaigns, events, linkedinEnrollmentDetails, people } from "@/platform/db/schema";
import type { EnrollmentRestoreStore, RestoreRefused } from "../application/enrollment-restore";
import { lockPersonOutreachTx } from "@/platform/db/sequence-stop";
import { RESTORE_REFUSAL_TEXT, decideRestore, restoredProgress } from "../domain/enrollment-restore";
import { notContactSql } from "./contact-guard";
import { LIVE_ENROLLMENT_STATUSES } from "../domain/enrollment-status";
import { sqlValues } from "@/platform/db/sql-values";

const uuidList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
const rowsOf = <T>(result: unknown) => result as unknown as T[];

/** Facts about the people of the named enrollments, read inside the restore transaction. */
async function personFacts(tx: DbHandle, organizationId: string, campaignId: string, channel: string, personIds: string[]) {
  const [replied, dnc, suppressed, contacts, elsewhere] = await Promise.all([
    tx.execute(sql`
      select e.person_id as "personId" from campaign_enrollments e
      where e.organization_id = ${organizationId} and e.person_id in (${uuidList(personIds)}) and e.status = 'replied'
      union
      select r.person_id from messages m
      join conversations c on c.id = m.conversation_id and c.organization_id = m.organization_id
      join records r on r.id = c.record_id and r.organization_id = c.organization_id
      where m.organization_id = ${organizationId} and m.direction = 'inbound' and coalesce(m.raw ->> 'autoReply', 'false') <> 'true'
        and r.person_id in (${uuidList(personIds)})
    `),
    tx.execute(sql`
      select cp.person_id as "personId" from contact_policies cp
      where cp.organization_id = ${organizationId} and cp.do_not_contact and cp.person_id in (${uuidList(personIds)})
    `),
    channel === "email"
      ? tx.execute(sql`
          select p.id as "personId" from people p
          where p.organization_id = ${organizationId} and p.id in (${uuidList(personIds)})
            and exists (select 1 from suppression_list s where s.organization_id = p.organization_id and s.email = lower(p.email))
        `)
      : Promise.resolve([]),
    tx
      .select({ personId: people.id })
      .from(people)
      .where(and(eq(people.organizationId, organizationId), inArray(people.id, personIds), sql`not ${notContactSql}`)),
    tx.execute(sql`
      select e.person_id as "personId", c.name as "campaignName" from campaign_enrollments e
      join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
      where e.organization_id = ${organizationId} and e.channel = ${channel} and e.campaign_id <> ${campaignId}
        and e.status in ${sqlValues(LIVE_ENROLLMENT_STATUSES)} and e.person_id in (${uuidList(personIds)})
      order by e.created_at asc
    `),
  ]);
  const elsewhereBy = new Map<string, string>();
  for (const r of rowsOf<{ personId: string; campaignName: string }>(elsewhere)) if (!elsewhereBy.has(r.personId)) elsewhereBy.set(r.personId, r.campaignName);
  return {
    replied: new Set(rowsOf<{ personId: string }>(replied).map((r) => r.personId)),
    doNotContact: new Set(rowsOf<{ personId: string }>(dnc).map((r) => r.personId)),
    suppressed: new Set(rowsOf<{ personId: string }>(suppressed).map((r) => r.personId)),
    contact: new Set(contacts.map((r) => r.personId)),
    elsewhereBy,
  };
}

export const drizzleEnrollmentRestoreStore: EnrollmentRestoreStore = {
  async restore(input) {
    const { organizationId, campaignId, channel, enrollmentIds, actorUserId, now } = input;
    return db.transaction(async (tx) => {
      const [campaign] = await tx
        .select({ status: campaigns.status, archivedAt: campaigns.archivedAt, steps: campaigns.steps })
        .from(campaigns)
        .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, campaignId), eq(campaigns.channel, channel)));
      if (!campaign) return null;

      // The lookup above pins campaign, organization and channel, and this one pins the campaign, so a foreign id is simply absent.
      // The people come first and unlocked: their outreach lock has to be taken before any fact about them is read, and a
      // reply or another restore that commits first is then visible to the reads below.
      const peeked = await tx
        .select({ personId: campaignEnrollments.personId })
        .from(campaignEnrollments)
        .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.campaignId, campaignId), inArray(campaignEnrollments.id, enrollmentIds)));
      await lockPersonOutreachTx(tx, organizationId, peeked.map((e) => e.personId));

      const found = await tx
        .select({
          id: campaignEnrollments.id,
          personId: campaignEnrollments.personId,
          status: campaignEnrollments.status,
          currentStep: campaignEnrollments.currentStep,
          connectionState: linkedinEnrollmentDetails.connectionState,
          acceptedAt: linkedinEnrollmentDetails.acceptedAt,
          lastSentAt: campaignEnrollments.lastSentAt,
          personName: sql<string | null>`coalesce(nullif(btrim(${people.fullName}), ''), nullif(btrim(concat_ws(' ', ${people.firstName}, ${people.lastName})), ''), ${people.email})`,
        })
        .from(campaignEnrollments)
        .innerJoin(people, and(eq(people.id, campaignEnrollments.personId), eq(people.organizationId, campaignEnrollments.organizationId)))
        .leftJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, campaignEnrollments.id))
        .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.campaignId, campaignId), inArray(campaignEnrollments.id, enrollmentIds)))
        .orderBy(asc(campaignEnrollments.id))
        .for("update", { of: campaignEnrollments });

      // What really went out, from the sends rows: a send in flight at removal still completed, and `current_step` did not move.
      const lastSends = new Map<string, { step: number; at: Date }>();
      if (found.length > 0) {
        const sent = rowsOf<{ enrollmentId: string; step: number; at: Date | string }>(
          await tx.execute(sql`
            select distinct on (s.enrollment_id) s.enrollment_id as "enrollmentId", s.step_number as step, coalesce(s.sent_at, s.claimed_at) as at
            from sends s
            where s.organization_id = ${organizationId} and s.enrollment_id in (${uuidList(found.map((e) => e.id))}) and s.status in ('sent', 'unknown')
            order by s.enrollment_id, s.step_number desc
          `),
        );
        for (const r of sent) lastSends.set(r.enrollmentId, { step: Number(r.step), at: new Date(r.at) });
      }

      const facts = found.length === 0 ? null : await personFacts(tx, organizationId, campaignId, channel, [...new Set(found.map((e) => e.personId))]);
      const refused: RestoreRefused[] = [];
      let restored = 0;
      for (const e of found) {
        const connection = (e.connectionState as "none" | "request_sent" | "connected" | null) ?? null;
        const last = lastSends.get(e.id);
        const progress = restoredProgress({ channel, currentStep: e.currentStep, lastSentStep: last?.step ?? 0, connectionState: connection });
        // After the invitation the next message counts from the acceptance; otherwise from the last send.
        const anchor = channel === "linkedin" && progress === 1 && connection === "connected" && e.acceptedAt ? e.acceptedAt : (last?.at ?? e.lastSentAt);
        const steps = campaign.steps as Array<{ waitDays?: number }>;
        const decision = decideRestore(
          {
            status: e.status,
            channel,
            currentStep: progress,
            lastSentAt: anchor,
            nextWaitDays: steps[progress]?.waitDays ?? 0,
            totalSteps: (campaign.steps as unknown[]).length,
            connectionState: connection,
            campaignStatus: campaign.status,
            campaignArchived: campaign.archivedAt !== null,
            replied: facts?.replied.has(e.personId) ?? false,
            doNotContact: facts?.doNotContact.has(e.personId) ?? false,
            suppressed: facts?.suppressed.has(e.personId) ?? false,
            contact: facts?.contact.has(e.personId) ?? false,
            activeElsewhere: facts?.elsewhereBy.get(e.personId) ?? null,
          },
          now,
        );
        const refuse = (reason: keyof typeof RESTORE_REFUSAL_TEXT, detail?: string) =>
          refused.push({ enrollmentId: e.id, personName: e.personName, reason, message: RESTORE_REFUSAL_TEXT[reason], ...(detail ? { detail } : {}) });
        if (!decision.ok) {
          refuse(decision.reason, decision.reason === "active_elsewhere" ? (facts?.elsewhereBy.get(e.personId) ?? undefined) : undefined);
          continue;
        }
        // The status condition repeats in the UPDATE, so a writer that raced us keeps its result.
        const changed = await tx
          .update(campaignEnrollments)
          .set({
            status: decision.status,
            nextSendAt: decision.nextSendAt,
            stopReason: null,
            updatedAt: now,
            // Progress that completed while the lead was removed is written back, so the claims and the lead panel agree with the sends.
            ...(progress > e.currentStep ? { currentStep: progress, lastSentAt: last?.at ?? e.lastSentAt } : {}),
          })
          .where(and(eq(campaignEnrollments.id, e.id), eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.status, "removed")))
          .returning({ id: campaignEnrollments.id });
        if (changed.length === 0) {
          refuse("not_removed");
          continue;
        }
        if (channel === "linkedin" && progress >= 1 && connection === "none") {
          await tx
            .update(linkedinEnrollmentDetails)
            .set({ connectionState: "request_sent", requestSentAt: last?.at ?? now })
            .where(and(eq(linkedinEnrollmentDetails.enrollmentId, e.id), eq(linkedinEnrollmentDetails.connectionState, "none")));
        }
        restored += 1;
        await tx.insert(events).values({
          organizationId,
          personId: e.personId,
          eventType: "enrollment.restored",
          actorType: "human",
          actorUserId,
          fromData: { status: "removed" },
          toData: { status: decision.status, campaignId, enrollmentId: e.id },
        });
        await recordAudit(tx, {
          organizationId,
          actorUserId,
          action: "enrollment.restored",
          entityType: "campaign_enrollment",
          entityId: e.id,
          meta: { campaignId, channel, personId: e.personId, status: decision.status },
        });
      }
      return { restored, refused, notFound: enrollmentIds.length - found.length };
    });
  },
};
