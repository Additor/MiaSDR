import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { doNotContactSql, suppressionBlocksSql } from "@/contexts/people/infrastructure/reachability";
import { leadSearchCondition } from "@/contexts/people/infrastructure/queries";
import type { DbHandle } from "@/platform/db/client";
import { campaignEnrollments, companies, linkedinEnrollmentDetails, people } from "@/platform/db/schema";
import { personStopReviewOpenSql } from "./stop-review-gate";
import type { OutreachChannel, PickedEnrollCounts } from "../application/enrollment-admin";
import { countEnrollBlocks, ENROLL_BLOCKS, type EnrollBlock, type EnrollSkipCounts } from "../domain/enrollment-eligibility";
import { REMOVED_STATUS } from "../domain/enrollment-status";
import { parseMemberUrl } from "../linkedin/domain/linkedin-identity";
import { profileUrlFor } from "../linkedin/domain/linkedin";
import { insertSkippingContacts, notContactSql } from "./contact-guard";

const CHUNK = 500;

/** Sales Navigator and Recruiter member URLs, same shapes as `parseMemberUrl`: a known path prefix and an id of 10 or more safe characters. */
const MEMBER_URL_SQL =
  "^(https?://)?([a-z0-9-]+\\.)*linkedin\\.com/(sales/(lead|people)/|talent/(profile/|hire/[^/]+/profile/))[A-Za-z0-9_-]{10,}([,?/#]|%2c|$)";

/**
 * The person has what the channel addresses: an email, or a public slug, a Sales Navigator or Recruiter URL or a stored
 * member id. Qualified by hand, like everything in `enrollBlockSql`.
 */
const hasIdentitySql = (channel: OutreachChannel): SQL =>
  channel === "email"
    ? sql`people.email is not null`
    : sql`(people.linkedin_slug is not null or coalesce(people.linkedin_url ~* ${MEMBER_URL_SQL}, false) or people.raw->>'linkedin_member_id' is not null)`;

/**
 * The first reason this person cannot enter the campaign, or null when they can. The one predicate of enrollment
 * eligibility: every enroll path selects it, and `ENROLL_BLOCKS` sets the precedence. It needs `people` in the FROM clause
 * under that name. `campaignId` is null for a campaign that does not exist yet, which holds nobody.
 */
export function enrollBlockSql(channel: OutreachChannel, campaignId: string | null): SQL<EnrollBlock | null> {
  const enrolled = (status: SQL) => sql`exists (select 1 from campaign_enrollments e where e.campaign_id = ${campaignId} and e.person_id = people.id and e.status ${status})`;
  const conditions: Record<EnrollBlock, SQL | null> = {
    missing_identity: sql`not ${hasIdentitySql(channel)}`,
    removed: campaignId ? enrolled(sql`= ${REMOVED_STATUS}`) : null,
    duplicate: campaignId ? enrolled(sql`<> ${REMOVED_STATUS}`) : null,
    suppressed: suppressionBlocksSql("people", channel),
    do_not_contact: doNotContactSql("people"),
    stop_request: personStopReviewOpenSql("people"),
    contact: sql`not ${notContactSql}`,
  };
  const whens = ENROLL_BLOCKS.flatMap((block) => {
    const condition = conditions[block];
    return condition ? [sql`when ${condition} then ${sql.raw(`'${block}'`)}`] : [];
  });
  return sql`(case ${sql.join(whens, sql` `)} end)` as SQL<EnrollBlock | null>;
}

type EnrollCandidate = { id: string; slug: string | null; url: string | null; memberId: string | null };

const candidateColumns = { id: people.id, slug: people.linkedinSlug, url: people.linkedinUrl, memberId: sql<string | null>`people.raw->>'linkedin_member_id'` };

/** The identifier a LinkedIn resolve starts from: the profile URL of the slug, else the stored member URL as typed, else the bare member id. */
function enrollmentProfileUrl(p: EnrollCandidate): string | null {
  if (p.slug) return profileUrlFor(p.slug);
  if (p.url && parseMemberUrl(p.url)) return p.url;
  return p.memberId;
}

/** Inserts the people `enrollBlockSql` let through, with their LinkedIn progress rows on that channel. */
async function insertEnrollments(tx: DbHandle, organizationId: string, campaignId: string, channel: OutreachChannel, eligible: readonly EnrollCandidate[], viaTokenId: string | null): Promise<{ addedPersonIds: string[]; skippedContact: number }> {
  const urlOf = new Map(eligible.map((p) => [p.id, enrollmentProfileUrl(p)]));
  const ids = eligible.filter((p) => channel === "email" || urlOf.get(p.id)).map((p) => p.id).sort();
  const addedPersonIds: string[] = [];
  let skippedContact = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const result = await insertSkippingContacts(tx, organizationId, ids.slice(i, i + CHUNK), (sp, keep) =>
      sp
        .insert(campaignEnrollments)
        .values(keep.map((personId) => ({ organizationId, campaignId, personId, channel, enrolledViaTokenId: viaTokenId })))
        .onConflictDoNothing()
        .returning({ id: campaignEnrollments.id, personId: campaignEnrollments.personId }),
    );
    if (channel === "linkedin" && result.inserted.length > 0) {
      await tx
        .insert(linkedinEnrollmentDetails)
        .values(result.inserted.map((e) => ({ enrollmentId: e.id, organizationId, profileUrl: urlOf.get(e.personId) as string })))
        .onConflictDoNothing();
    }
    addedPersonIds.push(...result.inserted.map((e) => e.personId));
    skippedContact += result.skippedContact;
  }
  return { addedPersonIds, skippedContact };
}

/** The buckets after a write: a person who became a contact meanwhile, or whom a concurrent enroll inserted first, moves out of `added`. */
function afterInsert(skips: EnrollSkipCounts, eligible: number, inserted: { addedPersonIds: string[]; skippedContact: number }): EnrollSkipCounts {
  return {
    ...skips,
    skippedContact: skips.skippedContact + inserted.skippedContact,
    skippedDuplicate: skips.skippedDuplicate + (eligible - inserted.addedPersonIds.length - inserted.skippedContact),
  };
}

/** The block of each person among `personIds` in this organization. An id missing from the answer is unknown here. */
export async function readEnrollBlocks(tx: DbHandle, organizationId: string, campaignId: string | null, channel: OutreachChannel, personIds: readonly string[]): Promise<Map<string, EnrollCandidate & { block: EnrollBlock | null }>> {
  const ids = [...new Set(personIds)];
  const block = enrollBlockSql(channel, campaignId);
  const found = new Map<string, EnrollCandidate & { block: EnrollBlock | null }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await tx
      .select({ ...candidateColumns, block: sql<EnrollBlock | null>`${block}` })
      .from(people)
      // The organization filter is what keeps an id of another organization out. It reads as not found.
      .where(and(eq(people.organizationId, organizationId), inArray(people.id, ids.slice(i, i + CHUNK))));
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

/** Enrolls the named people, or with `dryRun` counts what that would do. Every id lands in one bucket. */
export async function enrollPickedTx(
  tx: DbHandle,
  organizationId: string,
  campaignId: string,
  channel: OutreachChannel,
  personIds: readonly string[],
  options: { viaTokenId: string | null; dryRun?: boolean },
): Promise<PickedEnrollCounts> {
  const ids = [...new Set(personIds)];
  const found = await readEnrollBlocks(tx, organizationId, campaignId, channel, ids);
  const { skips, eligible } = countEnrollBlocks([...found.values()].map((p) => ({ block: p.block, n: 1 })));
  const base = { requested: ids.length, skippedNotFound: ids.length - found.size };
  if (options.dryRun) return { ...base, ...skips, added: 0, wouldAdd: eligible };
  const inserted = await insertEnrollments(tx, organizationId, campaignId, channel, [...found.values()].filter((p) => p.block === null), options.viaTokenId);
  return { ...base, ...afterInsert(skips, eligible, inserted), added: inserted.addedPersonIds.length };
}

/** What an enroll by search answers, before a channel adds its own field names. */
export interface EnrollByQueryCounts extends EnrollSkipCounts {
  requested: number;
  added: number;
  wouldAdd?: number;
}

/** Enrolls the people a Leads search matches, oldest first up to `limit`, or with `dryRun` counts what that would do. */
export async function enrollByQueryTx(
  tx: DbHandle,
  organizationId: string,
  campaignId: string,
  channel: OutreachChannel,
  filter: { query?: string; limit: number; dryRun?: boolean; viaTokenId?: string | null },
): Promise<{ counts: EnrollByQueryCounts; addedPersonIds: string[] }> {
  const matching = and(eq(people.organizationId, organizationId), leadSearchCondition(filter.query));
  const block = enrollBlockSql(channel, campaignId);
  const groups = await tx
    .select({ block: sql<EnrollBlock | null>`${block}`, n: sql<number>`count(*)::int` })
    .from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(matching)
    .groupBy(sql`1`);
  const { skips, eligible, total } = countEnrollBlocks(groups);
  if (filter.dryRun) return { counts: { ...skips, requested: total, added: 0, wouldAdd: Math.min(eligible, filter.limit) }, addedPersonIds: [] };

  const candidates = await tx
    .select(candidateColumns)
    .from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(and(matching, sql`${block} is null`))
    .orderBy(asc(people.createdAt), asc(people.id))
    .limit(filter.limit);
  const inserted = await insertEnrollments(tx, organizationId, campaignId, channel, candidates, filter.viaTokenId ?? null);
  return { counts: { ...afterInsert(skips, candidates.length, inserted), requested: total, added: inserted.addedPersonIds.length }, addedPersonIds: inserted.addedPersonIds };
}
