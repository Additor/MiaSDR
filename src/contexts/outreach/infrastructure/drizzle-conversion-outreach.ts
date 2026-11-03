import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { campaignEnrollments, campaigns } from "@/platform/db/schema";
import type { ConversionOutreach, EnrollmentSource } from "../application/conversion";
import { REMOVABLE_STATUSES } from "../domain/enrollment-status";

const CHUNK = 1_000;

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Callee-owned reads of the conversion. `haltEnrollmentsTx` (`./enrollment-end`) ends the enrollments. */
export async function liveEnrollmentCounts(organizationId: string, personIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(personIds)];
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const part of chunked(ids)) {
    const rows = await db
      .select({ personId: campaignEnrollments.personId })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.personId, part), inArray(campaignEnrollments.status, [...REMOVABLE_STATUSES])));
    for (const row of rows) out.set(row.personId, (out.get(row.personId) ?? 0) + 1);
  }
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

export async function enrollmentSources(organizationId: string, enrollmentIds: string[]): Promise<Map<string, EnrollmentSource>> {
  const out = new Map<string, EnrollmentSource>();
  for (const part of chunked([...new Set(enrollmentIds)])) {
    const rows = await db
      .select({ enrollmentId: campaignEnrollments.id, campaignId: campaigns.id, name: campaigns.name })
      .from(campaignEnrollments)
      .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
      .where(and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.id, part)));
    for (const row of rows) out.set(row.enrollmentId, { campaignId: row.campaignId, name: row.name });
  }
  return out;
}

export const conversionOutreach: ConversionOutreach = { liveEnrollmentCounts, latestRepliedEnrollment, enrollmentSources };
