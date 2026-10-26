import { sql, type SQL } from "drizzle-orm";

/**
 * The campaign that most recently emailed a person: the latest `sends` row of kind `campaign`, channel `email`
 * and status `sent` for any of the person's enrollments, no later than `at` (the last inbound message). That
 * campaign owns the conversation. One row, or none. The caller decides whether the campaign can start a run.
 */
export const owningCampaignSql = (input: { organizationId: SQL; personId: SQL; at: SQL | null }) => sql`
  select camp.id, camp.name, camp.channel, camp.type, camp.status, camp.archived_at
  from sends sd
  join campaign_enrollments ce on ce.id = sd.enrollment_id and ce.organization_id = sd.organization_id
  join campaigns camp on camp.id = ce.campaign_id and camp.organization_id = ce.organization_id
  where sd.organization_id = ${input.organizationId} and ce.person_id = ${input.personId}
    and sd.kind = 'campaign' and sd.channel = 'email' and sd.status = 'sent' and sd.sent_at is not null
    ${input.at ? sql`and sd.sent_at <= ${input.at}` : sql``}
  order by sd.sent_at desc, sd.id desc
  limit 1`;

/** A campaign that may start new runs: email, regular, not archived, running or finished. A paused or draft campaign starts none. */
export const startableCampaignSql = (campaign: { channel: SQL; type: SQL; status: SQL; archivedAt: SQL }) =>
  sql`${campaign.channel} = 'email' and ${campaign.type} = 'regular' and ${campaign.archivedAt} is null and ${campaign.status} in ('active', 'completed')`;

/**
 * A run's flow may keep running. A campaign-owned flow runs only while its status is `active`: switching After a reply
 * off archives it and ends its runs. A legacy standalone flow (no campaign) runs on whatever its status, so a run already in flight finishes on its pinned
 * version.
 * The interrupt sweep and the step claim both use this condition, so they agree.
 */
export const flowRunnableSql = (alias: string) => sql`(${sql.raw(alias)}.campaign_id is null or ${sql.raw(alias)}.status = 'active')`;
