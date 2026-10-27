import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import { NotFoundError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";


describeDb("master inbox", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let composition: typeof import("../composition");
  let inbox: typeof import("../../application/inbox");
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture() {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "Inbox");
    orgs.push(created);
    const org = created.organizationId;
    const actor: Actor = { userId: "00000000-0000-0000-0000-000000000000", organizationId: org, role: "owner" };
    return { org, actor, mailbox: `me-${tag}@corp.test` };
  }

  const mail = (f: { org: string; mailbox: string }, partial: Partial<InboundEmailInput> = {}): InboundEmailInput => {
    const n = ++counter;
    return {
      organizationId: f.org,
      accountRef: f.mailbox,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@x.test>`,
      inReplyTo: null,
      from: { email: `lead${n}@acme.test`, name: "Lead Person" },
      to: [f.mailbox],
      subject: "Re: hello",
      bodyText: "Sounds interesting",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
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

  it("creates the default pipeline, person, record, conversation and message once", async () => {
    const f = await fixture();
    const result = await composition.ingestInbound(mail(f, { from: { email: "Jane.Doe@Acme.test", name: "Jane Doe" } }));
    expect(result).toMatchObject({ status: "created", personCreated: true });

    const [person] = await sql`select * from people where organization_id = ${f.org}`;
    expect(person).toMatchObject({ email: "jane.doe@acme.test", source: "inbound", full_name: "Jane Doe", first_name: "Jane", last_name: "Doe", lifecycle: "lead", converted_at: null });
    const [pipeline] = await sql`select * from reply_type_sets where organization_id = ${f.org}`;
    expect(pipeline.is_default).toBe(true);
    expect(await count("reply_handling_settings", f.org)).toBe(1);
    expect(await count("reply_types", f.org)).toBeGreaterThan(10);
    const [record] = await sql`select * from records where organization_id = ${f.org}`;
    expect(record).toMatchObject({ workflow_state: "action_required", active_channel: "email", context_version: 1 });
    expect(record.latest_inbound_message_id).toBe(result.messageId);
    const [message] = await sql`select * from messages where organization_id = ${f.org}`;
    expect(message.idempotency_key).toMatch(/^gmail:me-.*@corp\.test:msg-\d+$/);
    expect(message.direction).toBe("inbound");
  });

  it("is idempotent: the same provider message stores nothing twice", async () => {
    const f = await fixture();
    const input = mail(f);
    const first = await composition.ingestInbound(input);
    const second = await composition.ingestInbound(input);
    const [a, b] = await Promise.all([composition.ingestInbound(input), composition.ingestInbound(input)]);
    expect(first.status).toBe("created");
    for (const r of [second, a, b]) expect(r).toMatchObject({ status: "duplicate", messageId: first.messageId, conversationId: first.conversationId });
    expect(await count("messages", f.org)).toBe(1);
    expect(await count("people", f.org)).toBe(1);
    expect(await count("conversations", f.org)).toBe(1);
    const [record] = await sql`select context_version from records where organization_id = ${f.org}`;
    expect(record.context_version).toBe(1);
  });

  it("concurrent first messages create one default pipeline and one person", async () => {
    const f = await fixture();
    const sender = { email: "same@acme.test", name: null };
    await Promise.all([1, 2, 3, 4].map(() => composition.ingestInbound(mail(f, { from: sender }))));
    expect(await count("reply_type_sets", f.org)).toBe(1);
    expect(await count("people", f.org)).toBe(1);
    expect(await count("records", f.org)).toBe(1);
    expect(await count("messages", f.org)).toBe(4);
  });

  it("reuses an existing person and never overwrites it", async () => {
    const f = await fixture();
    const [{ id: person }] = await sql`
      insert into people (organization_id, email, full_name, title, source) values (${f.org}, 'Known@Acme.test', 'Known Lead', 'CTO', 'import') returning id`;
    const result = await composition.ingestInbound(mail(f, { from: { email: "known@acme.test", name: "Someone Else" } }));
    expect(result).toMatchObject({ personId: person, personCreated: false });
    expect(await count("people", f.org)).toBe(1);
    expect((await sql`select full_name, title, source from people where id = ${person}`)[0]).toEqual({ full_name: "Known Lead", title: "CTO", source: "import" });
  });

  it("leaves a known contact a contact when they write", async () => {
    const f = await fixture();
    const [{ id: person }] = await sql`
      insert into people (organization_id, email, full_name, source, lifecycle, converted_at) values (${f.org}, 'cora@acme.test', 'Cora Contact', 'import', 'contact', now() - interval '1 day') returning id`;
    const before = (await sql`select converted_at from people where id = ${person}`)[0].converted_at;
    const result = await composition.ingestInbound(mail(f, { from: { email: "cora@acme.test", name: "Cora Contact" } }));
    expect(result).toMatchObject({ personId: person, personCreated: false });
    expect((await sql`select lifecycle, converted_at from people where id = ${person}`)[0]).toEqual({ lifecycle: "contact", converted_at: before });
    expect(await count("messages", f.org)).toBe(1);
  });

  it("groups messages by thread and gives a new thread its own conversation under the same record", async () => {
    const f = await fixture();
    const from = { email: "thread@acme.test", name: null };
    const a = await composition.ingestInbound(mail(f, { from, providerThreadId: "T1", receivedAt: new Date("2026-10-14T10:00:00Z") }));
    const b = await composition.ingestInbound(mail(f, { from, providerThreadId: "T1", receivedAt: new Date("2026-10-14T11:00:00Z") }));
    const c = await composition.ingestInbound(mail(f, { from, providerThreadId: "T2" }));
    expect(b.conversationId).toBe(a.conversationId);
    expect(c.conversationId).not.toBe(a.conversationId);
    expect(await count("records", f.org)).toBe(1);
    expect(await count("conversations", f.org)).toBe(2);
    // The same thread id on another mailbox is a different conversation.
    const other = await composition.ingestInbound(mail({ ...f, mailbox: "other-" + f.mailbox }, { from, providerThreadId: "T1" }));
    expect(other.conversationId).not.toBe(a.conversationId);
  });

  it("an older message arriving late does not move the latest inbound pointer back", async () => {
    const f = await fixture();
    const from = { email: "late@acme.test", name: null };
    const newer = await composition.ingestInbound(mail(f, { from, providerThreadId: "L", receivedAt: new Date("2026-10-14T12:00:00Z") }));
    await composition.ingestInbound(mail(f, { from, providerThreadId: "L", receivedAt: new Date("2026-10-14T09:00:00Z") }));
    const [record] = await sql`select latest_inbound_message_id, last_inbound_at from records where organization_id = ${f.org}`;
    expect(record.latest_inbound_message_id).toBe(newer.messageId);
    expect(record.last_inbound_at).toEqual(new Date("2026-10-14T12:00:00Z"));
  });

  it("stores an auto-reply flagged and leaves the record state alone", async () => {
    const f = await fixture();
    const result = await composition.ingestInbound(mail(f, { autoReply: true, subject: "Automatic reply: Hi" }));
    const [record] = await sql`select workflow_state, context_version, last_inbound_at, latest_inbound_message_id from records where organization_id = ${f.org}`;
    expect(record).toMatchObject({ workflow_state: "unclassified", context_version: 0, last_inbound_at: null, latest_inbound_message_id: null });
    // Machine mail leaves the All view (bundled into Automated) and does not count as unread.
    expect((await inbox.listInbox(composition.inboxDeps(), f.actor, {})).total).toBe(0);
    const list = await inbox.listInbox(composition.inboxDeps(), f.actor, { view: "automated" });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ autoReply: true, unreadCount: 0 });
    expect((await inbox.listInbox(composition.inboxDeps(), f.actor, { view: "unread" })).total).toBe(0);
    expect(result.status).toBe("created");
  });

  it("marks an unverified bounce notice apart from a plain auto-reply, in the list and in the thread", async () => {
    const f = await fixture();
    await composition.ingestInbound(mail(f, { autoReply: true, possibleBounce: true, subject: "Delivery Status Notification (Failure)" }));
    await composition.ingestInbound(mail(f, { autoReply: true, subject: "Out of office" }));
    const list = await inbox.listInbox(composition.inboxDeps(), f.actor, { view: "automated" });
    const bySubject = Object.fromEntries(list.rows.map((r) => [r.subject, r]));
    expect(bySubject["Delivery Status Notification (Failure)"]).toMatchObject({ autoReply: true, possibleBounce: true });
    expect(bySubject["Out of office"]).toMatchObject({ autoReply: true, possibleBounce: false });
    const thread = await inbox.getThread(composition.inboxDeps(), f.actor, bySubject["Delivery Status Notification (Failure)"].conversationId);
    expect(thread.messages[0]).toMatchObject({ autoReply: true, possibleBounce: true });
  });

  it("falls back to a placeholder body and the message id as thread id", async () => {
    const f = await fixture();
    const result = await composition.ingestInbound(mail(f, { bodyText: "  \n", providerThreadId: "" , providerMessageId: "solo-1" }));
    const [conversation] = await sql`select provider_thread_id from conversations where id = ${result.conversationId}`;
    expect(conversation.provider_thread_id).toBe("solo-1");
    expect((await sql`select body_text from messages where id = ${result.messageId}`)[0].body_text).toBe("(no text content)");
  });

  it("rejects a sender with no address", async () => {
    const f = await fixture();
    await expect(composition.ingestInbound(mail(f, { from: { email: "not-an-address", name: null } }))).rejects.toThrow(/usable sender/);
  });

  describe("queries", () => {
    it("lists newest first with unread counts, filters and search, scoped to the organization", async () => {
      const f = await fixture();
      const other = await fixture();
      await composition.ingestInbound(mail(f, { from: { email: "ann@acme.test", name: "Ann Old" }, subject: "Pricing", receivedAt: new Date("2026-10-14T08:00:00Z") }));
      const bob = await composition.ingestInbound(mail(f, { from: { email: "bob@beta.test", name: "Bob New" }, subject: "Demo please", bodyText: "Can we book a demo?", receivedAt: new Date("2026-10-14T09:00:00Z") }));
      await composition.ingestInbound(mail(other, { subject: "Not yours" }));
      const deps = composition.inboxDeps();

      const all = await inbox.listInbox(deps, f.actor, {});
      expect(all.total).toBe(2);
      expect(all.rows.map((r) => r.personName)).toEqual(["Bob New", "Ann Old"]);
      expect(all.rows[0]).toMatchObject({ unreadCount: 1, channel: "email", lastDirection: "inbound", snippet: "Can we book a demo?" });

      expect((await inbox.listInbox(deps, f.actor, { query: "demo" })).rows.map((r) => r.personName)).toEqual(["Bob New"]);
      expect((await inbox.listInbox(deps, f.actor, { query: "ANN@" })).rows).toHaveLength(1);
      expect((await inbox.listInbox(deps, f.actor, { query: "%" })).rows).toHaveLength(0);

      await inbox.markConversationRead(deps, f.actor, bob.conversationId);
      const unread = await inbox.listInbox(deps, f.actor, { view: "unread" });
      expect(unread.rows.map((r) => r.personName)).toEqual(["Ann Old"]);
      expect((await inbox.listInbox(deps, f.actor, { page: 2 })).rows).toHaveLength(0);
    });

    it("marks a conversation read once and rejects another organization's conversation", async () => {
      const f = await fixture();
      const other = await fixture();
      const { conversationId } = await composition.ingestInbound(mail(f));
      const deps = composition.inboxDeps();
      expect(await inbox.markConversationRead(deps, f.actor, conversationId)).toEqual({ changed: 1 });
      expect(await inbox.markConversationRead(deps, f.actor, conversationId)).toEqual({ changed: 0 });
      await expect(inbox.markConversationRead(deps, other.actor, conversationId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(inbox.getThread(deps, other.actor, conversationId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(inbox.getThread(deps, f.actor, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("shows the thread with the sequence email that started it, in time order", async () => {
      const f = await fixture();
      const [{ id: mailboxId }] = await sql`
        insert into mailboxes (organization_id, email_address, display_name, status, working_hours)
        values (${f.org}, ${f.mailbox}, 'Me', 'connected', ${sql.json({ timeZone: "UTC", days: {} })}) returning id`;
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'email', 'c', 'active', ${sql.json([])}) returning id`;
      const [{ id: person }] = await sql`insert into people (organization_id, email, full_name) values (${f.org}, 'seq@acme.test', 'Seq Lead') returning id`;
      const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${f.org}, ${campaign}, ${person}, 'email') returning id`;
      await sql`
        insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, subject, body, thread_id, sent_at)
        values (${f.org}, ${enrollment}, 1, 'email', 'sent', ${mailboxId}, 'Hello', 'Opening pitch', 'SEQ', '2026-10-14T08:00:00Z')`;
      const reply = await composition.ingestInbound(
        mail(f, { from: { email: "seq@acme.test", name: null }, providerThreadId: "SEQ", receivedAt: new Date("2026-10-14T09:00:00Z"), bodyText: "Tell me more" }),
      );
      const thread = await inbox.getThread(composition.inboxDeps(), f.actor, reply.conversationId);
      expect(thread.person).toMatchObject({ id: person, name: "Seq Lead", email: "seq@acme.test" });
      expect(thread.messages.map((m) => [m.direction, m.source, m.bodyText])).toEqual([
        ["outbound", "sequence", "Opening pitch"],
        ["inbound", "message", "Tell me more"],
      ]);
      expect(thread.unreadCount).toBe(1);
    });
  });
});
