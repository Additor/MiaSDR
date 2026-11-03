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
    const [conversation] = await sql`select id from conversations where person_id = ${ingested.personId}`;
    return { ...ingested, conversationId: conversation.id as string };
  }

  /** The AI's pick of the conversation's latest reply, or of `messageId`, held for a check at the conversation's current version. */
  async function holdPick(f: Fx, conversationId: string, options: { messageId?: string; stopAsked?: boolean } = {}) {
    const [conversation] = await sql`select latest_inbound_message_id as latest, context_version as version from conversations where id = ${conversationId}`;
    const [type] = await sql`select id, group_key from reply_types where organization_id = ${f.org} and system_role is null order by created_at limit 1`;
    const [pick] = await sql`
      insert into reply_type_picks (organization_id, conversation_id, message_id, expected_context_version, proposed_group_key, proposed_reply_type_id, confidence, status, provider, response)
      values (${f.org}, ${conversationId}, ${options.messageId ?? conversation.latest}, ${conversation.version}, ${type.group_key}, ${type.id}, 0.5, 'proposed', 'fake', ${sql.json({ stopRequested: options.stopAsked === true })})
      returning id`;
    return pick.id as string;
  }

  const pickStatus = async (id: string) => (await sql`select status from reply_type_picks where id = ${id}`)[0].status as string;
  const version = async (conversationId: string) => (await sql`select context_version as v from conversations where id = ${conversationId}`)[0].v as number;
  const inTx = async <T>(work: (tx: import("@/platform/db/client").DbTx) => Promise<T>) => (await import("@/platform/db/client")).db.transaction(work);

  beforeAll(async () => {
    composition = await import("../composition");
    store = (await import("../drizzle-reply-handling-store")).drizzleReplyHandlingStore;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  const PATHS: Array<{ path: string; run: (f: Fx, l: { conversationId: string; personId: string; threadId: string; messageId: string }) => Promise<void> }> = [
    {
      path: "a person's type change",
      run: async (f, l) => {
        const { restartConversationWorkTx } = await import("../restart-conversation-work");
        await inTx((tx) => restartConversationWorkTx(tx, { organizationId: f.org, conversationId: l.conversationId, reason: "type_changed", draftReason: "moved", followUps: "stop", now: new Date(), actorUserId: f.user }));
      },
    },
    {
      path: "undoing the latest pick",
      run: async (f, l) => {
        const [type] = await sql`select id, group_key from reply_types where organization_id = ${f.org} and system_role is null order by created_at limit 1`;
        const next = await composition.ingestInbound(mail(f, { bodyText: "One more thing.", receivedAt: new Date("2026-10-14T11:00:00Z") }));
        const [{ v }] = await sql`select context_version as v from conversations where id = ${l.conversationId}`;
        await sql`update reply_type_picks set status = 'proposed' where conversation_id = ${l.conversationId} and message_id = ${l.messageId}`;
        const [applied] = await sql`
          insert into reply_type_picks (organization_id, conversation_id, message_id, expected_context_version, proposed_group_key, proposed_reply_type_id, applied_group_key, applied_reply_type_id, confidence, status, provider)
          values (${f.org}, ${l.conversationId}, ${next.messageId as string}, ${v}, ${type.group_key}, ${type.id}, ${type.group_key}, ${type.id}, 0.9, 'auto_applied', 'fake') returning id`;
        await sql`update conversations set group_key = ${type.group_key}, reply_type_id = ${type.id}, reply_type_source = 'ai' where id = ${l.conversationId}`;
        await store.undoReplyTypePick({ organizationId: f.org, actorUserId: f.user, replyTypePickId: applied.id as string, now: new Date() });
      },
    },
    {
      path: "marking the person do not contact",
      run: (f, l) => store.setDoNotContact({ organizationId: f.org, actorUserId: f.user, personId: l.personId, enabled: true, reason: "asked", now: new Date() }).then(() => undefined),
    },
    {
      path: "closing the record",
      run: (f, l) => store.closeConversation({ organizationId: f.org, actorUserId: f.user, conversationId: l.conversationId, reason: "done", now: new Date() }),
    },
    {
      path: "reopening the record",
      run: (f, l) => store.reopenConversation({ organizationId: f.org, actorUserId: f.user, conversationId: l.conversationId, now: new Date() }),
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
  ];

  it.each(PATHS)("$path retires the pick, so nothing counts it as waiting", async ({ path, run }) => {
    const f = await fixture();
    const l = await lead(f);
    if (path === "reopening the record") await store.closeConversation({ organizationId: f.org, actorUserId: f.user, conversationId: l.conversationId, reason: "done", now: new Date() });
    const before = await version(l.conversationId);
    const pick = await holdPick(f, l.conversationId);
    await run(f, { conversationId: l.conversationId, personId: l.personId as string, threadId: l.threadId as string, messageId: l.messageId as string });
    expect(await version(l.conversationId)).toBeGreaterThan(before);
    expect(await pickStatus(pick)).toBe("stale");
  });

  it("an automatic reply changes no version and leaves the pick waiting", async () => {
    const f = await fixture();
    const l = await lead(f);
    const before = await version(l.conversationId);
    const pick = await holdPick(f, l.conversationId);
    await composition.ingestInbound(mail(f, { bodyText: "Out of office.", autoReply: true, receivedAt: new Date("2026-10-14T12:00:00Z") }));
    expect(await version(l.conversationId)).toBe(before);
    expect(await pickStatus(pick)).toBe("proposed");
  });

  describe("a pick that asks to stop", () => {
    const stopPick = async (f: Fx, conversationId: string) => holdPick(f, conversationId, { stopAsked: true });
    /** The rule the agent send gate and Actions read. */
    const reviewOpen = async (conversationId: string, messageId?: string) => {
      const target = messageId ?? (await sql`select latest_inbound_message_id as id from conversations where id = ${conversationId}`)[0].id;
      const { stopReviewOpen } = await import("../stop-requested-sql");
      return stopReviewOpen((await import("@/platform/db/client")).db, target as string);
    };

    it("retires on a close and a reopen, and the stop request stays open", async () => {
      const f = await fixture();
      const l = await lead(f);
      const pick = await stopPick(f, l.conversationId);
      await store.closeConversation({ organizationId: f.org, actorUserId: f.user, conversationId: l.conversationId, reason: "done", now: new Date() });
      await store.reopenConversation({ organizationId: f.org, actorUserId: f.user, conversationId: l.conversationId, now: new Date() });
      expect(await pickStatus(pick)).toBe("stale");
      expect(await reviewOpen(l.conversationId)).toBe(true);
    });

    it("stays open for its reply when a newer reply arrives, since the review belongs to that reply", async () => {
      const f = await fixture();
      const l = await lead(f);
      const [{ latest }] = await sql`select latest_inbound_message_id as latest from conversations where id = ${l.conversationId}`;
      await stopPick(f, l.conversationId);
      await composition.ingestInbound(mail(f, { bodyText: "Actually, let's talk.", receivedAt: new Date("2026-10-14T12:00:00Z") }));
      expect(await reviewOpen(l.conversationId, latest as string)).toBe(true);
    });

    it("closes when a person marks the person do not contact, so clearing the mark does not ask again", async () => {
      const f = await fixture();
      const l = await lead(f);
      await stopPick(f, l.conversationId);
      await store.setDoNotContact({ organizationId: f.org, actorUserId: f.user, personId: l.personId as string, enabled: true, reason: "asked", now: new Date() });
      expect(await reviewOpen(l.conversationId)).toBe(false);
    });

    it("closes when a person reviews it and stays open when an agent's call does the same", async () => {
      const f = await fixture();
      const l = await lead(f);
      await stopPick(f, l.conversationId);
      const { personReviewedStopsTx } = await import("../stop-review");
      const review = { organizationId: f.org, conversationId: l.conversationId, actorUserId: f.user, now: new Date() };
      await inTx((tx) => personReviewedStopsTx(tx, { ...review, via: { kind: "agent", tokenId: "t", tokenName: "Bot", clientName: null } }));
      expect(await reviewOpen(l.conversationId)).toBe(true);
      await inTx((tx) => personReviewedStopsTx(tx, review));
      expect(await reviewOpen(l.conversationId)).toBe(false);
    });

    it("counts a reply's own words before any pick reads them, until a person reviews it", async () => {
      const f = await fixture();
      const l = await lead(f);
      await composition.ingestInbound(mail(f, { bodyText: "Please stop emailing me.", receivedAt: new Date("2026-10-14T12:00:00Z") }));
      expect(await reviewOpen(l.conversationId)).toBe(true);
      const { personReviewedStopsTx } = await import("../stop-review");
      await inTx((tx) => personReviewedStopsTx(tx, { organizationId: f.org, conversationId: l.conversationId, actorUserId: f.user, now: new Date() }));
      expect(await reviewOpen(l.conversationId)).toBe(false);
    });
  });
});
