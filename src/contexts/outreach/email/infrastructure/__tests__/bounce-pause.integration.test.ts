import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import type { InboundStore, SyncMailbox } from "../../../application/inbound-ports";
import type { InboundEmail } from "../../application/ports";

const STEPS = [{ stepNumber: 1, kind: "email", subject: "Hi", body: "Hello", waitDays: 0 }];
const AUTH =
  "mx.google.com; dkim=pass header.i=@googlemail.com header.s=20230601 header.b=AbCdEf12; spf=pass (google.com: domain of mailer-daemon@googlemail.com designates 209.85.220.69 as permitted sender) smtp.mailfrom=mailer-daemon@googlemail.com; dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=googlemail.com";

describeDb("the bounce breaker", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let store: InboundStore;
  const orgs: TestOrg[] = [];
  const now = new Date();

  /** A running campaign whose `sends` leads each got step 1. The enrollments end as `status`, so a last step's stays `completed`. */
  async function fixture(leads: number, status = "completed") {
    const org = await createTestOrg(sql, "Bounce");
    orgs.push(org);
    const tag = uniqueKey();
    const address = `sender-${tag}@corp.test`;
    const [{ id: mailboxId }] = await sql`insert into mailboxes (organization_id, email_address, display_name, status) values (${org.organizationId}, ${address}, 'S', 'connected') returning id`;
    const [{ id: campaignId }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps, sends_counted_from)
      values (${org.organizationId}, 'email', 'c', 'active', ${sql.json(STEPS as never)}, ${new Date(now.getTime() - 3_600_000)}) returning id`;
    const mailbox: SyncMailbox = { id: mailboxId, organizationId: org.organizationId, emailAddress: address, cursor: null };
    const f = { org, mailbox, campaignId: campaignId as string, emails: [] as string[], enrollments: [] as string[] };
    for (let i = 0; i < leads; i++) await addSend(f, status);
    return f;
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function addSend(f: Fixture, status = "completed", claimedAt = new Date(now.getTime() - 60_000), sendStatus = "sent") {
    const email = `lead-${uniqueKey()}@acme.test`;
    const [{ id: person }] = await sql`insert into people (organization_id, email, first_name) values (${f.org.organizationId}, ${email}, 'L') returning id`;
    const [{ id: enrollment }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, mailbox_id)
      values (${f.org.organizationId}, ${f.campaignId}, ${person}, 'email', ${status}, 1, ${f.mailbox.id}) returning id`;
    await sql`
      insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, claimed_at, rfc_message_id)
      values (${f.org.organizationId}, ${enrollment}, 1, 'email', ${sendStatus}, ${f.mailbox.id}, ${claimedAt}, ${`<${uniqueKey()}@corp.test>`})`;
    f.emails.push(email);
    f.enrollments.push(enrollment);
    return { email, enrollment, person: person as string };
  }

  const notice = (failedRecipient: string): InboundEmail => ({
    providerMessageId: `m-${uniqueKey()}`,
    providerThreadId: null,
    rfcMessageId: null,
    inReplyTo: null,
    references: [],
    from: { email: "mailer-daemon@googlemail.com", name: "Mail Delivery Subsystem" },
    to: [],
    cc: [],
    subject: "Delivery Status Notification (Failure)",
    bodyText: `Your message wasn't delivered to ${failedRecipient}.`,
    receivedAt: now,
    headers: { "authentication-results": AUTH },
    sendId: null,
  });

  const bounce = (f: Fixture, email: string, at = now) => store.applyInbound(f.mailbox, notice(email), { kind: "hard_bounce", failedRecipient: email }, at);
  const campaign = async (f: Fixture) => (await sql`select * from campaigns where id = ${f.campaignId}`)[0];
  const pauseEvents = async (f: Fixture) => await sql`select * from events where organization_id = ${f.org.organizationId} and event_type = 'campaign.paused_for_bounces'`;

  beforeAll(async () => {
    const { contactStop, inboxFiling, personTimeline } = await import("@/composition/inbox-filing");
    store = (await import("../drizzle-inbound-store")).createDrizzleInboundStore(inboxFiling, contactStop, personTimeline);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("pauses at 5% with 20 sends, states the count and writes an event in the bounce's transaction", async () => {
    const f = await fixture(20);
    expect(await bounce(f, f.emails[0], now)).toBe("hard_bounce");
    const row = await campaign(f);
    expect(row).toMatchObject({ status: "paused", person_paused: true, bounce_pause: { sent: 20, bounced: 1 } });
    const [event] = await pauseEvents(f);
    expect(event).toMatchObject({ actor_type: "system", from_data: { status: "active" }, to_data: { status: "paused" }, meta: { campaignId: f.campaignId, sent: 20, bounced: 1 } });
    // The bounce itself still stopped the address.
    expect(await sql`select 1 from suppression_list where organization_id = ${f.org.organizationId} and email = ${f.emails[0]}`).toHaveLength(1);
  });

  it("stays active under 20 sends or under 5%", async () => {
    const few = await fixture(19);
    await bounce(few, few.emails[0]);
    await bounce(few, few.emails[1]);
    expect(await campaign(few)).toMatchObject({ status: "active", bounce_pause: null });

    const many = await fixture(41);
    await bounce(many, many.emails[0]);
    await bounce(many, many.emails[1]);
    expect(await campaign(many)).toMatchObject({ status: "active", bounce_pause: null });
    expect(await pauseEvents(many)).toHaveLength(0);
  });

  it("counts a replayed notice once", async () => {
    const f = await fixture(21);
    await bounce(f, f.emails[0]);
    await bounce(f, f.emails[0]);
    expect(await sql`select count(*)::int as n from sends s join campaign_enrollments e on e.id = s.enrollment_id where e.campaign_id = ${f.campaignId} and s.bounced_at is not null`).toEqual([{ n: 1 }]);
    expect(await campaign(f)).toMatchObject({ status: "active" });
  });

  it("leaves out sends before the window and failed sends, and a late bounce for an earlier send counts nothing", async () => {
    const f = await fixture(19);
    const earlier = await addSend(f, "completed", new Date(now.getTime() - 7_200_000));
    await addSend(f, "active", new Date(now.getTime() - 60_000), "failed");
    await bounce(f, earlier.email);
    const row = await campaign(f);
    expect(row.status).toBe("active");
    expect(await sql`select bounced_at from sends where enrollment_id = ${earlier.enrollment}`).toEqual([{ bounced_at: expect.any(Date) }]);
  });

  it("blocks the next send and a resume restarts the window", async () => {
    const f = await fixture(19);
    const live = await addSend(f, "active");
    await bounce(f, f.emails[0]);
    expect((await campaign(f)).status).toBe("paused");

    const { drizzleOutreachStore } = await import("../drizzle-outreach-store");
    const claim = { enrollmentId: live.enrollment, campaignId: f.campaignId, organizationId: f.org.organizationId, person: { id: live.person, email: live.email } };
    expect(await drizzleOutreachStore.checkBlockers(claim as never)).toBe("campaign_inactive");

    const { changeCampaignStatus } = await import("@/contexts/outreach/application/campaign-management");
    const { campaignDeps } = await import("@/contexts/outreach/infrastructure/composition");
    const actor = { organizationId: f.org.organizationId, userId: f.org.userId, role: "owner" as const };
    await changeCampaignStatus(campaignDeps(), actor, f.campaignId, "active");
    const resumed = await campaign(f);
    expect(resumed).toMatchObject({ status: "active", person_paused: false, bounce_pause: null });
    expect(resumed.sends_counted_from.getTime()).toBeGreaterThan(now.getTime() - 60_000);

    // The earlier sends no longer count, so a bounce on one of them cannot pause it again.
    await bounce(f, f.emails[1]);
    expect((await campaign(f)).status).toBe("active");

    // Twenty new sends and one new bounce reach the limit again.
    const after = new Date(Date.now() + 1000);
    const fresh = [];
    for (let i = 0; i < 20; i++) fresh.push(await addSend(f, "completed", after));
    await bounce(f, fresh[0].email);
    expect(await campaign(f)).toMatchObject({ status: "paused", bounce_pause: { sent: 20, bounced: 1 } });
  });
});
