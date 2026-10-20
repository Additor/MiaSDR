import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { InboundStore, SyncMailbox } from "../../application/inbound-ports";
import type { InboundEmail } from "../../application/ports";
import type { LinkedInInboundStore } from "../../linkedin/application/linkedin-ports";
import type { LinkedInInboundEvent } from "../../linkedin/domain/linkedin";

const STEPS = [{ stepNumber: 1, kind: "email", subject: "Hi", body: "Hello", waitDays: 0 }];
const now = new Date("2026-10-15T10:00:00Z");

describeDb("a genuine reply stops all outreach to the person", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let email: InboundStore;
  let linkedin: LinkedInInboundStore;
  const cleanup: string[] = [];
  let seq = 0;

  async function org(tag: string) {
    const [{ id }] = await sql`insert into organizations (name, slug) values ('R', ${`rs-${tag}-${uniqueKey()}`}) returning id`;
    cleanup.push(id);
    return id as string;
  }

  /** One organization: a mailbox and a LinkedIn account, an email campaign (two of them for lead A) and a LinkedIn campaign. */
  async function fixture() {
    const o = await org("a");
    const tag = uniqueKey();
    const address = `sender-${tag}@corp.test`;
    const [{ id: mailbox }] = await sql`insert into mailboxes (organization_id, email_address, display_name, status) values (${o}, ${address}, 'S', 'connected') returning id`;
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status) values (${o}, ${"acct-" + tag}, ${"ACo-owner-" + tag}, ${"owner-" + tag}, 'connected') returning id`;
    const campaign = async (channel: string, name: string) =>
      (await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${o}, ${channel}, ${name}, 'active', ${sql.json(STEPS as never)}) returning id`)[0].id as string;
    const emailCampaign1 = await campaign("email", "e1");
    const emailCampaign2 = await campaign("email", "e2");
    const linkedinCampaign = await campaign("linkedin", "l1");
    const person = async (name: string, withLinkedin = true) =>
      (await sql`insert into people (organization_id, email, first_name, linkedin_slug) values (${o}, ${`${name}-${tag}@acme.test`}, ${name}, ${withLinkedin ? `${name}-${tag}` : null}) returning id`)[0].id as string;
    const enroll = async (campaignId: string, personId: string, channel: string, status = "active") => {
      const [{ id }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, next_send_at, linkedin_account_id)
        values (${o}, ${campaignId}, ${personId}, ${channel}, ${status}, ${new Date(now.getTime() + 86_400_000)}, ${channel === "linkedin" ? account : null}) returning id`;
      if (channel === "linkedin") {
        const [{ slug }] = await sql`select linkedin_slug as slug from people where id = ${personId}`;
        await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, profile_url, connection_state) values (${id}, ${o}, ${"ACo-" + slug}, ${"https://www.linkedin.com/in/" + slug}, 'connected')`;
      }
      return id as string;
    };
    const a = await person("alice");
    const b = await person("bob");
    const aEmail1 = await enroll(emailCampaign1, a, "email");
    const aEmail2 = await enroll(emailCampaign2, a, "email", "pending");
    const aLinkedin = await enroll(linkedinCampaign, a, "linkedin");
    const bEmail = await enroll(emailCampaign1, b, "email");
    const bLinkedin = await enroll(linkedinCampaign, b, "linkedin");
    const mb: SyncMailbox = { id: mailbox, organizationId: o, emailAddress: address, cursor: null };
    const emails = { a: `alice-${tag}@acme.test`, b: `bob-${tag}@acme.test` };
    return { o, tag, mb, account, providerAccount: "acct-" + tag, a, b, aEmail1, aEmail2, aLinkedin, bEmail, bLinkedin, emails };
  }
  type F = Awaited<ReturnType<typeof fixture>>;

  const status = async (id: string) => (await sql`select status, stop_reason, next_send_at from campaign_enrollments where id = ${id}`)[0];
  const stopEvents = async (o: string) => await sql`select person_id, meta from events where organization_id = ${o} and event_type = 'outreach.stopped_by_reply'`;

  /** Mail with no thread headers: nothing ties it to a send, only the sender address. */
  function mail(from: string, over: Partial<InboundEmail> = {}): InboundEmail {
    seq += 1;
    return {
      providerMessageId: `m-${seq}-${uniqueKey()}`,
      threadId: `t-${seq}-${uniqueKey()}`,
      rfcMessageId: null,
      inReplyTo: null,
      references: [],
      from: { email: from, name: null },
      to: [],
      cc: [],
      subject: "Re: hello",
      bodyText: "Yes please",
      receivedAt: now,
      headers: {},
      sendId: null,
      ...over,
    };
  }

  function liReply(f: F, slug: string, messageId = `lm-${++seq}-${uniqueKey()}`): LinkedInInboundEvent {
    return {
      type: "message_received",
      account: f.providerAccount,
      chat: `chat-${slug}`,
      messageId,
      text: "Sounds good",
      fromAccountOwner: false,
      counterparty: `ACo-${slug}`,
      counterpartyName: slug,
      counterpartyProfileUrl: `https://www.linkedin.com/in/${slug}`,
      sentAt: now.toISOString(),
    } as LinkedInInboundEvent;
  }

  beforeAll(async () => {
    email = (await import("../../email/infrastructure/drizzle-inbound-store")).createDrizzleInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    linkedin = (await import("../../linkedin/infrastructure/drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("an email reply stops the person's LinkedIn enrollment and a second email campaign, and no one else", async () => {
    const f = await fixture();
    // No thread headers, so no enrollment matches by send. The sender address alone identifies the lead.
    expect(await email.applyInbound(f.mb, mail(f.emails.a), { kind: "message" }, now)).toBe("reply");
    for (const id of [f.aEmail1, f.aEmail2, f.aLinkedin]) expect(await status(id)).toMatchObject({ status: "replied", stop_reason: "replied", next_send_at: null });
    for (const id of [f.bEmail, f.bLinkedin]) expect(await status(id)).toMatchObject({ status: "active", stop_reason: null });
    const events = await stopEvents(f.o);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ person_id: f.a, meta: { replyChannel: "email", channels: expect.arrayContaining(["email", "linkedin"]) } });
    expect((events[0].meta as { enrollmentIds: string[] }).enrollmentIds.sort()).toEqual([f.aEmail1, f.aEmail2, f.aLinkedin].sort());
  });

  it("a LinkedIn reply stops the person's email enrollments", async () => {
    const f = await fixture();
    const result = await linkedin.apply(f.o, liReply(f, `alice-${f.tag}`), now);
    expect(result.result).toBe("done");
    for (const id of [f.aEmail1, f.aEmail2, f.aLinkedin]) expect(await status(id)).toMatchObject({ status: "replied", stop_reason: "replied", next_send_at: null });
    for (const id of [f.bEmail, f.bLinkedin]) expect(await status(id)).toMatchObject({ status: "active" });
    expect(await stopEvents(f.o)).toHaveLength(1);
  });

  it("a reply on either channel leaves finished enrollments completed and stops only active work", async () => {
    for (const channel of ["email", "linkedin"] as const) {
      const f = await fixture();
      const [{ id: doneCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.o}, 'email', 'done', 'active', ${sql.json(STEPS as never)}) returning id`;
      const [{ id: bouncedCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.o}, 'email', 'bounced', 'active', ${sql.json(STEPS as never)}) returning id`;
      const finished = async (campaignId: string, status: string, stopReason: string | null) =>
        (await sql`
          insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, stop_reason, next_send_at)
          values (${f.o}, ${campaignId}, ${f.a}, 'email', ${status}, ${stopReason}, null) returning id`)[0].id as string;
      const completed = await finished(doneCampaign, "completed", null);
      const bounced = await finished(bouncedCampaign, "bounced", "bounced");
      const [{ id: liCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.o}, 'linkedin', 'li-done', 'active', ${sql.json(STEPS as never)}) returning id`;
      const [{ id: liCompleted }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, linkedin_account_id) values (${f.o}, ${liCampaign}, ${f.a}, 'linkedin', 'completed', ${f.account}) returning id`;
      await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, profile_url, connection_state) values (${liCompleted}, ${f.o}, ${"ACo-alice-" + f.tag}, ${"https://www.linkedin.com/in/alice-" + f.tag}, 'connected')`;

      if (channel === "email") await email.applyInbound(f.mb, mail(f.emails.a), { kind: "message" }, now);
      else await linkedin.apply(f.o, liReply(f, `alice-${f.tag}`), now);

      for (const id of [f.aEmail1, f.aEmail2, f.aLinkedin]) expect(await status(id)).toMatchObject({ status: "replied", stop_reason: "replied" });
      expect(await status(completed)).toMatchObject({ status: "completed", stop_reason: null });
      expect(await status(liCompleted)).toMatchObject({ status: "completed", stop_reason: null });
      expect(await status(bounced)).toMatchObject({ status: "bounced", stop_reason: "bounced" });
      const events = await stopEvents(f.o);
      expect(events).toHaveLength(1);
      expect((events[0].meta as { enrollmentIds: string[] }).enrollmentIds).not.toContain(completed);
      expect((events[0].meta as { enrollmentIds: string[] }).enrollmentIds).not.toContain(liCompleted);
    }
  });

  it("leaves another organization's person with the same address alone", async () => {
    const f = await fixture();
    const other = await org("b");
    const [{ id: otherPerson }] = await sql`insert into people (organization_id, email) values (${other}, ${f.emails.a}) returning id`;
    const [{ id: otherCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${other}, 'email', 'x', 'active', ${sql.json(STEPS as never)}) returning id`;
    const [{ id: otherEnrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${other}, ${otherCampaign}, ${otherPerson}, 'email', 'active') returning id`;
    await email.applyInbound(f.mb, mail(f.emails.a), { kind: "message" }, now);
    expect(await status(f.aEmail1)).toMatchObject({ status: "replied" });
    expect(await status(otherEnrollment)).toMatchObject({ status: "active" });
  });

  it("an auto-reply does not stop anything", async () => {
    const f = await fixture();
    expect(await email.applyInbound(f.mb, mail(f.emails.a, { headers: { "auto-submitted": "auto-replied" } }), { kind: "auto_reply" }, now)).toBe("auto_reply");
    for (const id of [f.aEmail1, f.aEmail2, f.aLinkedin]) expect(await status(id)).toMatchObject({ status: expect.stringMatching(/active|pending/) });
    expect(await stopEvents(f.o)).toHaveLength(0);
  });

  it("an unverified bounce does not stop anything", async () => {
    const f = await fixture();
    const bounce = mail("mailer-daemon@spoofed.test", { subject: "Delivery Status Notification (Failure)", headers: { "x-failed-recipients": f.emails.a } });
    expect(await email.applyInbound(f.mb, bounce, { kind: "hard_bounce", failedRecipient: f.emails.a } as never, now)).toBe("unverified_bounce");
    for (const id of [f.aEmail1, f.aEmail2, f.aLinkedin]) expect(await status(id)).toMatchObject({ status: expect.stringMatching(/active|pending/) });
  });

  it("a replayed email and a replayed LinkedIn message stop nothing more and write no second event", async () => {
    const f = await fixture();
    const m = mail(f.emails.a);
    await email.applyInbound(f.mb, m, { kind: "message" }, now);
    const snapshot = await status(f.aEmail1);
    await email.applyInbound(f.mb, m, { kind: "message" }, new Date(now.getTime() + 60_000));
    expect(await status(f.aEmail1)).toEqual(snapshot);
    expect(await stopEvents(f.o)).toHaveLength(1);

    const g = await fixture();
    const ev = liReply(g, `bob-${g.tag}`, "same-message");
    await linkedin.apply(g.o, ev, now);
    await linkedin.apply(g.o, ev, new Date(now.getTime() + 60_000));
    expect(await stopEvents(g.o)).toHaveLength(1);
    expect(await status(g.aEmail1)).toMatchObject({ status: "active" });
    expect(await status(g.bEmail)).toMatchObject({ status: "replied" });
  });
});
