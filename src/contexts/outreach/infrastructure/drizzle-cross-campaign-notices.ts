import { sql, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import type { AlreadyContactedNotice, CrossCampaignNoticeReader, ExcludedByAccountNotice, LeadCrossContext } from "../application/cross-campaign-notices";
import { ALREADY_CONTACTED_BY_ACCOUNT, NOTICE_LIST_LIMIT } from "../domain/cross-campaign-notice";

const list = (ids: string[]): SQL => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
const rows = <T>(result: unknown) => result as unknown as T[];

/** The text a person is shown by: full name, else first and last name, else email. */
const personName = sql`coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email)`;

/** A step that went out (or may have) on the enrollment. Same statuses the engine counts for limits. */
const sentStep = sql`exists (select 1 from sends s where s.enrollment_id = e.id and s.status in ('sending', 'sent', 'unknown'))`;

/**
 * A personal campaign (and its replies) is private to the people who work in it. Another campaign's report, lead panel
 * or notice must not name it. `campaignId` is the campaign the reader is looking at: inside a personal campaign its
 * own screens may show other campaigns, in a regular campaign the personal ones drop out. `alias` is the campaigns alias.
 */
const visibleTo = (alias: string, campaignId: string): SQL =>
  sql`(${sql.raw(alias)}.type = 'regular' or exists (select 1 from campaigns viewer where viewer.id = ${campaignId}::uuid and viewer.type = 'personal'))`;

export const drizzleCrossCampaignNotices: CrossCampaignNoticeReader = {
  async alreadyContacted(organizationId, campaignId, personIds) {
    if (personIds.length === 0) return { alreadyContacted: [], alreadyContactedPeople: 0 };
    const where = sql`e.organization_id = ${organizationId} and e.campaign_id <> ${campaignId} and e.person_id in (${list(personIds)}) and (e.status = 'replied' or ${sentStep})
      and exists (select 1 from campaigns vc where vc.id = e.campaign_id and ${visibleTo("vc", campaignId)})`;
    const [found, [count]] = await Promise.all([
      db.execute(sql`
        select e.person_id as "personId", ${personName} as name, c.id as "campaignId", c.name as "campaignName", e.channel, e.status
        from campaign_enrollments e
        join people p on p.id = e.person_id and p.organization_id = e.organization_id
        join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        where ${where}
        order by name nulls last, e.person_id, c.name
        limit ${NOTICE_LIST_LIMIT}
      `),
      db.execute(sql`select count(distinct e.person_id)::int as n from campaign_enrollments e where ${where}`).then((r) => rows<{ n: number }>(r)),
    ]);
    return {
      alreadyContacted: rows<{ personId: string; name: string | null; campaignId: string; campaignName: string; channel: "email" | "linkedin"; status: string }>(found).map(
        (r): AlreadyContactedNotice => ({ personId: r.personId, name: r.name, campaign: { id: r.campaignId, name: r.campaignName }, channel: r.channel, status: r.status }),
      ),
      alreadyContactedPeople: count.n,
    };
  },

  async excludedByAccount(organizationId, campaignId, personIds) {
    if (personIds?.length === 0) return { excludedByAccount: [], excludedByAccountPeople: 0 };
    const scope = personIds ? sql` and e.person_id in (${list(personIds)})` : sql``;
    const where = sql`e.organization_id = ${organizationId} and e.campaign_id = ${campaignId} and e.status = 'suppressed' and e.stop_reason = ${ALREADY_CONTACTED_BY_ACCOUNT}${scope}`;
    const [found, [count]] = await Promise.all([
      db.execute(sql`
        select e.id as "enrollmentId", e.person_id as "personId", ${personName} as name,
               coalesce(a.name, a.username) as "accountName", earlier.id as "campaignId", earlier.name as "campaignName"
        from campaign_enrollments e
        join people p on p.id = e.person_id and p.organization_id = e.organization_id
        left join linkedin_accounts a on a.id = e.linkedin_account_id and a.organization_id = e.organization_id
        left join lateral (
          select c2.id, c2.name
          from sends s
          join campaign_enrollments e2 on e2.id = s.enrollment_id
          join campaigns c2 on c2.id = e2.campaign_id and c2.organization_id = e2.organization_id
          where e2.person_id = e.person_id and e2.id <> e.id and s.linkedin_account_id = e.linkedin_account_id
            and s.step_number = 1 and s.status in ('sending', 'sent', 'unknown') and ${visibleTo("c2", campaignId)}
          order by s.claimed_at asc
          limit 1
        ) earlier on true
        where ${where}
        order by name nulls last, e.id
        limit ${NOTICE_LIST_LIMIT}
      `),
      db.execute(sql`select count(distinct e.person_id)::int as n from campaign_enrollments e where ${where}`).then((r) => rows<{ n: number }>(r)),
    ]);
    return {
      excludedByAccount: rows<{ enrollmentId: string; personId: string; name: string | null; accountName: string | null; campaignId: string | null; campaignName: string | null }>(found).map(
        (r): ExcludedByAccountNotice => ({
          enrollmentId: r.enrollmentId,
          personId: r.personId,
          name: r.name,
          accountName: r.accountName,
          campaign: r.campaignId && r.campaignName ? { id: r.campaignId, name: r.campaignName } : null,
        }),
      ),
      excludedByAccountPeople: count.n,
    };
  },

  async leadContext(organizationId, campaignId, personIds) {
    const out = new Map<string, LeadCrossContext>();
    if (personIds.length === 0) return out;
    const context = (id: string) => {
      let entry = out.get(id);
      if (!entry) out.set(id, (entry = { alsoInCampaigns: [], excludedAccounts: [] }));
      return entry;
    };
    const [also, accounts] = await Promise.all([
      db.execute(sql`
        select e.person_id as "personId", c.id as "campaignId", c.name as "campaignName", e.channel, e.status
        from campaign_enrollments e
        join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        where e.organization_id = ${organizationId} and e.campaign_id <> ${campaignId} and e.person_id in (${list(personIds)}) and ${visibleTo("c", campaignId)}
        order by e.created_at desc
      `),
      db.execute(sql`
        select distinct on (e.person_id, s.linkedin_account_id) e.person_id as "personId", s.linkedin_account_id as "accountId",
               coalesce(a.name, a.username) as "accountName", c.name as "campaignName"
        from sends s
        join campaign_enrollments e on e.id = s.enrollment_id and e.organization_id = ${organizationId}
        join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        left join linkedin_accounts a on a.id = s.linkedin_account_id and a.organization_id = e.organization_id
        where e.person_id in (${list(personIds)}) and s.linkedin_account_id is not null and s.step_number = 1 and s.status in ('sending', 'sent', 'unknown')
          and ${visibleTo("c", campaignId)}
        order by e.person_id, s.linkedin_account_id, s.claimed_at asc
      `),
    ]);
    for (const r of rows<{ personId: string; campaignId: string; campaignName: string; channel: string; status: string }>(also)) {
      context(r.personId).alsoInCampaigns.push({ campaignId: r.campaignId, campaignName: r.campaignName, channel: r.channel, status: r.status });
    }
    for (const r of rows<{ personId: string; accountId: string; accountName: string | null; campaignName: string | null }>(accounts)) {
      context(r.personId).excludedAccounts.push({ accountId: r.accountId, accountName: r.accountName, campaignName: r.campaignName });
    }
    return out;
  },
};
