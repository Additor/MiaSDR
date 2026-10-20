import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaignEnrollments, campaigns, companies, conversations, linkedinAccounts, mailboxes, messages, people, records, sends } from "@/platform/db/schema";
import { OUT_OF_OFFICE_KEY } from "../domain/inbox-filter";
import type { InboxFilter, InboxFilterOptions, InboxRow, InboxStore, ScheduledRow, ThreadMessage } from "../application/ports";
import { publicConversation, publicConversationSql } from "@/platform/db/conversation-visibility";
import { automatedByPattern, autoReplyFlag, excludedFromUnread, likePattern } from "./inbox-sql";

/** CC addresses stored in a message's raw jsonb (inbound headers, or the list a reply went out with). */
function ccOf(raw: unknown): string[] {
  const cc = (raw as { cc?: unknown } | null)?.cc;
  return Array.isArray(cc) ? cc.filter((v): v is string => typeof v === "string") : [];
}

const POSSIBLE_BOUNCE = sql`coalesce(m.raw->>'possibleBounce', 'false') = 'true'`;

interface ListRow {
  conversation_id: string;
  channel: string;
  account_ref: string;
  person_id: string;
  full_name: string | null;
  first_name: string | null;
  email: string | null;
  subject: string | null;
  body_text: string;
  sent_at: Date;
  direction: "inbound" | "outbound";
  auto_reply: boolean;
  possible_bounce: boolean;
  automated: boolean;
  category_key: string | null;
  subcategory_name: string | null;
  unread: number;
  has_important: boolean;
}

interface ScheduledDbRow {
  kind: "campaign" | "sequence";
  id: string;
  person_id: string;
  full_name: string | null;
  first_name: string | null;
  email: string | null;
  channel: string;
  source_name: string;
  step_label: string;
  subject: string | null;
  mailbox: string | null;
  due_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const snippet = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 140);

const uuidList = (ids: string[]): SQL => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
const textList = (values: string[]): SQL => sql.join(values.map((v) => sql`${v}`), sql`, `);
const present = <T,>(list: T[] | undefined): list is T[] => Array.isArray(list) && list.length > 0;

/** Email addresses of the chosen mailboxes, lowercased like `conversations.account_ref`. */
const mailboxAddresses = (organizationId: string, ids: string[]) =>
  sql`(select lower(mb.email_address) from mailboxes mb where mb.organization_id = ${organizationId} and mb.id in (${uuidList(ids)}))`;

/** Filters on the person and the date; shared by the conversation list and the scheduled list. */
function personFilters(f: InboxFilter): SQL[] {
  const out: SQL[] = [];
  if (present(f.leadIds)) out.push(sql`p.id in (${uuidList(f.leadIds)})`);
  if (f.leadQuery) {
    const t = likePattern(f.leadQuery);
    out.push(sql`(p.full_name ilike ${t} or p.email ilike ${t})`);
  }
  return out;
}

function conversationFilters(organizationId: string, f: InboxFilter): SQL[] {
  const out: SQL[] = [sql`c.organization_id = ${organizationId}`, publicConversationSql("c"), ...personFilters(f)];
  if (f.query) {
    const t = likePattern(f.query);
    // Any message of the thread can match, not only the latest.
    out.push(sql`(p.full_name ilike ${t} or p.first_name ilike ${t} or p.last_name ilike ${t} or p.email ilike ${t}
      or exists (select 1 from messages mm where mm.conversation_id = c.id and (mm.subject ilike ${t} or mm.body_text ilike ${t})))`);
  }
  if (present(f.campaignIds)) {
    out.push(sql`exists (select 1 from campaign_enrollments ce where ce.organization_id = ${organizationId} and ce.person_id = p.id and ce.campaign_id in (${uuidList(f.campaignIds)}))`);
  }
  if (present(f.mailboxIds)) out.push(sql`lower(c.account_ref) in ${mailboxAddresses(organizationId, f.mailboxIds)}`);
  if (present(f.subcategoryKeys)) out.push(sql`s.key in (${textList(f.subcategoryKeys)})`);
  if (present(f.categoryKeys)) out.push(sql`r.category_key in (${textList(f.categoryKeys)})`);
  if (f.from) out.push(sql`lm.sent_at >= ${f.from.toISOString()}::timestamptz`);
  if (f.to) out.push(sql`lm.sent_at < ${f.to.toISOString()}::timestamptz`);
  return out;
}

/** One row per conversation with the latest message and the per-row facts every view filters on. */
function conversationSource(organizationId: string, f: InboxFilter): SQL {
  return sql`
    select c.id as conversation_id, c.channel, c.account_ref, p.id as person_id, p.full_name, p.first_name, p.email,
           r.category_key, s.key as subcategory_key, s.name as subcategory_name,
           lm.subject, lm.body_text, lm.sent_at, lm.direction, lm.auto_reply, lm.possible_bounce,
           (lm.direction = 'inbound' and (lm.auto_reply or lm.possible_bounce or lm.by_pattern)) as automated,
           (select count(*)::int from messages m
             where m.conversation_id = c.id and m.direction = 'inbound' and m.opened_at is null and not ${excludedFromUnread("m")}) as unread,
           exists (select 1 from messages m where m.conversation_id = c.id and m.important) as has_important
    from conversations c
    join records r on r.id = c.record_id
    join people p on p.id = r.person_id
    left join subcategories s on s.id = r.subcategory_id
    join lateral (
      select m.subject, m.body_text, m.sent_at, m.direction, ${autoReplyFlag("m")} as auto_reply, ${POSSIBLE_BOUNCE} as possible_bounce,
             ${automatedByPattern("m")} as by_pattern
      from messages m where m.conversation_id = c.id order by m.sent_at desc, m.id desc limit 1
    ) lm on true
    where ${sql.join(conversationFilters(organizationId, f), sql` and `)}`;
}

/** The view as a condition on the source rows (`t`). */
function viewCondition(f: InboxFilter): SQL {
  switch (f.view) {
    case "unread":
      return sql`t.unread > 0`;
    case "important":
      return sql`t.has_important`;
    case "sent":
      return sql`t.direction = 'outbound'`;
    case "replied":
      return sql`t.direction = 'inbound' and not t.automated and coalesce(t.subcategory_key, '') <> ${OUT_OF_OFFICE_KEY}`;
    case "ooo":
      return sql`t.subcategory_key = ${OUT_OF_OFFICE_KEY}`;
    case "automated":
      return sql`t.automated`;
    // `all` bundles machine mail into the Automated view. A search still finds it.
    default:
      return f.query ? sql`true` : sql`not t.automated`;
  }
}

export const drizzleInboxStore: InboxStore = {
  async list(organizationId, filter) {
    const source = conversationSource(organizationId, filter);
    const where = viewCondition(filter);
    const rows = (await db.execute(sql`
      select * from (${source}) t
      where ${where}
      order by t.sent_at desc, t.conversation_id desc
      limit ${filter.pageSize} offset ${(filter.page - 1) * filter.pageSize}
    `)) as unknown as ListRow[];

    // One pass for the page total and for the machine-mail bundle the `all` view leaves out.
    const [counts] = (await db.execute(sql`
      select count(*) filter (where ${where})::int as total, count(*) filter (where t.automated)::int as hidden from (${source}) t
    `)) as unknown as Array<{ total: number; hidden: number }>;
    const total = counts.total;
    const hidden = filter.view === "all" && !filter.query ? counts.hidden : 0;

    const mapped: InboxRow[] = rows.map((r) => ({
      conversationId: r.conversation_id,
      channel: r.channel,
      accountRef: r.account_ref,
      personId: r.person_id,
      personName: r.full_name ?? r.first_name,
      personEmail: r.email,
      subject: r.subject,
      snippet: snippet(r.body_text),
      lastMessageAt: new Date(r.sent_at),
      lastDirection: r.direction,
      unreadCount: r.unread,
      autoReply: r.auto_reply,
      possibleBounce: r.possible_bounce,
      hasImportant: r.has_important,
      automated: r.automated,
      categoryKey: r.category_key,
      subcategoryName: r.subcategory_name,
    }));
    return { rows: mapped, total, automatedHidden: hidden };
  },

  async listScheduled(organizationId, filter) {
    const person = personFilters(filter);
    const dueRange = (column: string): SQL[] => [
      ...(filter.from ? [sql`${sql.raw(column)} >= ${filter.from.toISOString()}::timestamptz`] : []),
      ...(filter.to ? [sql`${sql.raw(column)} < ${filter.to.toISOString()}::timestamptz`] : []),
    ];
    // Subcategory and category describe a conversation's record, not a campaign step, so they do not narrow this list.
    const campaignWhere = [
      sql`ce.organization_id = ${organizationId}`,
      sql`ce.status = 'active'`,
      sql`ce.next_send_at is not null`,
      sql`camp.status = 'active'`,
      sql`camp.type = 'regular'`,
      ...person,
      ...(present(filter.campaignIds) ? [sql`ce.campaign_id in (${uuidList(filter.campaignIds)})`] : []),
      ...(present(filter.mailboxIds) ? [sql`ce.mailbox_id in (${uuidList(filter.mailboxIds)})`] : []),
      ...dueRange("ce.next_send_at"),
    ];
    const sequenceWhere = [
      sql`ssr.organization_id = ${organizationId}`,
      publicConversationSql("c"),
      sql`ssr.status = 'scheduled'`,
      sql`sr.status = 'active'`,
      // A paused campaign holds its follow-ups, so they are not scheduled to go out. A legacy sequence has no campaign and keeps running.
      sql`seq_camp.status is distinct from 'paused'`,
      ...person,
      ...(present(filter.campaignIds) ? [sql`seq.campaign_id in (${uuidList(filter.campaignIds)})`] : []),
      ...(present(filter.mailboxIds) ? [sql`lower(c.account_ref) in ${mailboxAddresses(organizationId, filter.mailboxIds)}`] : []),
      ...dueRange("ssr.due_at"),
    ];
    const union = sql`
      select 'campaign'::text as kind, ce.id, p.id as person_id, p.full_name, p.first_name, p.email, ce.channel,
             camp.name as source_name,
             'Step ' || (ce.current_step + 1) || coalesce(' (' || (st.v->>'kind') || ')', '') as step_label,
             st.v->>'subject' as subject, mb.email_address as mailbox, ce.next_send_at as due_at
      from campaign_enrollments ce
      join campaigns camp on camp.id = ce.campaign_id and camp.organization_id = ce.organization_id
      join people p on p.id = ce.person_id
      left join mailboxes mb on mb.id = ce.mailbox_id
      join lateral (select e.v from jsonb_array_elements(camp.steps) as e(v) where (e.v->>'stepNumber')::int = ce.current_step + 1 limit 1) st on true
      where ${sql.join(campaignWhere, sql` and `)}
      union all
      select 'sequence'::text, ssr.id, p.id, p.full_name, p.first_name, p.email, c.channel,
             coalesce(seq_camp.name, seq.name), ss.name, null::text, case when c.channel = 'email' then c.account_ref else null end, ssr.due_at
      from sequence_step_runs ssr
      join sequence_runs sr on sr.id = ssr.sequence_run_id and sr.organization_id = ssr.organization_id
      join sequence_steps ss on ss.id = ssr.sequence_step_id
      join sequences seq on seq.id = sr.sequence_id and seq.organization_id = sr.organization_id
      left join campaigns seq_camp on seq_camp.id = seq.campaign_id and seq_camp.organization_id = seq.organization_id
      join conversations c on c.id = sr.conversation_id
      join records r on r.id = sr.record_id
      join people p on p.id = r.person_id
      where ${sql.join(sequenceWhere, sql` and `)}`;
    const rows = (await db.execute(sql`
      select * from (${union}) u order by u.due_at asc, u.id asc
      limit ${filter.pageSize} offset ${(filter.page - 1) * filter.pageSize}
    `)) as unknown as ScheduledDbRow[];
    const [{ total }] = (await db.execute(sql`select count(*)::int as total from (${union}) u`)) as unknown as Array<{ total: number }>;
    const mapped: ScheduledRow[] = rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      personId: r.person_id,
      personName: r.full_name ?? r.first_name,
      personEmail: r.email,
      channel: r.channel,
      sourceName: r.source_name,
      stepLabel: r.step_label,
      subject: r.subject,
      mailbox: r.mailbox,
      dueAt: new Date(r.due_at),
    }));
    return { rows: mapped, total };
  },

  async filterOptions(organizationId, leadIds): Promise<InboxFilterOptions> {
    const [boxes, camps, subs, leads] = await Promise.all([
      db.select({ id: mailboxes.id, label: mailboxes.emailAddress }).from(mailboxes).where(eq(mailboxes.organizationId, organizationId)).orderBy(mailboxes.emailAddress),
      db.execute(sql`select id, name as label from campaigns where organization_id = ${organizationId} and status <> 'draft' and type = 'regular' order by name limit 200`),
      db.execute(sql`select key, min(name) as label from subcategories where organization_id = ${organizationId} and active group by key order by min(name)`),
      leadIds.length > 0
        ? db.execute(sql`select id, coalesce(full_name, first_name, email) as label from people where organization_id = ${organizationId} and id in (${uuidList(leadIds)})`)
        : Promise.resolve([]),
    ]);
    return {
      mailboxes: boxes,
      campaigns: camps as unknown as InboxFilterOptions["campaigns"],
      subcategories: subs as unknown as InboxFilterOptions["subcategories"],
      leads: leads as unknown as InboxFilterOptions["leads"],
    };
  },

  async thread(organizationId, conversationId) {
    const [head] = await db
      .select({
        conversationId: conversations.id,
        channel: conversations.channel,
        accountRef: conversations.accountRef,
        recordId: conversations.recordId,
        providerThreadId: conversations.providerThreadId,
        workflowState: records.workflowState,
        contextVersion: records.contextVersion,
        personId: people.id,
        fullName: people.fullName,
        firstName: people.firstName,
        email: people.email,
        linkedinSlug: people.linkedinSlug,
        title: people.title,
        company: companies.name,
      })
      .from(conversations)
      .innerJoin(records, eq(records.id, conversations.recordId))
      .innerJoin(people, eq(people.id, records.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId), publicConversation));
    if (!head) return null;

    const [latestDraft] = (await db.execute(sql`
      select status from drafts
      where organization_id = ${organizationId} and conversation_id = ${conversationId} and status not in ('discarded', 'stale')
        and expected_context_version = (select r.context_version from records r where r.id = drafts.record_id)
      order by created_at desc, id desc limit 1
    `)) as unknown as Array<{ status: string }>;

    const stored = await db
      .select()
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.conversationId, conversationId)));

    // Outreach steps sent in the same mail thread belong to the conversation even though they live in `sends`.
    const sequence =
      head.channel === "email" && head.providerThreadId
        ? await db
            .select({ id: sends.id, subject: sends.subject, body: sends.body, sentAt: sends.sentAt, claimedAt: sends.claimedAt })
            .from(sends)
            .innerJoin(mailboxes, eq(mailboxes.id, sends.mailboxId))
            .where(
              and(
                eq(sends.organizationId, organizationId),
                eq(sends.channel, "email"),
                eq(sends.status, "sent"),
                eq(sends.threadId, head.providerThreadId),
                eq(sql`lower(${mailboxes.emailAddress})`, head.accountRef),
              ),
            )
        : [];

    // The same for LinkedIn: the invitation note and messages we sent this lead from this account.
    const linkedinSequence =
      head.channel === "linkedin"
        ? await db
            .select({ id: sends.id, body: sends.body, sentAt: sends.sentAt, claimedAt: sends.claimedAt })
            .from(sends)
            .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
            .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
            .where(
              and(
                // What a personal campaign sent stays out of the shared thread.
                eq(campaigns.type, "regular"),
                eq(sends.organizationId, organizationId),
                eq(sends.channel, "linkedin"),
                eq(sends.status, "sent"),
                eq(sends.linkedinAccountId, head.accountRef as string),
                eq(campaignEnrollments.personId, head.personId),
              ),
            )
        : [];
    const linkedinAccountName =
      head.channel === "linkedin" && UUID.test(head.accountRef)
        ? ((await db.select({ name: linkedinAccounts.name, username: linkedinAccounts.username }).from(linkedinAccounts).where(eq(linkedinAccounts.id, head.accountRef)))[0] ?? null)
        : null;
    const accountLabel = head.channel === "linkedin" ? (linkedinAccountName?.name ?? linkedinAccountName?.username ?? "LinkedIn account") : head.accountRef;
    const personLabel = head.fullName ?? head.firstName ?? head.email;

    const thread: ThreadMessage[] = [
      ...stored.map((m): ThreadMessage => {
        const autoReply = (m.raw as { autoReply?: boolean } | null)?.autoReply === true;
        const possibleBounce = (m.raw as { possibleBounce?: boolean } | null)?.possibleBounce === true;
        return {
          id: m.id,
          direction: m.direction as "inbound" | "outbound",
          source: "message",
          subject: m.subject,
          from: m.fromAddress,
          to: m.toAddress,
          cc: ccOf(m.raw),
          bodyText: m.bodyText,
          at: m.sentAt,
          autoReply,
          possibleBounce,
          unread: m.direction === "inbound" && m.openedAt === null && !autoReply,
          important: m.important,
        };
      }),
      ...linkedinSequence
        .filter((s) => s.body)
        .map(
          (s): ThreadMessage => ({
            id: s.id,
            direction: "outbound",
            source: "sequence",
            subject: null,
            from: accountLabel,
            to: personLabel,
            bodyText: s.body ?? "",
            at: s.sentAt ?? s.claimedAt,
            autoReply: false,
            possibleBounce: false,
            unread: false,
            important: false,
          }),
        ),
      ...sequence.map(
        (s): ThreadMessage => ({
          id: s.id,
          direction: "outbound",
          source: "sequence",
          subject: s.subject,
          from: head.accountRef,
          to: head.email,
          bodyText: s.body ?? "",
          at: s.sentAt ?? s.claimedAt,
          autoReply: false,
          possibleBounce: false,
          unread: false,
          important: false,
        }),
      ),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    return {
      conversationId: head.conversationId,
      recordId: head.recordId,
      channel: head.channel,
      accountRef: head.accountRef,
      accountLabel,
      workflowState: head.workflowState,
      contextVersion: head.contextVersion,
      latestDraftStatus: latestDraft?.status ?? null,
      person: {
        id: head.personId,
        name: head.fullName ?? head.firstName,
        email: head.email,
        linkedinUrl: head.linkedinSlug ? `https://www.linkedin.com/in/${head.linkedinSlug}` : null,
        title: head.title,
        company: head.company,
      },
      messages: thread,
      unreadCount: thread.filter((m) => m.unread).length,
    };
  },

  async markRead(organizationId, conversationId, at) {
    const [found] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId), publicConversation));
    if (!found) return null;
    const changed = await db
      .update(messages)
      .set({ openedAt: at })
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "inbound"), sql`${messages.openedAt} is null`))
      .returning({ id: messages.id });
    return changed.length;
  },
};
