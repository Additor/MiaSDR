import { sql, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import {
  DAILY_METRICS,
  replyBucket,
  type CampaignCounts,
  type Channel,
  type ChannelCounts,
  type DailyEventRow,
  type DailyMetric,
  type LinkedInAccountCounts,
  type LinkedInCampaignFunnel,
  type LinkedInEventCounts,
  type ReplyCountRow,
  type SenderCounts,
  type SendCounts,
  type SuppressionReason,
} from "../domain/metrics";
import type { AnalyticsFilter, AnalyticsReadModel } from "../application/ports";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { SEND_OUTCOMES, SEND_STATUSES, type SendStatus } from "@/contexts/outreach/domain/send-status";
import { sqlValues } from "@/platform/db/sql-values";

/**
 * Read-only queries over sends, enrollments, campaigns, LinkedIn details, inbound messages,
 * classifications and suppressions. Each query filters by organization_id on every table it touches.
 * Raw SQL keeps the window, status and attribution rules in one place; `domain/metrics.ts` defines what they mean.
 */

type Row = Record<string, unknown>;
const run = async (query: SQL): Promise<Row[]> => (await db.execute(query)) as unknown as Row[];
const num = (v: unknown): number => Number(v ?? 0);

/** [from 00:00, to + 1 day 00:00) in the organization's zone, as timestamptz. */
const windowStart = (f: AnalyticsFilter) => sql`((${f.from}::date)::timestamp at time zone ${f.timeZone})`;
const windowEnd = (f: AnalyticsFilter) => sql`(((${f.to}::date + 1))::timestamp at time zone ${f.timeZone})`;
const inWindow = (column: SQL, f: AnalyticsFilter) => sql`(${column} >= ${windowStart(f)} and ${column} < ${windowEnd(f)})`;

const org = (f: AnalyticsFilter) => sql`${f.organizationId}::uuid`;
/** Restricts enrollments (alias e) to the campaign filter. */
const campaignOf = (f: AnalyticsFilter) => sql`${f.campaignId ? sql`and e.campaign_id = ${f.campaignId}::uuid` : sql``} ${
  f.excludeArchived ? sql`and not exists (select 1 from campaigns ac where ac.id = e.campaign_id and ac.organization_id = e.organization_id and ac.archived_at is not null)` : sql``
}`;
const accountOf = (f: AnalyticsFilter) => (f.linkedinAccountId ? sql`and e.linkedin_account_id = ${f.linkedinAccountId}::uuid` : sql``);

/** The enrollment's first confirmed send. Unknown, failed and in-flight sends never anchor a cohort. */
const touch = (f: AnalyticsFilter) => sql`
  select e.id as enrollment_id, e.campaign_id, e.person_id, e.channel, e.status, min(s.sent_at) as first_at
  from campaign_enrollments e
  join sends s on s.enrollment_id = e.id and s.organization_id = e.organization_id and s.status = 'sent' and s.sent_at is not null
  where e.organization_id = ${org(f)} ${campaignOf(f)}
  group by e.id`;

/**
 * True when the person has an inbound message on the enrollment's channel at or after `at`. Auto-replies and unverified bounce notices are not replies.
 * A private reply (personal campaign) counts for that personal campaign only, never for a regular campaign the person is also in.
 */
const repliedAfter = (f: AnalyticsFilter, channel: SQL, person: SQL, at: SQL, campaign: SQL) => sql`exists (
  select 1 from records r
  join conversations cv on cv.record_id = r.id and cv.organization_id = r.organization_id
  join messages m on m.conversation_id = cv.id and m.organization_id = cv.organization_id
  where r.organization_id = ${org(f)} and r.person_id = ${person} and m.direction = 'inbound'
    and coalesce(m.raw->>'autoReply', 'false') <> 'true'
    and m.channel = ${channel} and m.sent_at >= ${at}
    and (cv.private_campaign_id is null or cv.private_campaign_id = ${campaign}))`;

/** Inbound messages in the window from people who had been contacted (a confirmed send at or before the message). One row per message. */
const replyMessages = (f: AnalyticsFilter, channel?: Channel) => sql`
  select distinct on (m.id) m.id, m.channel, m.sent_at, r.person_id
  from messages m
  join conversations cv on cv.id = m.conversation_id and cv.organization_id = m.organization_id
  join records r on r.id = cv.record_id and r.organization_id = cv.organization_id
  join campaign_enrollments e on e.person_id = r.person_id and e.organization_id = m.organization_id and e.channel = m.channel
  where m.organization_id = ${org(f)} and m.direction = 'inbound' and coalesce(m.raw->>'autoReply', 'false') <> 'true' and ${inWindow(sql`m.sent_at`, f)}
    ${channel ? sql`and m.channel = ${channel}` : sql``} ${campaignOf(f)} ${accountOf(f)}
    and (cv.private_campaign_id is null or cv.private_campaign_id = e.campaign_id)
    and exists (
      select 1 from sends s
      where s.enrollment_id = e.id and s.organization_id = e.organization_id and s.status = 'sent' and s.sent_at <= m.sent_at)
  order by m.id`;

/** Send rows by outcome. Event time is sent_at for confirmed sends, otherwise the claim time. */
const sendTime = sql`coalesce(s.sent_at, s.claimed_at)`;
/**
 * The count column and the `SendCounts` field of each send status. Both are records over `SendStatus`, and every count
 * below is built from `SEND_STATUSES`, so a new status does not compile until the totals have a place for it.
 */
const COUNT_COLUMN: Record<SendStatus, string> = { sent: "sent", unknown: "unknown", failed: "failed", sending: "in_flight" };
const COUNT_FIELD: Record<SendStatus, keyof SendCounts> = { sent: "sent", unknown: "unknown", failed: "failed", sending: "inFlight" };
/** One `count(*) filter` column per send status, inside `scope` when given, named `<prefix><column>`. */
const statusCounts = (scope?: SQL, prefix = "") =>
  sql.join(
    SEND_STATUSES.map((st) => sql`(count(*) filter (where ${scope ? sql`${scope} and ` : sql``}s.status = ${sql.raw(`'${st}'`)}))::int as ${sql.raw(prefix + COUNT_COLUMN[st])}`),
    sql`, `,
  );
/** The `statusCounts` columns of the `ss` join, zero when the join found no row. */
const joinedCounts = (prefix = "") =>
  sql.raw(SEND_STATUSES.map((st) => `coalesce(ss.${prefix}${COUNT_COLUMN[st]}, 0) as ${prefix}${COUNT_COLUMN[st]}`).join(", "));
const sendCounts = (r: Row, prefix = ""): SendCounts =>
  Object.fromEntries(SEND_STATUSES.map((st) => [COUNT_FIELD[st], num(r[`${prefix}${COUNT_COLUMN[st]}`])])) as unknown as SendCounts;

const stepKind = sql`((c.steps -> (s.step_number - 1)) ->> 'kind')`;

export const drizzleAnalyticsReadModel: AnalyticsReadModel = {
  timeZone: (organizationId) => organizationTimeZone(organizationId),

  async filterOptions(organizationId) {
    const campaigns = await run(sql`select id, name, channel, (archived_at is not null) as archived from campaigns where organization_id = ${organizationId}::uuid order by created_at desc`);
    const accounts = await run(sql`select id, coalesce(name, username, linkedin_id) as name from linkedin_accounts where organization_id = ${organizationId}::uuid order by created_at`);
    return {
      campaigns: campaigns.map((r) => ({ id: r.id as string, name: r.name as string, channel: r.channel as Channel, archived: r.archived === true })),
      linkedinAccounts: accounts.map((r) => ({ id: r.id as string, name: r.name as string })),
    };
  },

  async campaigns(f) {
    const rows = await run(sql`
      with touch as (${touch(f)}),
      cohort as (
        select campaign_id, count(*)::int as contacted,
          (count(*) filter (where replied))::int as replied,
          (count(*) filter (where status = 'bounced'))::int as bounced
        from (
          select t.*, ${repliedAfter(f, sql`t.channel`, sql`t.person_id`, sql`t.first_at`, sql`t.campaign_id`)} as replied
          from touch t where ${inWindow(sql`t.first_at`, f)}
        ) x group by campaign_id
      ),
      send_stats as (
        select e.campaign_id, ${statusCounts()}
        from sends s join campaign_enrollments e on e.id = s.enrollment_id and e.organization_id = s.organization_id
        where s.organization_id = ${org(f)} ${campaignOf(f)} and ${inWindow(sendTime, f)}
        group by e.campaign_id
      ),
      enrolled as (
        select e.campaign_id, count(*)::int as n from campaign_enrollments e
        where e.organization_id = ${org(f)} ${campaignOf(f)} group by e.campaign_id
      )
      select c.id, c.name, c.channel, c.status,
        coalesce(enrolled.n, 0) as enrolled,
        coalesce(cohort.contacted, 0) as contacted, coalesce(cohort.replied, 0) as replied, coalesce(cohort.bounced, 0) as bounced,
        ${joinedCounts()}
      from campaigns c
      left join enrolled on enrolled.campaign_id = c.id
      left join cohort on cohort.campaign_id = c.id
      left join send_stats ss on ss.campaign_id = c.id
      where c.organization_id = ${org(f)} ${f.campaignId ? sql`and c.id = ${f.campaignId}::uuid` : sql``} ${f.excludeArchived ? sql`and c.archived_at is null` : sql``}
      order by c.created_at desc, c.id`);
    return rows.map(
      (r): CampaignCounts => ({
        campaignId: r.id as string,
        name: r.name as string,
        channel: r.channel as Channel,
        status: r.status as string,
        enrolled: num(r.enrolled),
        contacted: num(r.contacted),
        replied: num(r.replied),
        bounced: num(r.bounced),
        sends: sendCounts(r),
      }),
    );
  },

  async channels(f) {
    const channelRows = await run(sql`
      with touch as (${touch(f)}),
      cohort as (
        select channel, count(*)::int as contacted, (count(*) filter (where replied))::int as replied,
          (count(*) filter (where status = 'bounced'))::int as bounced
        from (
          select t.*, ${repliedAfter(f, sql`t.channel`, sql`t.person_id`, sql`t.first_at`, sql`t.campaign_id`)} as replied
          from touch t where ${inWindow(sql`t.first_at`, f)}
        ) x group by channel
      ),
      send_stats as (
        select s.channel, ${statusCounts()}
        from sends s join campaign_enrollments e on e.id = s.enrollment_id and e.organization_id = s.organization_id
        where s.organization_id = ${org(f)} ${campaignOf(f)} and ${inWindow(sendTime, f)}
        group by s.channel
      )
      select ch.channel, coalesce(cohort.contacted, 0) as contacted, coalesce(cohort.replied, 0) as replied, coalesce(cohort.bounced, 0) as bounced,
        ${joinedCounts()}
      from (values ('email'), ('linkedin')) as ch(channel)
      left join cohort on cohort.channel = ch.channel
      left join send_stats ss on ss.channel = ch.channel`);

    const senderRows = await run(sql`
      select s.channel, s.mailbox_id, s.linkedin_account_id,
        coalesce(mb.email_address, la.name, la.username, la.linkedin_id, 'Removed sender') as label,
        coalesce(mb.status, la.status, 'removed') as status,
        (count(distinct s.enrollment_id) filter (where s.status = 'sent'))::int as contacted,
        ${statusCounts()}
      from sends s
      join campaign_enrollments e on e.id = s.enrollment_id and e.organization_id = s.organization_id
      left join mailboxes mb on mb.id = s.mailbox_id and mb.organization_id = s.organization_id
      left join linkedin_accounts la on la.id = s.linkedin_account_id and la.organization_id = s.organization_id
      where s.organization_id = ${org(f)} ${campaignOf(f)} and ${inWindow(sendTime, f)}
      group by s.channel, s.mailbox_id, s.linkedin_account_id, mb.email_address, mb.status, la.name, la.username, la.linkedin_id, la.status
      order by s.channel, label`);

    return {
      channels: channelRows.map((r): ChannelCounts => ({
        channel: r.channel as Channel,
        contacted: num(r.contacted),
        replied: num(r.replied),
        bounced: num(r.bounced),
        sends: sendCounts(r),
      })),
      senders: senderRows.map((r): SenderCounts => ({
        channel: r.channel as Channel,
        senderId: (r.mailbox_id ?? r.linkedin_account_id ?? "") as string,
        label: r.label as string,
        status: r.status as string,
        contacted: num(r.contacted),
        sends: sendCounts(r),
      })),
    };
  },

  async linkedin(f) {
    const funnelRows = await run(sql`
      with invited as (
        select e.id as enrollment_id, e.campaign_id, e.person_id, d.connection_state, min(s.sent_at) as invited_at
        from campaign_enrollments e
        join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        join sends s on s.enrollment_id = e.id and s.organization_id = e.organization_id and s.status = 'sent' and s.sent_at is not null
          and ${stepKind} = 'invitation'
        left join linkedin_enrollment_details d on d.enrollment_id = e.id and d.organization_id = e.organization_id
        where e.organization_id = ${org(f)} and e.channel = 'linkedin' ${campaignOf(f)} ${accountOf(f)}
        group by e.id, d.connection_state
      )
      select i.campaign_id, c.name,
        count(*)::int as invited,
        (count(*) filter (where i.connection_state = 'connected'))::int as accepted,
        (count(*) filter (where i.connection_state = 'connected' and exists (
          select 1 from sends s where s.enrollment_id = i.enrollment_id and s.organization_id = ${org(f)} and s.status = 'sent' and ${stepKind} = 'message'
        )))::int as messaged,
        (count(*) filter (where i.connection_state = 'connected' and ${repliedAfter(f, sql`'linkedin'`, sql`i.person_id`, sql`i.invited_at`, sql`i.campaign_id`)}))::int as replied
      from invited i join campaigns c on c.id = i.campaign_id and c.organization_id = ${org(f)}
      where ${inWindow(sql`i.invited_at`, f)}
      group by i.campaign_id, c.name, c.created_at
      order by c.created_at desc, i.campaign_id`);

    const linkedinSends = (kind: "invitation" | "message", status: string) => sql`(
      select count(*)::int from sends s
      join campaign_enrollments e on e.id = s.enrollment_id and e.organization_id = s.organization_id
      join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
      where s.organization_id = ${org(f)} and s.channel = 'linkedin' ${campaignOf(f)} ${accountOf(f)}
        and ${stepKind} = ${kind} and s.status = ${status} and ${inWindow(sendTime, f)})`;
    const [events] = await run(sql`
      select
        ${sql.join(SEND_STATUSES.map((st) => sql`${linkedinSends("invitation", st)} as ${sql.raw(`inv_${COUNT_COLUMN[st]}`)}`), sql`, `)},
        ${sql.join(SEND_STATUSES.map((st) => sql`${linkedinSends("message", st)} as ${sql.raw(`msg_${COUNT_COLUMN[st]}`)}`), sql`, `)},
        (select count(*)::int from linkedin_enrollment_details d join campaign_enrollments e on e.id = d.enrollment_id and e.organization_id = d.organization_id
          where d.organization_id = ${org(f)} ${campaignOf(f)} ${accountOf(f)} and d.accepted_at is not null and ${inWindow(sql`d.accepted_at`, f)}) as accepted,
        (select count(*)::int from (${replyMessages(f, "linkedin")}) rm) as replies`);

    const accountRows = await run(sql`
      select a.id, coalesce(a.name, a.username, a.linkedin_id) as name, a.status,
        ${joinedCounts("inv_")},
        ${joinedCounts("msg_")},
        coalesce(acc.n, 0) as accepted
      from linkedin_accounts a
      left join (
        select s.linkedin_account_id as account_id,
          ${statusCounts(sql`${stepKind} = 'invitation'`, "inv_")},
          ${statusCounts(sql`${stepKind} = 'message'`, "msg_")}
        from sends s
        join campaign_enrollments e on e.id = s.enrollment_id and e.organization_id = s.organization_id
        join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        where s.organization_id = ${org(f)} and s.channel = 'linkedin' ${campaignOf(f)} and ${inWindow(sendTime, f)}
        group by s.linkedin_account_id
      ) ss on ss.account_id = a.id
      left join (
        select e.linkedin_account_id as account_id, count(*)::int as n
        from linkedin_enrollment_details d join campaign_enrollments e on e.id = d.enrollment_id and e.organization_id = d.organization_id
        where d.organization_id = ${org(f)} ${campaignOf(f)} and d.accepted_at is not null and ${inWindow(sql`d.accepted_at`, f)}
        group by e.linkedin_account_id
      ) acc on acc.account_id = a.id
      where a.organization_id = ${org(f)} ${f.linkedinAccountId ? sql`and a.id = ${f.linkedinAccountId}::uuid` : sql``}
      order by a.created_at, a.id`);

    const counts = (r: Row, p: string): SendCounts => sendCounts(r, `${p}_`);
    return {
      campaigns: funnelRows.map((r): LinkedInCampaignFunnel => ({
        campaignId: r.campaign_id as string,
        name: r.name as string,
        invited: num(r.invited),
        accepted: num(r.accepted),
        messaged: num(r.messaged),
        replied: num(r.replied),
      })),
      events: { invites: counts(events, "inv"), messages: counts(events, "msg"), accepted: num(events.accepted), replies: num(events.replies) } satisfies LinkedInEventCounts,
      accounts: accountRows.map((r): LinkedInAccountCounts => ({
        accountId: r.id as string,
        name: r.name as string,
        status: r.status as string,
        invites: counts(r, "inv"),
        messages: counts(r, "msg"),
        accepted: num(r.accepted),
      })),
    };
  },

  async replies(f) {
    const rows = await run(sql`
      with rep as (${replyMessages(f)})
      select rep.channel, cl.status, cl.applied_group_key, sc.name as subcategory, count(*)::int as replies
      from rep
      left join lateral (
        select c.status, c.applied_group_key, c.applied_reply_type_id from reply_type_picks c
        where c.message_id = rep.id and c.organization_id = ${org(f)} and c.status in ('auto_applied', 'accepted', 'overridden', 'proposed')
        order by (c.status = 'proposed'), c.created_at desc limit 1
      ) cl on true
      left join reply_types sc on sc.id = cl.applied_reply_type_id and sc.organization_id = ${org(f)}
      group by rep.channel, cl.status, cl.applied_group_key, sc.name`);
    const suppressionRows = await run(sql`
      select reason, count(*)::int as n from suppression_list
      where organization_id = ${org(f)} and ${inWindow(sql`created_at`, f)} group by reason`);
    return {
      rows: rows.map((r): ReplyCountRow => {
        const bucket = replyBucket((r.status as string | null) ?? null, (r.applied_group_key as string | null) ?? null);
        return { channel: r.channel as Channel, bucket, subcategory: bucket === "pending_review" || bucket === "unclassified" ? null : ((r.subcategory as string | null) ?? null), replies: num(r.replies) };
      }),
      suppressions: Object.fromEntries(suppressionRows.map((r) => [r.reason as SuppressionReason, num(r.n)])),
    };
  },

  async daily(f) {
    const dayOf = sql`to_char(ts at time zone ${f.timeZone}, 'YYYY-MM-DD')`;
    const rows = await run(sql`
      select ${dayOf} as day, metric, count(*)::int as n from (
        select ${sendTime} as ts, 'email_' || s.status as metric
        from sends s join campaign_enrollments e on e.id = s.enrollment_id and e.organization_id = s.organization_id
        where s.organization_id = ${org(f)} and s.channel = 'email' and s.status in ${sqlValues(SEND_OUTCOMES)} ${campaignOf(f)} and ${inWindow(sendTime, f)}
        union all
        select ts, metric from (
          select ${sendTime} as ts,
            case when s.status = 'sent' and ${stepKind} = 'invitation' then 'linkedin_invites'
                 when s.status = 'sent' and ${stepKind} = 'message' then 'linkedin_messages'
                 when s.status = 'unknown' then 'linkedin_unknown'
                 when s.status = 'failed' then 'linkedin_failed' end as metric
          from sends s
          join campaign_enrollments e on e.id = s.enrollment_id and e.organization_id = s.organization_id
          join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
          where s.organization_id = ${org(f)} and s.channel = 'linkedin' ${campaignOf(f)} and ${inWindow(sendTime, f)}
        ) li where metric is not null
        union all
        select d.accepted_at as ts, 'linkedin_accepted' as metric
        from linkedin_enrollment_details d join campaign_enrollments e on e.id = d.enrollment_id and e.organization_id = d.organization_id
        where d.organization_id = ${org(f)} ${campaignOf(f)} and d.accepted_at is not null and ${inWindow(sql`d.accepted_at`, f)}
        union all
        select rm.sent_at as ts, 'replies_' || rm.channel as metric from (${replyMessages(f)}) rm
      ) events
      group by day, metric order by day`);
    const known = new Set<string>(DAILY_METRICS);
    return rows.filter((r) => known.has(r.metric as string)).map((r): DailyEventRow => ({ day: r.day as string, metric: r.metric as DailyMetric, count: num(r.n) }));
  },
};

