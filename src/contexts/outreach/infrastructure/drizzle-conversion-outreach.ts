import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { campaignEnrollments, campaigns, linkedinEnrollmentDetails } from "@/platform/db/schema";
import type { ConversionOutreach, EnrollmentSource, LiveEnrollmentSummary } from "../application/conversion";
import { haltOutcome, REMOVABLE_STATUSES } from "../domain/enrollment-status";
import { endEnrollmentsTx } from "./enrollment-end";

const CHUNK = 1_000;

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Callee-owned writes and reads of the conversion. The one write locks the rows in id order, as `removeEnrollments` does, then
 * ends them through `endEnrollmentsTx`, which repeats the status condition in the UPDATE.
 */
export async function stopPersonEnrollmentsTx(tx: DbHandle, input: { organizationId: string; personId: string; reason: "converted"; now: Date }): Promise<{ stopped: number }> {
  const { organizationId, personId, reason, now } = input;
  // Lock order of the LinkedIn paths (acceptance, invitation sent): the details row, then the enrollment row. Taking the details rows
  // first keeps a webhook loop and this write out of each other's way. They are found unlocked, then locked in id order.
  const linkedinIds = await tx
    .select({ id: campaignEnrollments.id })
    .from(campaignEnrollments)
    .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.personId, personId), eq(campaignEnrollments.channel, "linkedin"), inArray(campaignEnrollments.status, [...REMOVABLE_STATUSES])));
  if (linkedinIds.length > 0) {
    await tx
      .select({ id: linkedinEnrollmentDetails.enrollmentId })
      .from(linkedinEnrollmentDetails)
      .where(inArray(linkedinEnrollmentDetails.enrollmentId, linkedinIds.map((e) => e.id)))
      .orderBy(asc(linkedinEnrollmentDetails.enrollmentId))
      .for("update");
  }
  const live = await tx
    .select({ id: campaignEnrollments.id })
    .from(campaignEnrollments)
    .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.personId, personId), inArray(campaignEnrollments.status, [...REMOVABLE_STATUSES])))
    .orderBy(asc(campaignEnrollments.id))
    .for("update");
  if (live.length === 0) return { stopped: 0 };
  // The status condition repeats in the UPDATE, so a writer that raced us (a reply, a bounce) keeps its final status.
  const changed = await endEnrollmentsTx(tx, and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.id, live.map((e) => e.id))), haltOutcome(reason), now);
  const linkedin = changed.filter((e) => e.channel === "linkedin").map((e) => e.id);
  if (linkedin.length > 0) await tx.update(linkedinEnrollmentDetails).set({ resolveNextAttemptAt: null }).where(inArray(linkedinEnrollmentDetails.enrollmentId, linkedin));
  return { stopped: changed.length };
}

export async function liveEnrollmentSummary(organizationId: string, personIds: string[], tx?: DbHandle): Promise<Map<string, LiveEnrollmentSummary>> {
  const ids = [...new Set(personIds)];
  const out = new Map<string, LiveEnrollmentSummary>(ids.map((id) => [id, { regular: 0, personal: { count: 0, createdBy: [] } }]));
  for (const part of chunked(ids)) {
    const rows = await (tx ?? db)
      .select({ personId: campaignEnrollments.personId, type: campaigns.type, createdBy: campaigns.createdBy, id: campaignEnrollments.id })
      .from(campaignEnrollments)
      .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
      .where(and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.personId, part), inArray(campaignEnrollments.status, [...REMOVABLE_STATUSES])));
    for (const row of rows) {
      const entry = out.get(row.personId);
      if (!entry) continue;
      if (row.type !== "personal") entry.regular += 1;
      else {
        entry.personal.count += 1;
        if (row.createdBy && !entry.personal.createdBy.includes(row.createdBy)) entry.personal.createdBy.push(row.createdBy);
      }
    }
  }
  for (const entry of out.values()) entry.personal.createdBy.sort();
  return out;
}

export async function latestRepliedEnrollment(organizationId: string, personIds: string[], tx?: DbHandle): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunked([...new Set(personIds)])) {
    const rows = await (tx ?? db)
      .selectDistinctOn([campaignEnrollments.personId], { personId: campaignEnrollments.personId, id: campaignEnrollments.id })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.status, "replied"), inArray(campaignEnrollments.personId, part)))
      .orderBy(asc(campaignEnrollments.personId), desc(campaignEnrollments.updatedAt), desc(campaignEnrollments.id));
    for (const row of rows) out.set(row.personId, row.id);
  }
  return out;
}

export async function enrollmentSources(organizationId: string, enrollmentIds: string[], tx?: DbHandle): Promise<Map<string, EnrollmentSource>> {
  const out = new Map<string, EnrollmentSource>();
  for (const part of chunked([...new Set(enrollmentIds)])) {
    const rows = await (tx ?? db)
      .select({ enrollmentId: campaignEnrollments.id, campaignId: campaigns.id, name: campaigns.name, type: campaigns.type })
      .from(campaignEnrollments)
      .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
      .where(and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.id, part)));
    for (const row of rows) out.set(row.enrollmentId, { campaignId: row.campaignId, name: row.name, type: row.type });
  }
  return out;
}

export const conversionOutreach: ConversionOutreach = { stopPersonEnrollmentsTx, liveEnrollmentSummary, latestRepliedEnrollment, enrollmentSources };
