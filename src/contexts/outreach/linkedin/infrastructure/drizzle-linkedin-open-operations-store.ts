import { and, asc, eq, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { campaignEnrollments, campaigns, channelSettings, linkedinAccounts, linkedinConnections, linkedinEnrollmentDetails, linkedinOpenOperations, linkedinSearchQueries, people, sends } from "@/platform/db/schema";
import { isLiveEnrollment } from "../../domain/enrollment-status";
import type { LinkedInOpenOperationStore, LinkedInResolveClaim, LinkedInSettleClaim, OpenLinkedInOperation } from "../application/linkedin-ports";
import { linkedinRules } from "../domain/linkedin";
import { REPLY_CHECK_DAYS, type OpenOperationKind } from "../domain/linkedin-operations";

const o = linkedinOpenOperations;
const q = linkedinSearchQueries;

/** Stores what a vendor took. The row closes the account's gate. */
export async function insertOpenOperation(
  handle: DbHandle,
  input: { kind: OpenOperationKind; subjectId: string; organizationId: string; account: { id: string; providerAccountId: string }; operation: string; api?: string | null; rowLimit?: number | null; now: Date },
): Promise<void> {
  await handle.insert(o).values({
    organizationId: input.organizationId,
    linkedinAccountId: input.account.id,
    providerAccountRef: input.account.providerAccountId,
    kind: input.kind,
    subjectId: input.subjectId,
    operation: input.operation,
    api: input.api ?? null,
    rowLimit: input.rowLimit ?? null,
    submittedAt: input.now,
  });
}

/** Whether an action this account started is still open. */
export async function accountHasOpenOperation(handle: Pick<typeof db, "select">, accountId: string): Promise<boolean> {
  const [row] = await handle.select({ id: o.id }).from(o).where(eq(o.linkedinAccountId, accountId)).limit(1);
  return row !== undefined;
}

async function sendSubject(sendId: string, kind: "invitation" | "message"): Promise<LinkedInSettleClaim | null> {
  const [row] = await db
    .select({
      organizationId: sends.organizationId,
      attempt: sends.attempt,
      stepNumber: sends.stepNumber,
      enrollmentId: sends.enrollmentId,
      accountId: sends.linkedinAccountId,
      campaignId: campaignEnrollments.campaignId,
      personId: campaignEnrollments.personId,
      providerId: linkedinEnrollmentDetails.providerId,
      steps: campaigns.steps,
    })
    .from(sends)
    .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .innerJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, sends.enrollmentId))
    .where(eq(sends.id, sendId));
  if (!row) return null;
  const stepNumber = row.stepNumber as number;
  // The step may have been edited away since the submit, and the send it stands for still went out.
  const next = row.steps[stepNumber];
  return {
    kind,
    sendId,
    organizationId: row.organizationId,
    attempt: row.attempt,
    stepNumber,
    enrollmentId: row.enrollmentId as string,
    campaignId: row.campaignId,
    account: { id: row.accountId as string },
    person: { id: row.personId },
    providerId: row.providerId ?? "",
    nextStep: next ? { waitDays: next.waitDays } : null,
  };
}

async function lookupSubject(enrollmentId: string, account: { id: string; providerAccountId: string }): Promise<(LinkedInResolveClaim & { live: boolean }) | null> {
  const [row] = await db
    .select({
      organizationId: campaignEnrollments.organizationId,
      status: campaignEnrollments.status,
      campaignStatus: campaigns.status,
      slug: people.linkedinSlug,
      profileUrl: linkedinEnrollmentDetails.profileUrl,
      failures: linkedinEnrollmentDetails.resolveRetryCount,
    })
    .from(campaignEnrollments)
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .innerJoin(people, eq(people.id, campaignEnrollments.personId))
    .innerJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, campaignEnrollments.id))
    .where(eq(campaignEnrollments.id, enrollmentId));
  const identifier = row?.slug ?? row?.profileUrl;
  if (!row || !identifier) return null;
  return { kind: "resolve", organizationId: row.organizationId, enrollmentId, account, identifier, failures: row.failures, nextApi: null, live: isLiveEnrollment(row.status) && row.campaignStatus === "active" };
}

async function replyCheckSubject(enrollmentId: string, account: { id: string; providerAccountId: string }, now: Date) {
  const [row] = await db
    .select({
      organizationId: campaignEnrollments.organizationId,
      status: campaignEnrollments.status,
      slug: people.linkedinSlug,
      providerId: linkedinEnrollmentDetails.providerId,
      acceptedAt: linkedinEnrollmentDetails.acceptedAt,
      chat: linkedinConnections.chatId,
      started: sql<Date | null>`(select min(s.claimed_at) from sends s where s.enrollment_id = ${campaignEnrollments.id})`,
    })
    .from(campaignEnrollments)
    .innerJoin(people, eq(people.id, campaignEnrollments.personId))
    .innerJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, campaignEnrollments.id))
    .leftJoin(linkedinConnections, and(eq(linkedinConnections.linkedinAccountId, account.id), eq(linkedinConnections.providerId, linkedinEnrollmentDetails.providerId)))
    .where(eq(campaignEnrollments.id, enrollmentId));
  if (!row) return null;
  return {
    kind: "reply_check" as const,
    organizationId: row.organizationId,
    enrollmentId,
    account,
    to: { chat: row.chat, member: row.providerId, slug: row.slug },
    since: replyCheckSince(row.started ? new Date(row.started) : row.acceptedAt, now),
    live: isLiveEnrollment(row.status),
  };
}

/** A reply is anything the person wrote since this enrollment's outreach began. */
export const replyCheckSince = (outreachStartedAt: Date | null, now: Date) => outreachStartedAt ?? new Date(now.getTime() - REPLY_CHECK_DAYS * 86_400_000);

async function searchSubject(searchId: string, account: { id: string; providerAccountId: string }) {
  const [row] = await db.select().from(q).where(eq(q.id, searchId));
  if (!row) return null;
  const [settings] = await db.select({ values: channelSettings.values }).from(channelSettings).where(and(eq(channelSettings.organizationId, row.organizationId), eq(channelSettings.channel, "linkedin")));
  return {
    searchId,
    organizationId: row.organizationId,
    url: row.url,
    cursor: null,
    maxResults: row.maxResults,
    found: row.leadsFetched,
    pagesFetched: row.pagesFetched,
    targetCampaignId: row.targetCampaignId,
    failures: row.failures,
    quotaLeft: 0,
    gapSeconds: linkedinRules(settings?.values ?? null).searchGapSeconds,
    account,
    // A resume clears the lease, and a write with the wrong one changes nothing. The epoch never matches.
    leaseUntil: row.leaseUntil ?? new Date(0),
    live: row.status === "running",
  };
}

export const drizzleLinkedInOpenOperationStore: LinkedInOpenOperationStore = {
  async listOpen(limit) {
    const rows = await db
      .select({ row: o, providerAccountId: linkedinAccounts.providerAccountId, provider: linkedinAccounts.provider })
      .from(o)
      .innerJoin(linkedinAccounts, eq(linkedinAccounts.id, o.linkedinAccountId))
      .orderBy(sql`${o.checkedAt} asc nulls first`, asc(o.submittedAt))
      .limit(limit);
    const now = new Date();
    return Promise.all(
      rows.map(async ({ row, providerAccountId, provider }): Promise<OpenLinkedInOperation> => {
        const base = { id: row.id, organizationId: row.organizationId, accountId: row.linkedinAccountId, provider, providerAccountRef: row.providerAccountRef, operation: row.operation, submittedAt: row.submittedAt };
        const account = { id: row.linkedinAccountId, providerAccountId };
        switch (row.kind) {
          case "invitation":
          case "message":
            return { ...base, kind: row.kind, subject: await sendSubject(row.subjectId, row.kind) };
          case "lookup":
            return { ...base, kind: "lookup", api: row.api as "sales_navigator" | "recruiter" | null, subject: await lookupSubject(row.subjectId, account) };
          case "reply_check":
            return { ...base, kind: "reply_check", subject: await replyCheckSubject(row.subjectId, account, now) };
          case "search":
            return { ...base, kind: "search", rowLimit: row.rowLimit ?? 0, subject: await searchSubject(row.subjectId, account) };
        }
      }),
    );
  },

  async noteChecked(id, now) {
    await db.update(o).set({ checkedAt: now }).where(eq(o.id, id));
  },

  async close(id) {
    const rows = await db.delete(o).where(eq(o.id, id)).returning({ id: o.id });
    return rows.length === 1;
  },
};

