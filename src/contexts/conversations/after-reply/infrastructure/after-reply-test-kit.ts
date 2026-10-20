import type postgres from "postgres";

/**
 * Fixtures for the integration tests of After a reply: a campaign, a person's enrollment in it and a sent email,
 * which together make the campaign the owner of the person's conversation. The tests run against a migrated database.
 */

type Sql = postgres.Sql;

/** A three-step flow in minutes: the reply, a nudge after two days and a last message after three more. */
export const FLOW_STEPS = [
  { name: "Reply to their answer", delayMinutes: 0, subjectTemplate: null, bodyTemplate: null, aiInstructions: "Answer and suggest a time.", knowledgeTags: [] },
  { name: "Nudge", delayMinutes: 2 * 1440, subjectTemplate: null, bodyTemplate: null, aiInstructions: "Check in once.", knowledgeTags: [] },
  { name: "Last", delayMinutes: 3 * 1440, subjectTemplate: null, bodyTemplate: null, aiInstructions: "Close the loop.", knowledgeTags: [] },
];

export async function createCampaign(
  sql: Sql,
  input: { organizationId: string; name?: string; channel?: "email" | "linkedin"; type?: "regular" | "personal"; status?: "draft" | "active" | "paused" | "completed"; archived?: boolean },
): Promise<string> {
  const [row] = await sql`
    insert into campaigns (organization_id, channel, name, type, status, archived_at)
    values (${input.organizationId}, ${input.channel ?? "email"}, ${input.name ?? `Campaign ${Math.random().toString(36).slice(2, 7)}`}, ${input.type ?? "regular"}, ${input.status ?? "active"},
            ${input.archived ? new Date() : null})
    returning id`;
  return row.id as string;
}

/** Enrolls the person (once per campaign) and records one sent email to them at `sentAt`. */
export async function recordSentEmail(
  sql: Sql,
  input: { organizationId: string; campaignId: string; personId: string; sentAt: Date; channel?: "email" | "linkedin"; status?: string; stepNumber?: number },
): Promise<{ enrollmentId: string; sendId: string }> {
  const [existing] = await sql`select id from campaign_enrollments where campaign_id = ${input.campaignId} and person_id = ${input.personId}`;
  const enrollmentId =
    (existing?.id as string | undefined) ??
    ((await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${input.organizationId}, ${input.campaignId}, ${input.personId}, ${input.channel ?? "email"}, 'replied') returning id`)[0].id as string);
  const [{ n }] = await sql`select count(*)::int as n from sends where enrollment_id = ${enrollmentId}`;
  const [send] = await sql`
    insert into sends (organization_id, kind, enrollment_id, step_number, channel, status, sent_at)
    values (${input.organizationId}, 'campaign', ${enrollmentId}, ${input.stepNumber ?? n + 1}, ${input.channel ?? "email"}, ${input.status ?? "sent"}, ${input.sentAt})
    returning id`;
  return { enrollmentId, sendId: send.id as string };
}
