import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import type { Actor } from "@/shared/errors";
import { calendarDayInZone, startOfDayInZone } from "@/shared/time-zone";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";


const HOUR = 3_600_000;

describeDb("inbox filters, views and search", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let composition: typeof import("../composition");
  let inbox: typeof import("../../application/inbox");
  let unreadStore: typeof import("../drizzle-unread-store");
  const orgs: TestOrg[] = [];
  let counter = 0;

  interface Fixture {
    org: string;
    actor: Actor;
    mailbox: string;
    mailboxId: string;
  }

  async function fixture(): Promise<Fixture> {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "Views");
    orgs.push(created);
    const org = created.organizationId;
    const mailbox = `me-${tag}@corp.test`;
    const [{ id: mailboxId }] = await sql`
      insert into mailboxes (organization_id, email_address, display_name, status, working_hours)
      values (${org}, ${mailbox}, 'Me', 'connected', ${sql.json({ timeZone: "UTC", days: {} })}) returning id`;
    return { org, actor: { userId: "00000000-0000-0000-0000-000000000000", organizationId: org, role: "owner" }, mailbox, mailboxId };
  }

  interface Seed {
    email?: string;
    name?: string | null;
    subject?: string;
    body?: string;
    at?: Date;
    autoReply?: boolean;
    possibleBounce?: boolean;
    mailbox?: string;
    from?: string;
  }

  /** Creates the person, record, conversation and first inbound message through the real ingest path. */
  async function inboundThread(f: Fixture, seed: Seed = {}) {
    const n = ++counter;
    const email = seed.email ?? `lead${n}@acme.test`;
    const input: InboundEmailInput = {
      organizationId: f.org,
      accountRef: seed.mailbox ?? f.mailbox,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<v${n}@x.test>`,
      inReplyTo: null,
      from: { email: seed.from ?? email, name: seed.name === undefined ? "Lead Person" : seed.name },
      to: [f.mailbox],
      subject: seed.subject ?? "Re: hello",
      bodyText: seed.body ?? "Sounds interesting",
      receivedAt: seed.at ?? new Date(Date.now() - 3 * 24 * HOUR),
      autoReply: seed.autoReply ?? false,
      possibleBounce: seed.possibleBounce,
    };
    const result = await composition.ingestInbound(input);
    return { ...result, email, personId: result.personId };
  }

  /** Adds a message to an existing conversation without the ingest path (outbound replies, later inbound). */
  async function addMessage(conversationId: string, m: { direction: "inbound" | "outbound"; body: string; at: Date; subject?: string; from?: string; raw?: unknown }) {
    const [c] = await sql`select organization_id, channel, account_ref from conversations where id = ${conversationId}`;
    await sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, subject, from_address, body_text, sent_at, raw)
      values (${c.organization_id}, ${conversationId}, ${c.channel}, ${c.account_ref}, ${m.direction}, ${"k-" + ++counter}, ${m.subject ?? null}, ${m.from ?? null}, ${m.body}, ${m.at}, ${m.raw ? sql.json(m.raw as never) : null})`;
  }

  async function classify(conversationId: string, subcategoryKey: string) {
    await sql`
      update records set category_key = s.category_key, subcategory_id = s.id, category_source = 'human'
      from subcategories s, conversations c
      where c.id = ${conversationId} and records.id = c.record_id and s.pipeline_id = records.pipeline_id and s.key = ${subcategoryKey}`;
  }

  const ids = (rows: Array<{ conversationId: string }>) => rows.map((r) => r.conversationId).sort();
  const list = async (f: Fixture, input: Parameters<typeof inbox.listInbox>[2] = {}) => inbox.listInbox(composition.inboxDeps(), f.actor, input);

  beforeAll(async () => {
    composition = await import("../composition");
    inbox = await import("../../application/inbox");
    unreadStore = await import("../drizzle-unread-store");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("filters", () => {
    it("an empty filter returns what a plain list returns", async () => {
      const f = await fixture();
      for (let i = 0; i < 3; i++) await inboundThread(f, { at: new Date(Date.now() - (i + 2) * 24 * HOUR) });
      const plain = await list(f);
      const empty = await list(f, {
        leadIds: [], leadQuery: "", campaignIds: [], mailboxIds: [], subcategoryKeys: [], categoryKeys: [], dateMode: "all", dateFrom: "", dateTo: "",
      });
      expect(plain.total).toBe(3);
      expect(empty.rows.map((r) => r.conversationId)).toEqual(plain.rows.map((r) => r.conversationId));
      expect(empty.total).toBe(plain.total);
    });

    it("filters by lead id and by lead name or email text", async () => {
      const f = await fixture();
      const ann = await inboundThread(f, { email: "ann@acme.test", name: "Ann Archer" });
      const bob = await inboundThread(f, { email: "bob@beta.test", name: "Bob Baker" });
      expect(ids((await list(f, { leadIds: [ann.personId] })).rows)).toEqual([ann.conversationId]);
      expect(ids((await list(f, { leadIds: [ann.personId, bob.personId] })).rows)).toEqual(ids([ann, bob]));
      expect(ids((await list(f, { leadQuery: "baker" })).rows)).toEqual([bob.conversationId]);
      expect(ids((await list(f, { leadQuery: "ann@" })).rows)).toEqual([ann.conversationId]);
      expect((await list(f, { leadIds: ["00000000-0000-4000-8000-000000000000"] })).total).toBe(0);
    });

    it("filters by campaign through the person's enrollment", async () => {
      const f = await fixture();
      const ann = await inboundThread(f, { email: "ann@acme.test" });
      const bob = await inboundThread(f, { email: "bob@acme.test" });
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'email', 'Q4', 'active', ${sql.json([])}) returning id`;
      const [{ id: other }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'email', 'Q3', 'active', ${sql.json([])}) returning id`;
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${f.org}, ${campaign}, ${ann.personId}, 'email', 'replied')`;
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${f.org}, ${other}, ${bob.personId}, 'email', 'replied')`;
      expect(ids((await list(f, { campaignIds: [campaign] })).rows)).toEqual([ann.conversationId]);
      expect(ids((await list(f, { campaignIds: [campaign, other] })).rows)).toEqual(ids([ann, bob]));
    });

    it("filters by mailbox", async () => {
      const f = await fixture();
      const [{ id: secondId }] = await sql`
        insert into mailboxes (organization_id, email_address, status, working_hours)
        values (${f.org}, ${"second-" + f.mailbox}, 'connected', ${sql.json({ timeZone: "UTC", days: {} })}) returning id`;
      const a = await inboundThread(f);
      const b = await inboundThread(f, { mailbox: "second-" + f.mailbox });
      expect(ids((await list(f, { mailboxIds: [f.mailboxId] })).rows)).toEqual([a.conversationId]);
      expect(ids((await list(f, { mailboxIds: [secondId] })).rows)).toEqual([b.conversationId]);
    });

    it("filters by subcategory and by category, and fills the category chip", async () => {
      const f = await fixture();
      const a = await inboundThread(f);
      const b = await inboundThread(f);
      const c = await inboundThread(f);
      await classify(a.conversationId, "demo_request");
      await classify(b.conversationId, "not_required_right_now");
      const demo = await list(f, { subcategoryKeys: ["demo_request"] });
      expect(ids(demo.rows)).toEqual([a.conversationId]);
      expect(demo.rows[0]).toMatchObject({ categoryKey: "interested", subcategoryName: expect.any(String) });
      expect(ids((await list(f, { categoryKeys: ["not_interested"] })).rows)).toEqual([b.conversationId]);
      expect(ids((await list(f, { categoryKeys: ["interested", "not_interested"] })).rows)).toEqual(ids([a, b]));
      expect((await list(f)).rows.find((r) => r.conversationId === c.conversationId)).toMatchObject({ categoryKey: null, subcategoryName: null });
    });

    it("filters by date range on the latest message: today, yesterday, custom", async () => {
      const f = await fixture();
      const now = new Date();
      const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const today = await inboundThread(f, { at: now });
      const yesterday = await inboundThread(f, { at: new Date(startToday.getTime() - 6 * HOUR) });
      const old = await inboundThread(f, { at: new Date("2026-01-15T10:00:00Z") });
      expect(ids((await list(f, { dateMode: "today" })).rows)).toEqual([today.conversationId]);
      expect(ids((await list(f, { dateMode: "yesterday" })).rows)).toEqual([yesterday.conversationId]);
      const custom = await list(f, { dateMode: "custom", dateFrom: "2026-01-15", dateTo: "2026-01-15" });
      expect(ids(custom.rows)).toEqual([old.conversationId]);
      expect(ids((await list(f, { dateMode: "custom", dateFrom: "2026-01-16", dateTo: "2026-01-14" })).rows)).toEqual([old.conversationId]);
      expect((await list(f, { dateMode: "custom", dateFrom: "2026-01-16", dateTo: "2026-01-16" })).total).toBe(0);
    });

    it("reads the date filters in the organization's time zone, the zone of the list's day dividers", async () => {
      const f = await fixture();
      await sql`update organizations set timezone = 'Asia/Seoul' where id = ${f.org}`;
      const zone = "Asia/Seoul";
      // Today in Seoul began at this instant. The thread one second after it is today there; the one a minute before is yesterday.
      const startToday = startOfDayInZone(calendarDayInZone(new Date(), zone), zone);
      const today = await inboundThread(f, { at: new Date(startToday.getTime() + 1000) });
      const yesterday = await inboundThread(f, { at: new Date(startToday.getTime() - 60_000) });
      expect(ids((await list(f, { dateMode: "today" })).rows)).toEqual([today.conversationId]);
      expect(ids((await list(f, { dateMode: "yesterday" })).rows)).toEqual([yesterday.conversationId]);

      // 2026-01-14 16:30 UTC is 2026-01-15 01:30 in Seoul: a custom range for Jan 15 finds it, Jan 14 does not.
      const late = await inboundThread(f, { at: new Date("2026-01-14T16:30:00Z") });
      expect(ids((await list(f, { dateMode: "custom", dateFrom: "2026-01-15", dateTo: "2026-01-15" })).rows)).toEqual([late.conversationId]);
      expect((await list(f, { dateMode: "custom", dateFrom: "2026-01-14", dateTo: "2026-01-14" })).total).toBe(0);

      // The same thread under a UTC organization is Jan 14.
      const utc = await fixture();
      const same = await inboundThread(utc, { at: new Date("2026-01-14T16:30:00Z") });
      expect(ids((await list(utc, { dateMode: "custom", dateFrom: "2026-01-14", dateTo: "2026-01-14" })).rows)).toEqual([same.conversationId]);
      expect((await list(utc, { dateMode: "custom", dateFrom: "2026-01-15", dateTo: "2026-01-15" })).total).toBe(0);
    });

    it("combines filters with AND, and view and search still apply", async () => {
      const f = await fixture();
      const a = await inboundThread(f, { email: "ann@acme.test", name: "Ann", body: "pricing question" });
      const b = await inboundThread(f, { email: "bob@acme.test", name: "Bob", body: "pricing question" });
      await classify(a.conversationId, "demo_request");
      await classify(b.conversationId, "demo_request");
      const combined = { subcategoryKeys: ["demo_request"], mailboxIds: [f.mailboxId], query: "pricing" };
      expect((await list(f, combined)).total).toBe(2);
      expect(ids((await list(f, { ...combined, leadQuery: "bob" })).rows)).toEqual([b.conversationId]);
      expect((await list(f, { ...combined, leadQuery: "bob", categoryKeys: ["not_interested"] })).total).toBe(0);
      expect(ids((await list(f, { ...combined, view: "unread", leadIds: [a.personId] })).rows)).toEqual([a.conversationId]);
    });

    it("never returns another organization's conversations for any filter", async () => {
      const f = await fixture();
      const other = await fixture();
      const mine = await inboundThread(f, { email: "mine@acme.test" });
      const theirs = await inboundThread(other, { email: "theirs@acme.test", body: "secretword" });
      await classify(theirs.conversationId, "demo_request");
      expect((await list(f, { leadIds: [theirs.personId] })).total).toBe(0);
      expect((await list(f, { mailboxIds: [other.mailboxId] })).total).toBe(0);
      expect((await list(f, { query: "secretword" })).total).toBe(0);
      expect((await list(f, { subcategoryKeys: ["demo_request"] })).total).toBe(0);
      expect(ids((await list(f)).rows)).toEqual([mine.conversationId]);
      expect((await inbox.inboxFilterOptions(composition.inboxDeps(), f.actor, [theirs.personId])).leads).toEqual([]);
      const options = await inbox.inboxFilterOptions(composition.inboxDeps(), f.actor, [mine.personId]);
      expect(options.mailboxes.map((m) => m.id)).toEqual([f.mailboxId]);
      expect(options.leads.map((l) => l.id)).toEqual([mine.personId]);
    });
  });

  describe("views", () => {
    it("Sent shows threads whose latest message is ours; Replied shows human replies without out of office", async () => {
      const f = await fixture();
      const waiting = await inboundThread(f, { at: new Date(Date.now() - 5 * 24 * HOUR) });
      const answered = await inboundThread(f, { at: new Date(Date.now() - 6 * 24 * HOUR) });
      await addMessage(answered.conversationId, { direction: "outbound", body: "Thanks, here you go", at: new Date(Date.now() - 4 * 24 * HOUR), from: f.mailbox });
      const ooo = await inboundThread(f, { at: new Date(Date.now() - 2 * 24 * HOUR) });
      await classify(ooo.conversationId, "out_of_office");
      expect(ids((await list(f, { view: "sent" })).rows)).toEqual([answered.conversationId]);
      expect(ids((await list(f, { view: "replied" })).rows)).toEqual([waiting.conversationId]);
      expect(ids((await list(f, { view: "ooo" })).rows)).toEqual([ooo.conversationId]);
      // All keeps all three.
      expect((await list(f)).total).toBe(3);
    });

    it("a new inbound after our reply moves the thread back to Replied", async () => {
      const f = await fixture();
      const t = await inboundThread(f, { at: new Date(Date.now() - 6 * 24 * HOUR) });
      await addMessage(t.conversationId, { direction: "outbound", body: "ours", at: new Date(Date.now() - 5 * 24 * HOUR) });
      expect((await list(f, { view: "replied" })).total).toBe(0);
      await addMessage(t.conversationId, { direction: "inbound", body: "theirs again", at: new Date(Date.now() - 4 * 24 * HOUR) });
      expect(ids((await list(f, { view: "replied" })).rows)).toEqual([t.conversationId]);
      expect((await list(f, { view: "sent" })).total).toBe(0);
    });

    it("Automated collects header-flagged, no-reply, DMARC and delivery-failure mail; All hides them but counts them", async () => {
      const f = await fixture();
      const human = await inboundThread(f, { email: "human@acme.test" });
      const flagged = await inboundThread(f, { autoReply: true, subject: "Automatic reply: away" });
      const bounce = await inboundThread(f, { autoReply: true, possibleBounce: true, subject: "Delivery Status Notification (Failure)" });
      const noReply = await inboundThread(f, { email: "noreply@service.test", subject: "Your invoice" });
      const dmarc = await inboundThread(f, { email: "reports@mail.test", subject: "Report domain: acme.test Submitter: google.com DMARC aggregate" });
      const lookalike = await inboundThread(f, { email: "noreplyton@acme.test", subject: "Reply about the report" });
      const automated = [flagged, bounce, noReply, dmarc];

      const all = await list(f);
      expect(ids(all.rows)).toEqual(ids([human, lookalike]));
      expect(all.automatedHidden).toBe(4);
      const view = await list(f, { view: "automated" });
      expect(ids(view.rows)).toEqual(ids(automated));
      expect(view.rows.every((r) => r.automated)).toBe(true);
      expect(view.automatedHidden).toBe(0);
      expect(ids((await list(f, { view: "replied" })).rows)).toEqual(ids([human, lookalike]));
      // A search reaches into machine mail too.
      expect(ids((await list(f, { query: "invoice" })).rows)).toEqual([noReply.conversationId]);
    });

    it("unread counts leave out machine mail but keep an unverified bounce notice", async () => {
      const f = await fixture();
      await inboundThread(f, { email: "human@acme.test" });
      await inboundThread(f, { autoReply: true });
      await inboundThread(f, { email: "no-reply@service.test", subject: "Receipt" });
      await inboundThread(f, { email: "mailer-daemon@mail.test", subject: "Undelivered", possibleBounce: true });
      const nav = await unreadStore.drizzleUnreadStore.counts(f.org);
      // The human message and the unverified bounce count; the auto-reply and the no-reply receipt do not.
      expect(nav.total).toBe(2);
      const unreadView = await list(f, { view: "unread" });
      expect(unreadView.total).toBe(2);
      expect(unreadView.rows.map((r) => r.personEmail).sort()).toEqual(["human@acme.test", "mailer-daemon@mail.test"]);
    });
  });

  describe("search", () => {
    it("finds a word from message 1 of 4, in subject, body, names and email", async () => {
      const f = await fixture();
      const t = await inboundThread(f, { email: "carol@acme.test", name: "Carol Quimby", subject: "Zephyrword subject", body: "Opening mentions gadolinium", at: new Date(Date.now() - 9 * 24 * HOUR) });
      for (let i = 1; i <= 3; i++) {
        await addMessage(t.conversationId, { direction: i % 2 ? "outbound" : "inbound", body: `later message ${i}`, subject: "Re: later", at: new Date(Date.now() - (9 - i) * 24 * HOUR) });
      }
      for (const term of ["gadolinium", "zephyrword", "quimby", "CAROL@", "Carol"]) {
        expect(ids((await list(f, { query: term })).rows), term).toEqual([t.conversationId]);
      }
      expect((await list(f, { query: "nonexistentterm" })).total).toBe(0);
    });

    it("keeps LIKE escaping for percent, underscore and backslash", async () => {
      const f = await fixture();
      const literal = await inboundThread(f, { body: "discount of 50% on a_c plans, path C:\\temp" });
      const decoy = await inboundThread(f, { body: "discount of 500 on abc plans, path C:xtemp" });
      expect(ids((await list(f, { query: "50%" })).rows)).toEqual([literal.conversationId]);
      expect(ids((await list(f, { query: "a_c" })).rows)).toEqual([literal.conversationId]);
      expect(ids((await list(f, { query: "C:\\t" })).rows)).toEqual([literal.conversationId]);
      expect((await list(f, { query: "%" })).total).toBe(1);
      expect(decoy.conversationId).not.toBe(literal.conversationId);
    });
  });

  describe("scheduled view", () => {
    async function campaignWith(f: Fixture, name: string, status = "active") {
      const steps = [
        { stepNumber: 1, kind: "email", subject: "Intro", body: "hello", waitDays: 0 },
        { stepNumber: 2, kind: "email", subject: "Follow up", body: "again", waitDays: 3 },
      ];
      const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'email', ${name}, ${status}, ${sql.json(steps)}) returning id`;
      return id as string;
    }
    async function person(f: Fixture, email: string, name: string) {
      const [{ id }] = await sql`insert into people (organization_id, email, full_name) values (${f.org}, ${email}, ${name}) returning id`;
      return id as string;
    }
    async function enroll(f: Fixture, campaign: string, personId: string, status: string, dueIn: number | null, step = 1) {
      const [{ id }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, mailbox_id, next_send_at)
        values (${f.org}, ${campaign}, ${personId}, 'email', ${status}, ${step}, ${f.mailboxId}, ${dueIn === null ? null : new Date(Date.now() + dueIn * HOUR)}) returning id`;
      return id as string;
    }

    it("lists next campaign steps of active enrollments by next send time and excludes paused or stopped work", async () => {
      const f = await fixture();
      const other = await fixture();
      const campaign = await campaignWith(f, "Autumn");
      const paused = await campaignWith(f, "Paused one", "paused");
      const later = await enroll(f, campaign, await person(f, "late@acme.test", "Late Lee"), "active", 48);
      const sooner = await enroll(f, campaign, await person(f, "soon@acme.test", "Soon Sam"), "active", 2);
      await enroll(f, campaign, await person(f, "replied@acme.test", "Replied Rae"), "replied", 5);
      await enroll(f, campaign, await person(f, "cancelled@acme.test", "Cancelled Cy"), "cancelled", 6);
      await enroll(f, campaign, await person(f, "pending@acme.test", "No Time Ned"), "active", null);
      await enroll(f, campaign, await person(f, "done@acme.test", "Done Dee"), "active", 7, 2); // no step 3
      await enroll(f, paused, await person(f, "pausedcamp@acme.test", "Paused Pat"), "active", 1);
      const foreignCampaign = await campaignWith(other, "Theirs");
      await enroll(other, foreignCampaign, await person(other, "x@acme.test", "Foreign Fay"), "active", 1);

      const result = await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, {});
      expect(result.total).toBe(2);
      expect(result.rows.map((r) => r.id)).toEqual([sooner, later]);
      expect(result.rows[0]).toMatchObject({ kind: "campaign", personName: "Soon Sam", sourceName: "Autumn", subject: "Follow up", stepLabel: "Step 2 (email)", mailbox: f.mailbox });
      expect(result.rows[0].dueAt.getTime()).toBeLessThan(result.rows[1].dueAt.getTime());
    });

    it("includes queued CRM follow-up steps of active runs only and honors lead, campaign, mailbox and date filters", async () => {
      const f = await fixture();
      const nurture = await campaignWith(f, "Nurture");
      const [seq] = await sql`insert into sequences (organization_id, name, campaign_id) values (${f.org}, 'Nurture (after a reply)', ${nurture}) returning id`;
      // The step goes in while the version is a draft: sequence_steps_frozen_trg (0016) refuses it under a published one.
      const [ver] = await sql`insert into sequence_versions (organization_id, sequence_id, version) values (${f.org}, ${seq.id}, 1) returning id`;
      const [step] = await sql`
        insert into sequence_steps (organization_id, sequence_version_id, position, step_type, name, delay_minutes, ai_instructions)
        values (${f.org}, ${ver.id}, 2, 'follow_up', 'Check in', 60, 'Say hi') returning id`;
      await sql`update sequence_versions set status = 'published', published_at = now() where id = ${ver.id}`;

      async function run(email: string, status: string, stepStatus: string, dueIn: number) {
        const t = await inboundThread(f, { email, name: email.split("@")[0] });
        await classify(t.conversationId, "demo_request");
        const [rec] = await sql`select r.id, r.subcategory_id, c.id as conv from records r join conversations c on c.record_id = r.id where c.id = ${t.conversationId}`;
        const [msg] = await sql`select id from messages where conversation_id = ${t.conversationId} limit 1`;
        const [r] = await sql`
          insert into sequence_runs (organization_id, record_id, conversation_id, sequence_id, sequence_version_id, subcategory_id, status, started_by, trigger_message_id, last_inbound_at_start)
          values (${f.org}, ${rec.id}, ${t.conversationId}, ${seq.id}, ${ver.id}, ${rec.subcategory_id}, ${status}, 'ai_assignment', ${msg.id}, now()) returning id`;
        const [sr] = await sql`
          insert into sequence_step_runs (organization_id, sequence_run_id, sequence_step_id, status, due_at, expected_context_version)
          values (${f.org}, ${r.id}, ${step.id}, ${stepStatus}, ${new Date(Date.now() + dueIn * HOUR)}, 1) returning id`;
        return { id: sr.id as string, personId: t.personId };
      }
      const active = await run("active@acme.test", "active", "scheduled", 3);
      await run("paused@acme.test", "paused", "scheduled", 1);
      await run("cancelled@acme.test", "cancelled", "cancelled", 1);
      await run("sentstep@acme.test", "active", "sent", 1).catch(() => undefined);

      const campaign = await campaignWith(f, "Autumn");
      const camp = await enroll(f, campaign, await person(f, "camp@acme.test", "Camp Cat"), "active", 1);

      const all = await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, {});
      expect(all.rows.map((r) => r.id)).toEqual([camp, active.id]);
      expect(all.rows[1]).toMatchObject({ kind: "sequence", sourceName: "Nurture", stepLabel: "Check in", mailbox: f.mailbox });

      const byLead = await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, { leadIds: [active.personId] });
      expect(byLead.rows.map((r) => r.id)).toEqual([active.id]);
      const byCampaign = await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, { campaignIds: [campaign] });
      expect(byCampaign.rows.map((r) => r.id)).toEqual([camp]);
      // The campaign filter reaches the follow-ups the campaign owns.
      const byOwner = await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, { campaignIds: [nurture] });
      expect(byOwner.rows.map((r) => r.id)).toEqual([active.id]);
      // A paused campaign holds its follow-ups, so they are not scheduled to go out.
      await sql`update campaigns set status = 'paused' where id = ${nurture}`;
      expect((await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, {})).rows.map((r) => r.id)).toEqual([camp]);
      await sql`update campaigns set status = 'active' where id = ${nurture}`;
      const byMailbox = await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, { mailboxIds: [f.mailboxId] });
      expect(byMailbox.total).toBe(2);
      expect((await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, { dateMode: "custom", dateFrom: "2020-01-01", dateTo: "2020-01-02" })).total).toBe(0);
    });

    it("keeps the steps of a legacy standalone sequence (no campaign) listed while its run is active", async () => {
      const f = await fixture();
      // Migration 0022 archived legacy sequences. Their runs in flight keep going, so their steps stay scheduled.
      const [seq] = await sql`insert into sequences (organization_id, name, status) values (${f.org}, 'Legacy nurture', 'archived') returning id`;
      const [ver] = await sql`insert into sequence_versions (organization_id, sequence_id, version) values (${f.org}, ${seq.id}, 1) returning id`;
      const [step] = await sql`
        insert into sequence_steps (organization_id, sequence_version_id, position, step_type, name, delay_minutes, ai_instructions)
        values (${f.org}, ${ver.id}, 2, 'follow_up', 'Legacy check in', 60, 'Say hi') returning id`;
      await sql`update sequence_versions set status = 'published', published_at = now() where id = ${ver.id}`;
      const t = await inboundThread(f, { email: "legacy@acme.test", name: "Legacy Lou" });
      await classify(t.conversationId, "demo_request");
      const [rec] = await sql`select r.id, r.subcategory_id from records r join conversations c on c.record_id = r.id where c.id = ${t.conversationId}`;
      const [msg] = await sql`select id from messages where conversation_id = ${t.conversationId} limit 1`;
      const [run] = await sql`
        insert into sequence_runs (organization_id, record_id, conversation_id, sequence_id, sequence_version_id, subcategory_id, status, started_by, trigger_message_id, last_inbound_at_start)
        values (${f.org}, ${rec.id}, ${t.conversationId}, ${seq.id}, ${ver.id}, ${rec.subcategory_id}, 'active', 'ai_assignment', ${msg.id}, now()) returning id`;
      const [sr] = await sql`
        insert into sequence_step_runs (organization_id, sequence_run_id, sequence_step_id, status, due_at, expected_context_version)
        values (${f.org}, ${run.id}, ${step.id}, 'scheduled', ${new Date(Date.now() + 2 * HOUR)}, 1) returning id`;

      const result = await inbox.listScheduledInbox(composition.inboxDeps(), f.actor, {});
      expect(result.rows.map((r) => r.id)).toEqual([sr.id]);
      expect(result.rows[0]).toMatchObject({ kind: "sequence", sourceName: "Legacy nurture", stepLabel: "Legacy check in" });
      expect(result.total).toBe(1);
    });
  });
});

