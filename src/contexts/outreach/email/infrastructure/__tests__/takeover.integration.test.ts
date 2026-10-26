import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { EngineDeps } from "../../application/send-next-email";
import { FakeMailboxProvider } from "../fake-mailbox-provider";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "Hello {{firstName}}", waitDays: 0 },
  { stepNumber: 2, kind: "email", subject: "", body: "Following up", waitDays: 2 },
  { stepNumber: 3, kind: "email", subject: "", body: "Last note", waitDays: 2 },
];

describeDb("follow-up takeover by another mailbox", () => {
  useTestEnv();
  const sql = testSql({ max: 8 });
  let send: typeof import("../../application/send-next-email");
  let store: typeof import("../drizzle-outreach-store").drizzleOutreachStore;
  let mailboxStore: typeof import("../../../infrastructure/drizzle-management-stores").drizzleMailboxStore;
  let campaignStore: typeof import("../../../infrastructure/drizzle-management-stores").drizzleCampaignStore;
  const cleanup: string[] = [];

  const start = new Date("2026-10-14T10:00:00Z");
  let current = start;
  const advance = (minutes: number) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };
  const deps = (provider: FakeMailboxProvider): EngineDeps => ({
    store,
    provider,
    clock: { now: () => current },
    random: () => 0,
    appUrl: "https://app.test",
    unsubscribeSecret: "u".repeat(40),
  });
  const claimOptions = (mailboxId: string) => ({
    mailboxId,
    now: current,
    pickGapMinutes: () => 18,
    takeoverAfterHours: () => 24,
    defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY }),
  });

  /**
   * Mailbox 0 sends step 1 to every lead, then the clock moves to the moment step 2 is due.
   * Mailboxes 1 and 2 are healthy and idle.
   */
  async function fixture(options: { people?: number; mailboxes?: number } = {}) {
    current = start;
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('T', ${"tko-" + tag}) returning id`;
    cleanup.push(org);
    const mailboxIds: string[] = [];
    for (let i = 0; i < (options.mailboxes ?? 3); i++) {
      const [{ id }] = await sql`
        insert into mailboxes (organization_id, email_address, display_name, status, daily_send_limit, working_hours)
        values (${org}, ${`m${i}-${tag}@corp.test`}, 'Sender', 'connected', 30, ${sql.json({ timeZone: "UTC", days: ALL_DAY })})
        returning id`;
      mailboxIds.push(id);
    }
    const [{ id: campaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'email', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    const enrollmentIds: string[] = [];
    for (let i = 0; i < (options.people ?? 1); i++) {
      const [{ id: person }] = await sql`
        insert into people (organization_id, email, first_name, created_at) values (${org}, ${`lead${i}-${tag}@acme.test`}, ${"Lead" + i}, ${new Date(start.getTime() + i * 1000)}) returning id`;
      const [{ id: enrollment }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, created_at)
        values (${org}, ${campaign}, ${person}, 'email', ${new Date(start.getTime() + i * 1000)}) returning id`;
      enrollmentIds.push(enrollment);
    }
    // Mailboxes 1 and 2 are not part of step 1: pause them out of the pool while mailbox 0 sends.
    await sql`update mailboxes set status = 'disabled' where id in ${sql(mailboxIds.slice(1))}`;
    const original = new FakeMailboxProvider();
    for (let i = 0; i < enrollmentIds.length; i++) {
      expect((await send.sendNextEmail(deps(original), mailboxIds[0])).kind).toBe("sent");
      advance(18);
    }
    await sql`update mailboxes set status = 'connected', unavailable_since = null where id in ${sql(mailboxIds.slice(1))}`;
    current = new Date(start.getTime() + 2 * 24 * 60 * 60_000 + 60 * 60_000);
    return { org, campaign, mailboxIds, enrollmentIds, original };
  }

  /** Mailbox 0 went down `hoursAgo` hours before the current clock. */
  const takeDown = (mailboxId: string, hoursAgo: number, status = "disabled") =>
    sql`update mailboxes set status = ${status}, unavailable_since = ${new Date(current.getTime() - hoursAgo * 3_600_000)} where id = ${mailboxId}`;

  const enrollment = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];
  const sendRow = async (id: string, step: number) => (await sql`select * from sends where enrollment_id = ${id} and step_number = ${step}`)[0];

  beforeAll(async () => {
    send = await import("../../application/send-next-email");
    ({ drizzleOutreachStore: store } = await import("../drizzle-outreach-store"));
    ({ drizzleMailboxStore: mailboxStore, drizzleCampaignStore: campaignStore } = await import("../../../infrastructure/drizzle-management-stores"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("does not take over before the delay, and does after it, as a new thread", async () => {
    const f = await fixture();
    await takeDown(f.mailboxIds[0], 23);
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");
    expect((await enrollment(f.enrollmentIds[0])).mailbox_id).toBe(f.mailboxIds[0]);

    advance(60); // 24 hours down
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");

    const mail = provider.delivered[0];
    expect(mail.subject).toMatch(/^Re: Hi Lead0$/);
    expect(mail.threadId).toBeNull();
    expect(mail.inReplyTo).toBeNull();
    expect(mail.references).toEqual([]);
    expect(mail.mailbox.emailAddress).toMatch(/^m1-/);

    const row = await sendRow(f.enrollmentIds[0], 2);
    expect(row).toMatchObject({ status: "sent", mailbox_id: f.mailboxIds[1], taken_over_from_mailbox_id: f.mailboxIds[0] });
    expect((await sendRow(f.enrollmentIds[0], 1)).taken_over_from_mailbox_id).toBeNull();
    // Repinned after the successful send.
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ mailbox_id: f.mailboxIds[1], current_step: 2 });
  });

  it("repins only after the send succeeds", async () => {
    const f = await fixture();
    await takeDown(f.mailboxIds[0], 30, "failed");
    const claim = await store.claimNext(claimOptions(f.mailboxIds[1]));
    expect(claim).toMatchObject({ takenOverFrom: f.mailboxIds[0], stepNumber: 2 });
    expect((await enrollment(f.enrollmentIds[0])).mailbox_id).toBe(f.mailboxIds[0]);
    await store.markSent(claim!, { providerMessageId: "p-1", threadId: "t-1" }, current);
    expect((await enrollment(f.enrollmentIds[0])).mailbox_id).toBe(f.mailboxIds[1]);
  });

  it("continues on the new mailbox after a takeover without threading onto the old mailbox's mail", async () => {
    const f = await fixture();
    await takeDown(f.mailboxIds[0], 30);
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
    current = new Date(current.getTime() + 3 * 24 * 60 * 60_000);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
    // Step 3 replies to step 2 (same mailbox) only; step 1 came from the old mailbox.
    const [, step3] = provider.delivered;
    expect(step3.inReplyTo).toBe(provider.delivered[0].rfcMessageId);
    expect(step3.references).toEqual([provider.delivered[0].rfcMessageId]);
    expect(step3.threadId).not.toBeNull();
    expect((await sendRow(f.enrollmentIds[0], 3)).taken_over_from_mailbox_id).toBeNull();
  });

  it("does not trigger while the original mailbox is healthy but out of hours, throttled or at its limit", async () => {
    const f = await fixture();
    await sql`update mailboxes set working_hours = ${sql.json({ timeZone: "UTC", days: { "1": [{ start: "09:00", end: "18:00" }] } })} where id = ${f.mailboxIds[0]}`;
    current = new Date(current.getTime() + 20 * 24 * 60 * 60_000);
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");

    await sql`update mailboxes set working_hours = ${sql.json({ timeZone: "UTC", days: ALL_DAY })}, daily_send_limit = 1 where id = ${f.mailboxIds[0]}`;
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");
    expect(provider.delivered).toHaveLength(0);
  });

  it("applies the taking mailbox's own hours, daily limit and gap", async () => {
    const f = await fixture({ people: 3 });
    await takeDown(f.mailboxIds[0], 48);

    // Outside the taker's hours.
    await sql`update mailboxes set working_hours = ${sql.json({ timeZone: "UTC", days: { "1": [{ start: "09:00", end: "18:00" }] } })} where id = ${f.mailboxIds[1]}`;
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");

    // Daily limit of 1 and a gap of 18 minutes.
    await sql`update mailboxes set working_hours = ${sql.json({ timeZone: "UTC", days: ALL_DAY })}, daily_send_limit = 1 where id = ${f.mailboxIds[1]}`;
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
    advance(30);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");

    await sql`update mailboxes set daily_send_limit = 30 where id = ${f.mailboxIds[1]}`;
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle"); // gap
    advance(18);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
    expect(provider.delivered).toHaveLength(3);
  });

  it("lets only a mailbox of the campaign's sender pool take over", async () => {
    const f = await fixture();
    await sql`insert into campaign_senders (organization_id, campaign_id, mailbox_id) values (${f.org}, ${f.campaign}, ${f.mailboxIds[0]}), (${f.org}, ${f.campaign}, ${f.mailboxIds[2]})`;
    await takeDown(f.mailboxIds[0], 48);
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[2])).kind).toBe("sent");
  });

  it("reads the delay from the organization's email rules", async () => {
    const f = await fixture();
    await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'email', ${sql.json({ takeoverAfterHours: 72 })})`;
    await takeDown(f.mailboxIds[0], 48);
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");
    advance(24 * 60);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
  });

  it("two mailboxes racing for one follow-up produce one send; for two follow-ups, one each", async () => {
    const one = await fixture();
    await takeDown(one.mailboxIds[0], 48);
    const results = await Promise.all([store.claimNext(claimOptions(one.mailboxIds[1])), store.claimNext(claimOptions(one.mailboxIds[2]))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await sql`select 1 from sends where enrollment_id = ${one.enrollmentIds[0]} and step_number = 2`).toHaveLength(1);

    const two = await fixture({ people: 2 });
    await takeDown(two.mailboxIds[0], 48);
    const both = await Promise.all([store.claimNext(claimOptions(two.mailboxIds[1])), store.claimNext(claimOptions(two.mailboxIds[2]))]);
    expect(both.every(Boolean)).toBe(true);
    expect(new Set(both.map((c) => c!.enrollmentId)).size).toBe(2);
  });

  it("the original mailbox coming back wins over a takeover and no one sends twice", async () => {
    const f = await fixture();
    await takeDown(f.mailboxIds[0], 48);
    await mailboxStore.setStatus(f.org, f.mailboxIds[0], "connected", null, current);
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    expect((await sendRow(f.enrollmentIds[0], 2)).taken_over_from_mailbox_id).toBeNull();
  });

  it("treats a mailbox that no longer exists as unable, counting from when the follow-up became due", async () => {
    const f = await fixture();
    // The foreign key refuses to delete a mailbox that enrollments point at.
    await expect(sql`delete from mailboxes where id = ${f.mailboxIds[0]}`).rejects.toThrow();
    // The shape a removed mailbox would leave behind: an active enrollment with no mailbox.
    await sql`update campaign_enrollments set mailbox_id = null where id = ${f.enrollmentIds[0]}`;
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle"); // due for 1 hour
    advance(24 * 60);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
    expect(await sendRow(f.enrollmentIds[0], 2)).toMatchObject({ taken_over_from_mailbox_id: f.mailboxIds[0] });
    expect((await enrollment(f.enrollmentIds[0])).mailbox_id).toBe(f.mailboxIds[1]);
  });

  it("uses the follow-up due time when a mailbox has no recorded unavailable time", async () => {
    const f = await fixture();
    await sql`update mailboxes set status = 'failed', unavailable_since = null where id = ${f.mailboxIds[0]}`;
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("idle");
    advance(24 * 60);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
  });

  it("records when a mailbox stops being connected and counts the leads waiting on it", async () => {
    const f = await fixture({ people: 2 });
    const before = await mailboxStore.list(f.org, current);
    expect(before.find((m) => m.id === f.mailboxIds[0])?.waitingLeads).toBe(2);
    expect(await campaignStore.waitingOnUnavailableMailbox(f.org, f.campaign)).toBe(0);

    await mailboxStore.setStatus(f.org, f.mailboxIds[0], "disabled", null, null);
    const [first] = await sql`select unavailable_since from mailboxes where id = ${f.mailboxIds[0]}`;
    expect(first.unavailable_since).not.toBeNull();
    await mailboxStore.setStatus(f.org, f.mailboxIds[0], "failed", "boom", null);
    const [second] = await sql`select unavailable_since from mailboxes where id = ${f.mailboxIds[0]}`;
    expect(second.unavailable_since).toEqual(first.unavailable_since); // the clock keeps running across disabled to failed
    expect(await campaignStore.waitingOnUnavailableMailbox(f.org, f.campaign)).toBe(2);
    expect((await mailboxStore.get(f.org, f.mailboxIds[0]))?.waitingLeads).toBe(2);

    await mailboxStore.setStatus(f.org, f.mailboxIds[0], "connected", null, null);
    const [third] = await sql`select unavailable_since from mailboxes where id = ${f.mailboxIds[0]}`;
    expect(third.unavailable_since).toBeNull();
    expect(await campaignStore.waitingOnUnavailableMailbox(f.org, f.campaign)).toBe(0);
  });
});
