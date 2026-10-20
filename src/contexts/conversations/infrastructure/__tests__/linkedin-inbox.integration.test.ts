import { afterAll, beforeAll, expect, it } from "vitest";
import type { InboundLinkedInInput } from "../../application/linkedin-ports";
import type { Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";

describeDb("master inbox, LinkedIn", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let composition: typeof import("../composition");
  let inbox: typeof import("../../application/inbox");
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture() {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "LI inbox");
    orgs.push(created);
    const org = created.organizationId;
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status)
      values (${org}, ${"acct-" + tag}, ${"ACo-" + tag}, 'Jo Owner', 'connected') returning id`;
    const actor: Actor = { userId: created.userId, organizationId: org, role: "owner" };
    return { org, account: account as string, actor };
  }

  const message = (f: { org: string; account: string }, partial: Partial<InboundLinkedInInput> = {}): InboundLinkedInInput => {
    const n = ++counter;
    return {
      organizationId: f.org,
      accountRef: f.account,
      accountName: "Jo Owner",
      providerThreadId: `chat-${n}`,
      providerMessageId: `msg-${n}`,
      counterparty: { providerId: `ACo-lead-${n}`, name: "Ada Lovelace", profileUrl: `https://www.linkedin.com/in/ada-${n}`, slug: `ada-${n}` },
      personId: null,
      bodyText: "Sounds good",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      ...partial,
    };
  };

  const count = async (table: string, org: string) => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1`, [org]))[0].n);

  beforeAll(async () => {
    composition = await import("../composition");
    inbox = await import("../../application/inbox");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("files a stranger's message under a new inbound person with the LinkedIn slug", async () => {
    const f = await fixture();
    const input = message(f);
    const result = await composition.ingestInboundLinkedInMessage(input);
    expect(result).toMatchObject({ status: "created", personCreated: true });

    const [person] = await sql`select * from people where id = ${result.personId}`;
    expect(person).toMatchObject({ linkedin_slug: input.counterparty.slug, full_name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace", source: "inbound", email: null, lifecycle: "lead", converted_at: null });
    const [conversation] = await sql`select * from conversations where id = ${result.conversationId}`;
    expect(conversation).toMatchObject({ channel: "linkedin", account_ref: f.account, provider_thread_id: input.providerThreadId, provider_contact_id: input.counterparty.providerId });
    const [stored] = await sql`select * from messages where id = ${result.messageId}`;
    expect(stored).toMatchObject({
      channel: "linkedin",
      account_ref: f.account,
      direction: "inbound",
      idempotency_key: `linkedin:${f.account}:${input.providerMessageId}`,
      from_address: "Ada Lovelace",
      to_address: "Jo Owner",
      body_text: "Sounds good",
    });
    const [record] = await sql`select * from records where person_id = ${result.personId}`;
    expect(record).toMatchObject({ workflow_state: "action_required", active_channel: "linkedin", latest_inbound_message_id: result.messageId });
  });

  it("stores a redelivered message once, even when delivered concurrently", async () => {
    const f = await fixture();
    const input = message(f);
    const first = await composition.ingestInboundLinkedInMessage(input);
    const second = await composition.ingestInboundLinkedInMessage(input);
    const [a, b] = await Promise.all([composition.ingestInboundLinkedInMessage(input), composition.ingestInboundLinkedInMessage(input)]);
    expect(first.status).toBe("created");
    expect([second.status, a.status, b.status]).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect(new Set([second.messageId, a.messageId, b.messageId])).toEqual(new Set([first.messageId]));
    expect(await count("messages", f.org)).toBe(1);
    expect(await count("people", f.org)).toBe(1);
  });

  it("groups messages of one chat into one conversation and keeps chats apart", async () => {
    const f = await fixture();
    const who = { providerId: "ACo-same", name: "Grace Hopper", profileUrl: "https://www.linkedin.com/in/grace", slug: "grace" };
    const a = await composition.ingestInboundLinkedInMessage(message(f, { counterparty: who, providerThreadId: "T1", receivedAt: new Date("2026-10-14T10:00:00Z") }));
    const b = await composition.ingestInboundLinkedInMessage(message(f, { counterparty: who, providerThreadId: "T1", receivedAt: new Date("2026-10-14T11:00:00Z") }));
    const c = await composition.ingestInboundLinkedInMessage(message(f, { counterparty: who, providerThreadId: "T2" }));
    expect(b.conversationId).toBe(a.conversationId);
    expect(c.conversationId).not.toBe(a.conversationId);
    // The same person: found again by the profile slug, so there is still one record.
    expect(new Set([a.personId, b.personId, c.personId]).size).toBe(1);
    expect(await count("people", f.org)).toBe(1);
    expect(await count("conversations", f.org)).toBe(2);
  });

  it("puts the message under the lead the caller names, and matches an existing lead by slug", async () => {
    const f = await fixture();
    const [{ id: lead }] = await sql`insert into people (organization_id, linkedin_slug, full_name, email) values (${f.org}, 'known-lead', 'Known Lead', 'known@acme.test') returning id`;
    const named = await composition.ingestInboundLinkedInMessage(message(f, { personId: lead, counterparty: { providerId: "ACo-x", name: null, profileUrl: null, slug: null } }));
    expect(named).toMatchObject({ personId: lead, personCreated: false });
    const [stored] = await sql`select from_address from messages where id = ${named.messageId}`;
    expect(stored.from_address).toBe("Known Lead");

    const bySlug = await composition.ingestInboundLinkedInMessage(message(f, { counterparty: { providerId: "ACo-y", name: "Other Name", profileUrl: null, slug: "known-lead" } }));
    expect(bySlug).toMatchObject({ personId: lead, personCreated: false });
    expect(await count("people", f.org)).toBe(1);
  });

  it("ignores a personId from another organization", async () => {
    const f = await fixture();
    const other = await fixture();
    const [{ id: foreign }] = await sql`insert into people (organization_id, linkedin_slug) values (${other.org}, 'foreign') returning id`;
    const result = await composition.ingestInboundLinkedInMessage(message(f, { personId: foreign }));
    expect(result.personId).not.toBe(foreign);
    expect(result.personCreated).toBe(true);
  });

  it("lists LinkedIn conversations with the channel and sender, and renders the thread", async () => {
    const f = await fixture();
    const other = await fixture();
    const first = await composition.ingestInboundLinkedInMessage(message(f, { bodyText: "Can we talk Tuesday?", receivedAt: new Date("2026-10-14T09:00:00Z") }));
    await composition.ingestInboundLinkedInMessage(message(other, { bodyText: "Not yours" }));

    const deps = composition.inboxDeps();
    const list = await inbox.listInbox(deps, f.actor, {});
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ channel: "linkedin", personName: "Ada Lovelace", personEmail: null, subject: null, snippet: "Can we talk Tuesday?", unreadCount: 1 });
    expect((await inbox.listInbox(deps, f.actor, { query: "tuesday" })).total).toBe(1);
    expect((await inbox.listInbox(deps, f.actor, { query: "ada" })).total).toBe(1);

    const thread = await inbox.getThread(deps, f.actor, first.conversationId);
    expect(thread).toMatchObject({ channel: "linkedin", accountLabel: "Jo Owner" });
    expect(thread.person.linkedinUrl).toMatch(/^https:\/\/www\.linkedin\.com\/in\/ada-/);
    expect(thread.messages.map((m) => [m.direction, m.from, m.to, m.bodyText])).toEqual([["inbound", "Ada Lovelace", "Jo Owner", "Can we talk Tuesday?"]]);
    expect(await inbox.markConversationRead(deps, f.actor, first.conversationId)).toEqual({ changed: 1 });
  });

  it("shows the invitation note and messages we sent in the same thread, in time order", async () => {
    const f = await fixture();
    const reply = await composition.ingestInboundLinkedInMessage(message(f, { bodyText: "Thanks!", receivedAt: new Date("2026-10-14T12:00:00Z") }));
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'c', 'active', ${sql.json([])}) returning id`;
    const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${f.org}, ${campaign}, ${reply.personId}, 'linkedin') returning id`;
    await sql`
      insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, body, sent_at)
      values (${f.org}, ${enrollment}, 1, 'linkedin', 'sent', ${f.account}, 'Hi Ada, let us connect', '2026-10-14T08:00:00Z'),
             (${f.org}, ${enrollment}, 2, 'linkedin', 'sent', ${f.account}, 'Glad we connected', '2026-10-14T11:00:00Z')`;
    const thread = await inbox.getThread(composition.inboxDeps(), f.actor, reply.conversationId);
    expect(thread.messages.map((m) => [m.direction, m.source, m.bodyText])).toEqual([
      ["outbound", "sequence", "Hi Ada, let us connect"],
      ["outbound", "sequence", "Glad we connected"],
      ["inbound", "message", "Thanks!"],
    ]);
    expect(thread.unreadCount).toBe(1);
  });
});
