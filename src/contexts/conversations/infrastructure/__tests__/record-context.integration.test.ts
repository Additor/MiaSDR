import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("a context version bump retires the picks held for a check", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];
  let composition: typeof import("../composition");
  let store: typeof import("../drizzle-reply-handling-store").drizzleReplyHandlingStore;
  let counter = 0;

  async function fixture() {
    const created = await createTestOrg(sql, "Context", "member");
    orgs.push(created);
    return { org: created.organizationId, user: created.userId, tag: created.slug, mailbox: `me-${created.slug}@corp.test` };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const mail = (f: Fx, partial: Partial<InboundEmailInput> = {}): InboundEmailInput => {
    const n = ++counter;
    return {
      organizationId: f.org,
      accountRef: f.mailbox,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@lead.test>`,
      inReplyTo: null,
      from: { email: `lead-${f.tag}@acme.test`, name: "Lena Lead" },
      to: [f.mailbox],
      subject: "Re: hello",
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
      ...partial,
    };
  };

  async function lead(f: Fx, partial: Partial<InboundEmailInput> = {}) {
    const ingested = await composition.ingestInbound(mail(f, partial));
    const [record] = await sql`select id from records where person_id = ${ingested.personId}`;
    return { ...ingested, recordId: record.id as string };
  }

  /** The AI's pick of the record's latest reply, or of `messageId`, held for a check at the record's current version. */
  async function holdPick(f: Fx, recordId: string, options: { messageId?: string; stopAsked?: boolean } = {}) {
    const [record] = await sql`select latest_inbound_message_id as latest, context_version as version from records where id = ${recordId}`;
    const [type] = await sql`select id, group_key from reply_types where organization_id = ${f.org} and system_role is null and active order by created_at limit 1`;
    const [pick] = await sql`
      insert into reply_type_picks (organization_id, record_id, message_id, expected_context_version, proposed_group_key, proposed_reply_type_id, confidence, status, provider, response)
      values (${f.org}, ${recordId}, ${options.messageId ?? record.latest}, ${record.version}, ${type.group_key}, ${type.id}, 0.5, 'proposed', 'fake', ${sql.json({ stopRequested: options.stopAsked === true })})
      returning id`;
    return pick.id as string;
  }

  const pickStatus = async (id: string) => (await sql`select status from reply_type_picks where id = ${id}`)[0].status as string;
  const version = async (recordId: string) => (await sql`select context_version as v from records where id = ${recordId}`)[0].v as number;
  const inTx = async <T>(work: (tx: import("@/platform/db/client").DbTx) => Promise<T>) => (await import("@/platform/db/client")).db.transaction(work);

  beforeAll(async () => {
    composition = await import("../composition");
    store = (await import("../drizzle-reply-handling-store")).drizzleReplyHandlingStore;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  const PATHS: Array<{ path: string; run: (f: Fx, l: { recordId: string; personId: string; conversationId: string; messageId: string }) => Promise<void> }> = [
    {
      path: "a person's type change",
      run: async (f, l) => {
        const { restartRecordWorkTx } = await import("../restart-record-work");
        await inTx((tx) => restartRecordWorkTx(tx, { organizationId: f.org, recordId: l.recordId, reason: "stage_moved", draftReason: "moved", followUps: "stop", now: new Date(), actorUserId: f.user }));
      },
    },
    {
      path: "undoing the latest pick",
      run: async (f, l) => {
        const [type] = await sql`select id, group_key from reply_types where organization_id = ${f.org} and system_role is null and active order by created_at limit 1`;
        const next = await composition.ingestInbound(mail(f, { bodyText: "One more thing.", receivedAt: new Date("2026-10-14T11:00:00Z") }));
        const [{ v }] = await sql`select context_version as v from records where id = ${l.recordId}`;
        await sql`update reply_type_picks set status = 'proposed' where record_id = ${l.recordId} and message_id = ${l.messageId}`;
        const [applied] = await sql`
          insert into reply_type_picks (organization_id, record_id, message_id, expected_context_version, proposed_group_key, proposed_reply_type_id, applied_group_key, applied_reply_type_id, confidence, status, provider)
          values (${f.org}, ${l.recordId}, ${next.messageId as string}, ${v}, ${type.group_key}, ${type.id}, ${type.group_key}, ${type.id}, 0.9, 'auto_applied', 'fake') returning id`;
        await sql`update records set group_key = ${type.group_key}, reply_type_id = ${type.id}, reply_type_source = 'ai' where id = ${l.recordId}`;
        await store.undoReplyTypePick({ organizationId: f.org, actorUserId: f.user, replyTypePickId: applied.id as string, now: new Date() });
      },
    },
    {
      path: "marking the person do not contact",
      run: (f, l) => store.setDoNotContact({ organizationId: f.org, actorUserId: f.user, personId: l.personId, enabled: true, reason: "asked", now: new Date() }).then(() => undefined),
    },
    {
      path: "closing the record",
      run: (f, l) => store.closeRecord({ organizationId: f.org, actorUserId: f.user, recordId: l.recordId, reason: "done", now: new Date() }),
    },
    {
      path: "reopening the record",
      run: (f, l) => store.reopenRecord({ organizationId: f.org, actorUserId: f.user, recordId: l.recordId, now: new Date() }),
    },
    {
      path: "a newer email",
      run: async (f) => {
        await composition.ingestInbound(mail(f, { bodyText: "Any update?", receivedAt: new Date("2026-10-14T12:00:00Z") }));
      },
    },
    {
      path: "a newer LinkedIn message",
      run: async (f, l) => {
        const [account] = await sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, username, status) values (${f.org}, ${`acc-${f.tag}`}, ${`ACo-${f.tag}`}, 'Seller', ${`seller-${f.tag}`}, 'connected') returning id`;
        await composition.ingestInboundLinkedInMessage({
          organizationId: f.org,
          accountRef: account.id as string,
          accountName: "Seller",
          providerThreadId: `chat-${f.tag}`,
          providerMessageId: `li-${f.tag}`,
          counterparty: { providerId: `ACo-lead-${f.tag}`, name: "Lena Lead", profileUrl: `https://www.linkedin.com/in/lead-${f.tag}`, slug: `lead-${f.tag}` },
          personId: l.personId,
          bodyText: "Saw your message.",
          receivedAt: new Date("2026-10-14T12:00:00Z"),
        });
      },
    },
    {
      path: "the thread with the latest reply turning private",
      run: async (f, l) => {
        const second = await composition.ingestInbound(mail(f, { bodyText: "From my other thread.", receivedAt: new Date("2026-10-14T11:00:00Z") }));
        await sql`update reply_type_picks set status = 'proposed' where record_id = ${l.recordId} and message_id = ${l.messageId}`;
        const { detachPrivateThreadTx } = await import("../private-thread-detach");
        await inTx((tx) => detachPrivateThreadTx(tx, { organizationId: f.org, conversationId: second.conversationId as string, recordId: l.recordId, now: new Date() }));
      },
    },
  ];

  it.each(PATHS)("$path retires the pick, so nothing counts it as waiting", async ({ path, run }) => {
    const f = await fixture();
    const l = await lead(f);
    if (path === "reopening the record") await store.closeRecord({ organizationId: f.org, actorUserId: f.user, recordId: l.recordId, reason: "done", now: new Date() });
    const before = await version(l.recordId);
    const pick = await holdPick(f, l.recordId);
    await run(f, { recordId: l.recordId, personId: l.personId as string, conversationId: l.conversationId as string, messageId: l.messageId as string });
    expect(await version(l.recordId)).toBeGreaterThan(before);
    expect(await pickStatus(pick)).toBe("stale");
  });

  it("an automatic reply changes no version and leaves the pick waiting", async () => {
    const f = await fixture();
    const l = await lead(f);
    const before = await version(l.recordId);
    const pick = await holdPick(f, l.recordId);
    await composition.ingestInbound(mail(f, { bodyText: "Out of office.", autoReply: true, receivedAt: new Date("2026-10-14T12:00:00Z") }));
    expect(await version(l.recordId)).toBe(before);
    expect(await pickStatus(pick)).toBe("proposed");
  });

  describe("a held pick of the latest reply that asks to stop", () => {
    const stopPick = async (f: Fx, recordId: string) => holdPick(f, recordId, { stopAsked: true });

    it("stays through a close and a reopen, so an agent stays refused until a person reviews it", async () => {
      const f = await fixture();
      const l = await lead(f);
      const pick = await stopPick(f, l.recordId);
      await store.closeRecord({ organizationId: f.org, actorUserId: f.user, recordId: l.recordId, reason: "done", now: new Date() });
      await store.reopenRecord({ organizationId: f.org, actorUserId: f.user, recordId: l.recordId, now: new Date() });
      expect(await pickStatus(pick)).toBe("proposed");
    });

    it("stays when an older message arrives late, since the reply stays the latest", async () => {
      const f = await fixture();
      const l = await lead(f);
      const pick = await stopPick(f, l.recordId);
      await composition.ingestInbound(mail(f, { bodyText: "Sent earlier.", receivedAt: new Date("2026-10-14T09:00:00Z") }));
      expect(await pickStatus(pick)).toBe("proposed");
    });

    it("retires when a newer reply replaces it", async () => {
      const f = await fixture();
      const l = await lead(f);
      const pick = await stopPick(f, l.recordId);
      await composition.ingestInbound(mail(f, { bodyText: "Actually, let's talk.", receivedAt: new Date("2026-10-14T12:00:00Z") }));
      expect(await pickStatus(pick)).toBe("stale");
    });

    it("retires when a person changes the type", async () => {
      const f = await fixture();
      const l = await lead(f);
      const pick = await stopPick(f, l.recordId);
      const { restartRecordWorkTx } = await import("../restart-record-work");
      await inTx((tx) => restartRecordWorkTx(tx, { organizationId: f.org, recordId: l.recordId, reason: "stage_moved", draftReason: "moved", followUps: "stop", now: new Date(), actorUserId: f.user }));
      expect(await pickStatus(pick)).toBe("stale");
    });
  });
});
