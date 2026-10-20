import { afterAll, beforeAll, expect, it } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";


describeDb("lead CC addresses from inbound mail", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let composition: typeof import("../composition");
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture() {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "CC");
    orgs.push(created);
    const org = created.organizationId;
    return { org, mailbox: `me-${tag}@corp.test`, lead: `lead-${tag}@acme.test`, thread: `thread-${tag}` };
  }

  const mail = (f: { org: string; mailbox: string; lead: string; thread: string }, partial: Partial<InboundEmailInput> = {}): InboundEmailInput => {
    const n = ++counter;
    return {
      organizationId: f.org,
      accountRef: f.mailbox,
      providerThreadId: f.thread,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@x.test>`,
      inReplyTo: null,
      from: { email: f.lead, name: "Lead" },
      to: [f.mailbox],
      subject: "Re: hello",
      bodyText: "Looping in my colleague",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
      ...partial,
    };
  };
  const ccRows = async (org: string) => await sql`select * from lead_ccs where organization_id = ${org} order by email`;

  beforeAll(async () => {
    composition = await import("../composition");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("stores CCs lowercased and deduped, without the lead, our mailbox or the sender", async () => {
    const f = await fixture();
    const result = await composition.ingestInbound(mail(f, { cc: ["Boss@Acme.test", "boss@acme.test", f.lead.toUpperCase(), f.mailbox, "peer@acme.test", "junk"] }));
    const rows = await ccRows(f.org);
    expect(rows.map((r) => r.email)).toEqual(["boss@acme.test", "peer@acme.test"]);
    expect(rows[0]).toMatchObject({ person_id: result.personId, source_message_id: result.messageId });
  });

  it("excludes every mailbox of the organization, not only the one that received the message", async () => {
    const f = await fixture();
    await sql`insert into mailboxes (organization_id, email_address, status) values (${f.org}, 'Other-Box@corp.test', 'disabled')`;
    await composition.ingestInbound(mail(f, { cc: ["other-box@corp.test", "boss@acme.test"] }));
    expect((await ccRows(f.org)).map((r) => r.email)).toEqual(["boss@acme.test"]);
  });

  it("is idempotent: the same message twice leaves one row per address", async () => {
    const f = await fixture();
    const input = mail(f, { cc: ["boss@acme.test"] });
    await composition.ingestInbound(input);
    const again = await composition.ingestInbound(input);
    expect(again.status).toBe("duplicate");
    expect(await ccRows(f.org)).toHaveLength(1);
  });

  it("updates last_seen_at and the source message when a later message repeats the address", async () => {
    const f = await fixture();
    await composition.ingestInbound(mail(f, { cc: ["boss@acme.test"] }));
    const later = await composition.ingestInbound(mail(f, { cc: ["boss@acme.test"], receivedAt: new Date("2026-10-15T10:00:00Z") }));
    const rows = await ccRows(f.org);
    expect(rows).toHaveLength(1);
    expect(rows[0].last_seen_at.toISOString()).toBe("2026-10-15T10:00:00.000Z");
    expect(rows[0].first_seen_at.toISOString()).toBe("2026-10-14T10:00:00.000Z");
    expect(rows[0].source_message_id).toBe(later.messageId);
  });

  it("does not move last_seen_at backwards when an older message arrives late", async () => {
    const f = await fixture();
    await composition.ingestInbound(mail(f, { cc: ["boss@acme.test"], receivedAt: new Date("2026-10-15T10:00:00Z") }));
    await composition.ingestInbound(mail(f, { cc: ["boss@acme.test"], receivedAt: new Date("2026-10-13T10:00:00Z") }));
    const [row] = await ccRows(f.org);
    expect(row.last_seen_at.toISOString()).toBe("2026-10-15T10:00:00.000Z");
    expect(row.first_seen_at.toISOString()).toBe("2026-10-13T10:00:00.000Z");
  });

  it("ignores CCs on automatic replies", async () => {
    const f = await fixture();
    await composition.ingestInbound(mail(f, { cc: ["boss@acme.test"], autoReply: true }));
    expect(await ccRows(f.org)).toHaveLength(0);
  });

  it("never creates a person or enrollment for a CC address", async () => {
    const f = await fixture();
    await composition.ingestInbound(mail(f, { cc: ["boss@acme.test"] }));
    const people = await sql`select email from people where organization_id = ${f.org}`;
    expect(people.map((p) => p.email)).toEqual([f.lead]);
    expect(await sql`select 1 from campaign_enrollments where organization_id = ${f.org}`).toHaveLength(0);
  });
});
