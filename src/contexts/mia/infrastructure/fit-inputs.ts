import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { companies, people } from "@/platform/db/schema";
import { genuineInboundSql } from "@/platform/db/genuine-inbound";
import { AUTOMATED_SENDER_PATTERN, AUTOMATED_SUBJECT_PATTERN } from "@/contexts/conversations/domain/inbox-filter";
import { fitCompanyText, fitProfileText, type LeadFitProfile } from "@/contexts/people/domain/lead-fit";
import { fitProfileHash } from "@/contexts/people/domain/lead-fit-hash";
import { FIT_MESSAGE_CHARS, FIT_MESSAGES } from "../domain/mia-run";
import type { MiaLeadPort } from "../application/mia-ports";

/**
 * A reply the lead wrote: inbound with no auto-reply flag (`genuineInboundSql`, which also catches an out-of-office from
 * their own address), and no machine mail by sender or subject, as the inbox reads it. A chat reads replies by it too.
 */
export const THEIR_REPLY =sql`(${genuineInboundSql("m")} and not (coalesce(m.from_address, '') ~* ${AUTOMATED_SENDER_PATTERN}::text or coalesce(m.subject, '') ~* ${AUTOMATED_SUBJECT_PATTERN}::text))`;

interface MessageRow {
  id: string;
  direction: "inbound" | "outbound";
  body_text: string;
}

/**
 * The latest messages of one person, with machine mail (auto-replies, no-reply senders, bounces) left out. `src/read-models/lead-fit.ts`
 * reads the newest inbound one with the same rule, so a bounce does not ask for a new check.
 */
async function latestMessages(organizationId: string, personId: string): Promise<MessageRow[]> {
  return (await db.execute(sql`
    select m.id, m.direction, left(m.body_text, ${FIT_MESSAGE_CHARS}) as body_text
    from messages m
    join threads t on t.id = m.thread_id and t.organization_id = m.organization_id
    join conversations c on c.id = t.conversation_id and c.organization_id = t.organization_id
    where c.organization_id = ${organizationId}::uuid and c.person_id = ${personId}::uuid
      and (m.direction = 'outbound' or ${THEIR_REPLY})
    order by m.sent_at desc, m.id desc
    limit ${FIT_MESSAGES}
  `)) as unknown as MessageRow[];
}

async function newestInbound(organizationId: string, personId: string): Promise<string | null> {
  const [row] = (await db.execute(sql`
    select m.id
    from messages m
    join threads t on t.id = m.thread_id and t.organization_id = m.organization_id
    join conversations c on c.id = t.conversation_id and c.organization_id = t.organization_id
    where c.organization_id = ${organizationId}::uuid and c.person_id = ${personId}::uuid
      and ${THEIR_REPLY}
    order by m.sent_at desc, m.id desc
    limit 1
  `)) as unknown as Array<{ id: string }>;
  return row?.id ?? null;
}

/** What a fit check reads of one person, through a port, so the run reaches no other lead. Phone, email and raw import columns stay out. */
export const drizzleMiaLeadPort: MiaLeadPort = {
  async fitInput(organizationId, personId) {
    const [person] = await db
      .select({ fullName: people.fullName, title: people.title, custom: people.custom, companyName: companies.name, companyDomain: companies.domain, companyCustom: companies.custom })
      .from(people)
      .leftJoin(companies, and(eq(companies.id, people.companyId), eq(companies.organizationId, people.organizationId)))
      .where(and(eq(people.id, personId), eq(people.organizationId, organizationId)));
    if (!person) return null;
    const profile: LeadFitProfile = { ...person, companyCustom: person.companyCustom ?? {} };
    const [messages, latestInboundMessageId] = await Promise.all([latestMessages(organizationId, personId), newestInbound(organizationId, personId)]);
    return {
      sources: {
        profile: fitProfileText(profile),
        company: fitCompanyText(profile),
        theirReplies: messages.filter((m) => m.direction === "inbound").map((m) => m.body_text),
        ourMessages: messages.filter((m) => m.direction === "outbound").map((m) => m.body_text),
      },
      profileHash: fitProfileHash(profile),
      latestInboundMessageId,
    };
  },

  async existing(organizationId, ids) {
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.organizationId, organizationId), inArray(people.id, [...ids])));
    return rows.map((r) => r.id);
  },
};
