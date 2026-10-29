import { afterAll, beforeAll, expect, it } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import type { FakeMailboxProvider } from "@/contexts/outreach/email/infrastructure/fake-mailbox-provider";
import { ConflictError, ValidationError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { replyAiResolverOf } from "@/contexts/conversations/ai/application/ai-ports";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("CC on a reply", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let composition: typeof import("../composition");
  let mgmt: typeof import("../../application/reply-management");
  let store: typeof import("../drizzle-reply-store").drizzleReplyStore;
  let createReplyMailer: typeof import("../reply-mailer").createReplyMailer;
  let mailbox: FakeMailboxProvider;
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture(cc: string[] = ["boss@acme.test", "peer@acme.test"]) {
    const created = await createTestOrg(sql, "CC", "member");
    orgs.push(created);
    const { organizationId: org, userId: user, slug: tag } = created;
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const deps = {
      store,
      ai: replyAiResolverOf(async () => null),
      mailer: createReplyMailer(() => mailbox),
      now: () => new Date(),
      newToken: () => `tok-${Math.random().toString(36).slice(2)}`,
    };
    const n = ++counter;
    const lead = `lead${n}-${tag}@acme.test`;
    const input: InboundEmailInput = {
      organizationId: org,
      accountRef: address,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@lead.test>`,
      inReplyTo: null,
      from: { email: lead, name: "Lena Lead" },
      to: [address],
      cc,
      subject: "Re: hello",
      bodyText: "Looping in my team",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
    };
    const ingested = await composition.ingestInbound(input);
    const [record] = await sql`select id, context_version from records where organization_id = ${org}`;
    const { id: draftId } = (await store.insertDraft({
      organizationId: org,
      recordId: record.id,
      conversationId: ingested.conversationId,
      replyForMessageId: ingested.messageId,
      expectedContextVersion: record.context_version,
      subject: "Re: hello",
      bodyText: "Happy to help.",
      provider: "fake",
      model: "fake",
      request: {},
      response: {},
      citations: [],
    })) as { id: string };
    return { org, actor, deps, address, lead, draftId, conversationId: ingested.conversationId, personId: ingested.personId };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const draftCc = async (f: Fx) => (await sql`select cc, revision from drafts where id = ${f.draftId}`)[0];
  const sendKey = () => `key-${Math.random().toString(36).slice(2)}`;
  const delivered = (f: Fx) => mailbox.delivered.filter((m) => m.mailbox.emailAddress === f.address);

  beforeAll(async () => {
    composition = await import("../composition");
    mgmt = await import("../../application/reply-management");
    store = (await import("../drizzle-reply-store")).drizzleReplyStore;
    createReplyMailer = (await import("../reply-mailer")).createReplyMailer;
    mailbox = (await import("@/contexts/outreach/infrastructure/composition")).mailboxProvider() as FakeMailboxProvider;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("offers the remembered CCs on the panel, unchecked by default", async () => {
    const f = await fixture();
    const panel = await mgmt.getReplyPanel(f.deps, f.actor, f.conversationId);
    expect(panel!.knownCcs.map((k) => k.email).sort()).toEqual(["boss@acme.test", "peer@acme.test"]);
    expect(panel!.draft!.cc).toEqual([]);
  });

  it("hides and refuses any mailbox of the organization, even one stored before the rule existed", async () => {
    const f = await fixture();
    await sql`insert into mailboxes (organization_id, email_address, status) values (${f.org}, 'Spare-Box@corp.test', 'disabled')`;
    await sql`insert into lead_ccs (organization_id, person_id, email) values (${f.org}, ${f.personId}, 'spare-box@corp.test')`;
    const panel = await mgmt.getReplyPanel(f.deps, f.actor, f.conversationId);
    expect(panel!.knownCcs.map((k) => k.email).sort()).toEqual(["boss@acme.test", "peer@acme.test"]);
    await expect(mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: 1, bodyText: "x", cc: ["spare-box@corp.test"] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("hides the lead's own address even when another person row shares it in a different case", async () => {
    const f = await fixture();
    await sql`insert into lead_ccs (organization_id, person_id, email) values (${f.org}, ${f.personId}, ${f.lead})`;
    const panel = await mgmt.getReplyPanel(f.deps, f.actor, f.conversationId);
    expect(panel!.knownCcs.map((k) => k.email)).not.toContain(f.lead);
  });

  it("sends with no CC header unless a person picked one", async () => {
    const f = await fixture();
    const result = await mgmt.approveAndSendDraft(f.deps, f.actor, f.draftId, { revision: 1, idempotencyKey: sendKey() });
    expect(result.status).toBe("sent");
    const [mail] = delivered(f);
    expect(mail.to).toBe(f.lead);
    expect(mail.cc ?? []).toEqual([]);
  });

  it("sends once with the chosen CC and stores it on the outbound message", async () => {
    const f = await fixture();
    const { revision } = await mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: 1, bodyText: "Happy to help.", cc: ["Boss@Acme.test"] });
    expect((await draftCc(f)).cc).toEqual(["boss@acme.test"]);
    const key = sendKey();
    const first = await mgmt.approveAndSendDraft(f.deps, f.actor, f.draftId, { revision, idempotencyKey: key });
    const again = await mgmt.approveAndSendDraft(f.deps, f.actor, f.draftId, { revision, idempotencyKey: key });
    expect(first).toMatchObject({ status: "sent", replayed: false });
    expect(again).toMatchObject({ status: "sent", replayed: true });
    const mails = delivered(f);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: f.lead, cc: ["boss@acme.test"] });
    const [out] = await sql`select raw, to_address from messages where organization_id = ${f.org} and direction = 'outbound'`;
    expect(out.to_address).toBe(f.lead);
    expect(out.raw.cc).toEqual(["boss@acme.test"]);
  });

  it("refuses an address that was never on the lead's mail", async () => {
    const f = await fixture();
    await expect(mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: 1, bodyText: "x", cc: ["stranger@else.test"] })).rejects.toBeInstanceOf(ValidationError);
    expect((await draftCc(f)).cc).toEqual([]);
  });

  it("refuses the lead and our own mailbox as CC", async () => {
    const f = await fixture([]);
    await sql`insert into lead_ccs (organization_id, person_id, email) values (${f.org}, ${f.personId}, ${f.lead})`;
    await expect(mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: 1, bodyText: "x", cc: [f.lead] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a suppressed CC at edit time", async () => {
    const f = await fixture();
    await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, 'boss@acme.test', 'unsubscribed')`;
    await expect(mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: 1, bodyText: "x", cc: ["boss@acme.test"] })).rejects.toBeInstanceOf(ConflictError);
    const panel = await mgmt.getReplyPanel(f.deps, f.actor, f.conversationId);
    expect(panel!.knownCcs.find((k) => k.email === "boss@acme.test")?.blocked).toBe("suppressed");
  });

  it("refuses a CC who is a do-not-contact person at edit time", async () => {
    const f = await fixture();
    const [p] = await sql`insert into people (organization_id, email) values (${f.org}, 'peer@acme.test') returning id`;
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${f.org}, ${p.id}, true, 'human', now())`;
    await expect(mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: 1, bodyText: "x", cc: ["peer@acme.test"] })).rejects.toBeInstanceOf(ConflictError);
  });

  it("blocks the send when a chosen CC was suppressed after the edit, and keeps the draft reviewable", async () => {
    const f = await fixture();
    const { revision } = await mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: 1, bodyText: "Happy to help.", cc: ["boss@acme.test"] });
    await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, 'boss@acme.test', 'unsubscribed')`;
    const result = await mgmt.approveAndSendDraft(f.deps, f.actor, f.draftId, { revision, idempotencyKey: sendKey() });
    expect(result.status).toBe("blocked");
    expect(delivered(f)).toHaveLength(0);
    const [draft] = await sql`select status from drafts where id = ${f.draftId}`;
    expect(draft.status).toBe("awaiting_review");
  });

  it("does not leak another organization's CC rows", async () => {
    const a = await fixture(["shared@acme.test"]);
    const b = await fixture([]);
    await expect(mgmt.editDraft(b.deps, b.actor, b.draftId, { revision: 1, bodyText: "x", cc: ["shared@acme.test"] })).rejects.toBeInstanceOf(ValidationError);
    expect((await mgmt.getReplyPanel(b.deps, b.actor, b.conversationId))!.knownCcs).toEqual([]);
    expect((await mgmt.getReplyPanel(a.deps, a.actor, a.conversationId))!.knownCcs).toHaveLength(1);
  });

  it("keeps the CC list when a later edit does not mention it, and clears it with an empty list", async () => {
    const f = await fixture();
    const first = await mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: 1, bodyText: "one", cc: ["boss@acme.test"] });
    const second = await mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: first.revision, bodyText: "two" });
    expect((await draftCc(f)).cc).toEqual(["boss@acme.test"]);
    await mgmt.editDraft(f.deps, f.actor, f.draftId, { revision: second.revision, bodyText: "three", cc: [] });
    expect((await draftCc(f)).cc).toEqual([]);
  });
});
