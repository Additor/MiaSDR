import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { companies, leadFitAssessments, people } from "@/platform/db/schema";
import type { ChatConversation, ChatPersonRow, MiaChatReads } from "../application/chat-ports";
import { THEIR_REPLY } from "./fit-inputs";

const likeText = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const rowColumns = { id: people.id, name: people.fullName, title: people.title, company: companies.name, lifecycle: people.lifecycle };

const companyJoin = and(eq(companies.id, people.companyId), eq(companies.organizationId, people.organizationId));

/**
 * The people, companies and conversations a chat may read. Phone numbers and imported raw columns never leave here, and
 * nothing here writes. Brain comes through Brain's own store in the composition.
 */
export const drizzleMiaChatReads: Omit<MiaChatReads, "brainItems" | "brainItem"> = {
  async searchPeople(organizationId, query, limit) {
    const q = likeText(query);
    const match = query === "" ? sql`true` : sql`(${people.fullName} ilike ${q} or ${people.email} ilike ${q} or ${people.title} ilike ${q} or ${companies.name} ilike ${q} or ${companies.domain} ilike ${q})`;
    return (await db
      .select(rowColumns)
      .from(people)
      .leftJoin(companies, companyJoin)
      .where(and(eq(people.organizationId, organizationId), match))
      .orderBy(desc(people.updatedAt), desc(people.id))
      .limit(limit)) as ChatPersonRow[];
  },

  async person(organizationId, id) {
    const [row] = await db
      .select({ ...rowColumns, email: people.email, linkedinUrl: people.linkedinUrl, companyId: people.companyId, companyDomain: companies.domain, custom: people.custom, createdAt: people.createdAt })
      .from(people)
      .leftJoin(companies, companyJoin)
      .where(and(eq(people.id, id), eq(people.organizationId, organizationId)));
    return row ?? null;
  },

  async company(organizationId, id) {
    const [company] = await db
      .select({ id: companies.id, name: companies.name, domain: companies.domain, custom: companies.custom })
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)));
    if (!company) return null;
    const rows = await db
      .select({ id: people.id, name: people.fullName, title: people.title, lifecycle: people.lifecycle })
      .from(people)
      .where(and(eq(people.organizationId, organizationId), eq(people.companyId, id)))
      .orderBy(desc(people.updatedAt), desc(people.id))
      .limit(10);
    return { ...company, people: rows.map((r) => ({ ...r, company: company.name })) };
  },

  async conversation(organizationId, personId, limit): Promise<ChatConversation> {
    const rows = (await db.execute(sql`
      select m.thread_id, m.direction, m.channel, m.sent_at, m.subject, left(m.body_text, 2000) as body_text
      from messages m
      join threads t on t.id = m.thread_id and t.organization_id = m.organization_id
      join conversations c on c.id = t.conversation_id and c.organization_id = t.organization_id
      where c.organization_id = ${organizationId}::uuid and c.person_id = ${personId}::uuid
        and (m.direction = 'outbound' or ${THEIR_REPLY})
      order by m.sent_at desc, m.id desc
      limit ${limit}
    `)) as unknown as Array<{ thread_id: string; direction: "inbound" | "outbound"; channel: string; sent_at: string; subject: string | null; body_text: string }>;
    return {
      threadIds: [...new Set(rows.map((r) => r.thread_id))],
      messages: rows.map((r) => ({ direction: r.direction, channel: r.channel, sentAt: new Date(r.sent_at), subject: r.subject, text: r.body_text })),
    };
  },

  async fit(organizationId, personId) {
    const [row] = await db
      .select({ verdict: leadFitAssessments.verdict, criteria: leadFitAssessments.criteria, missing: leadFitAssessments.missing, assessedAt: leadFitAssessments.assessedAt })
      .from(leadFitAssessments)
      .where(and(eq(leadFitAssessments.personId, personId), eq(leadFitAssessments.organizationId, organizationId)));
    return row ?? null;
  },
};
