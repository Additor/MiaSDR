import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import { createCampaign, FLOW_STEPS, recordSentEmail } from "../../after-reply/infrastructure/after-reply-test-kit";
import type { Actor } from "@/shared/errors";
import type { Job } from "@/platform/jobs/types";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";
import { replyAiResolverOf } from "@/contexts/conversations/ai/application/ai-ports";

/**
 * The callee-owned functions the lead-to-contact conversion calls (person-handling.ts), and the start-time check that
 * keeps a contact from getting a run. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("person handling for the lead-to-contact conversion", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 8 });
  let composition: typeof import("../composition");
  let aiJobsApp: typeof import("../../ai/application/ai-jobs");
  let arApp: typeof import("../../after-reply/application/after-reply");
  let seqApp: typeof import("../../after-reply/application/follow-ups");
  let seqJobsApp: typeof import("../../after-reply/application/follow-up-jobs");
  let handling: typeof import("../person-handling");
  let appDb: typeof import("@/platform/db/client").db;
  let stores: {
    jobs: typeof import("../../ai/infrastructure/drizzle-ai-job-store").drizzleAiJobStore;
    replies: typeof import("../drizzle-reply-store").drizzleReplyStore;
    flows: typeof import("../../after-reply/infrastructure/drizzle-follow-up-store").drizzleAfterReplyStore;
    runs: typeof import("../../after-reply/infrastructure/drizzle-follow-up-store").drizzleRunStore;
    engine: typeof import("../../after-reply/infrastructure/drizzle-follow-up-engine").drizzleFollowUpEngine;
  };
  let FakeAi: typeof import("../../ai/infrastructure/fake-reply-ai").FakeReplyAi;
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture() {
    const created = await createTestOrg(sql, "Person", "member");
    orgs.push(created);
    const { organizationId: org, userId: user, slug: tag } = created;
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const ai = new FakeAi();
    const clock = () => new Date();
    const resolver = replyAiResolverOf(async (o: string) => (o === org ? ai : null));
    const [aiTick] = aiJobsApp.createAiJobs({ jobs: stores.jobs, ai: resolver, now: clock, workerId: "ai", leaseMs: aiJobsApp.AI_JOB_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const [seqTick] = seqJobsApp.createFollowUpJobs({ engine: stores.engine, runs: stores.runs, replies: stores.replies, ai: resolver, now: clock, workerId: "w1", leaseMs: seqJobsApp.FOLLOW_UP_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const ctx = () => ({ deadline: Date.now() + 60_000, now: clock });
    return {
      org,
      user,
      actor,
      address,
      tag,
      clock,
      arDeps: { flows: stores.flows, now: clock },
      aiRun: () => aiTick.run(ctx()),
      cycle: async () => {
        await aiTick.run(ctx());
        return seqTick.run(ctx());
      },
    };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const mail = (f: Fx, partial: Partial<InboundEmailInput> = {}): InboundEmailInput => {
    const n = ++counter;
    return {
      organizationId: f.org,
      accountRef: f.address,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@lead.test>`,
      inReplyTo: null,
      from: { email: `lead${n}-${f.tag}@acme.test`, name: "Lena Lead" },
      to: [f.address],
      subject: "Re: hello",
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date(f.clock().getTime() - 1000),
      autoReply: false,
      ...partial,
    };
  };

  const one = async (query: string, params: unknown[]) => (await sql.unsafe(query, params as never[]))[0];
  const count = async (table: string, org: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1 and ${where}`, [org]))[0].n);

  /** A person's first email: the unknown sender becomes a lead with a record and a conversation. Returns the ids. */
  async function ingest(f: Fx, partial: Partial<InboundEmailInput> = {}) {
    const input = mail(f, partial);
    await composition.ingestInbound(input);
    const person = await one("select id from people where organization_id = $1 and lower(email) = $2", [f.org, input.from.email.toLowerCase()]);
    const conversation = await one("select id from conversations where person_id = $1", [person.id]);
    return { input, personId: person.id as string, conversationId: conversation.id as string };
  }

  /** A campaign that emailed the person an hour earlier and drafts follow-ups. */
  async function emailedBy(f: Fx, personId: string) {
    const campaignId = await createCampaign(sql, { organizationId: f.org });
    await recordSentEmail(sql, { organizationId: f.org, campaignId, personId, sentAt: new Date(f.clock().getTime() - 3_600_000) });
    await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: FLOW_STEPS });
    return campaignId;
  }

  /**
   * The conversion's first step, as another connection runs it: conversations, then the lifecycle change. Resolves once it holds
   * both, and keeps them until `release`.
   */
  async function convertAndHold(personId: string) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const done = sql.begin(async (tx) => {
      await tx`select id from conversations where person_id = ${personId} order by id for update`;
      await tx`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;
      locked();
      await held;
    });
    await Promise.race([lockTaken, done]);
    return { release, done };
  }

  beforeAll(async () => {
    composition = await import("../composition");
    aiJobsApp = await import("../../ai/application/ai-jobs");
    arApp = await import("../../after-reply/application/after-reply");
    seqApp = await import("../../after-reply/application/follow-ups");
    seqJobsApp = await import("../../after-reply/application/follow-up-jobs");
    handling = await import("../person-handling");
    appDb = (await import("@/platform/db/client")).db;
    const seqStore = await import("../../after-reply/infrastructure/drizzle-follow-up-store");
    stores = {
      jobs: (await import("../../ai/infrastructure/drizzle-ai-job-store")).drizzleAiJobStore,
      replies: (await import("../drizzle-reply-store")).drizzleReplyStore,
      flows: seqStore.drizzleAfterReplyStore,
      runs: seqStore.drizzleRunStore,
      engine: (await import("../../after-reply/infrastructure/drizzle-follow-up-engine")).drizzleFollowUpEngine,
    };
    FakeAi = (await import("../../ai/infrastructure/fake-reply-ai")).FakeReplyAi;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("a conversion that commits while a run starts", () => {
    /** A lead with a classified reply and an owner campaign with Follow-ups after a reply on, and no run yet. */
    async function readyToStart() {
      const f = await fixture();
      const lead = await ingest(f);
      await emailedBy(f, lead.personId);
      await f.aiRun();
      return { f, ...lead };
    }

    it("a conversion that commits between the facts read and the run write leaves no run", async () => {
      const { f, personId, conversationId } = await readyToStart();
      const runs = {
        ...stores.runs,
        // The facts say the person is a lead; the conversion commits on another connection before the run is written.
        loadStart: async (...args: Parameters<typeof stores.runs.loadStart>) => {
          const facts = await stores.runs.loadStart(...args);
          expect(facts?.contact).toBe(false);
          await sql.begin(async (tx) => {
            await tx`select id from conversations where person_id = ${personId} order by id for update`;
            await tx`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;
          });
          return facts;
        },
      };
      await expect(seqApp.attemptRun({ runs, now: f.clock }, { organizationId: f.org, conversationId, source: "ai_assignment" })).rejects.toMatchObject({ details: { code: "contact" } });
      expect(await count("follow_up_runs", f.org)).toBe(0);
    });

    it("a run start that waits for the record lock sees the conversion that holds it", async () => {
      const { f, personId, conversationId } = await readyToStart();
      const conversion = await convertAndHold(personId);
      // The conversion has not committed, so the facts still read a lead and the start waits at the conversation lock.
      const start = seqApp.attemptRun({ runs: stores.runs, now: f.clock }, { organizationId: f.org, conversationId, source: "ai_assignment" }).then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await waitForLockWaiters(sql, 1);
      } finally {
        conversion.release();
      }
      await conversion.done;
      expect(await start).toMatchObject({ details: { code: "contact" } });
      expect(await count("follow_up_runs", f.org)).toBe(0);
    });

    it("a lead still gets its run", async () => {
      const { f, conversationId } = await readyToStart();
      const outcome = await seqApp.attemptRun({ runs: stores.runs, now: f.clock }, { organizationId: f.org, conversationId, source: "ai_assignment" });
      expect(outcome).toHaveProperty("started");
      expect(await count("follow_up_runs", f.org, "status = 'active'")).toBe(1);
    });
  });

  describe("interruptPersonRuns", () => {
    const draft = async (f: Fx, run: { id: string; conversation_id: string; thread_id: string }, status: string, linkedToRun: boolean) =>
      (
        await one(
          `insert into drafts (organization_id, conversation_id, thread_id, expected_context_version, channel, status, request)
           values ($1, $2, $3, 0, 'email', $4, $5::text::jsonb) returning id`,
          [f.org, run.conversation_id, run.thread_id, status, JSON.stringify(linkedToRun ? { followUpRunId: run.id } : {})],
        )
      ).id as string;

    /** Two leads of one organization, each with a run and its reply draft. */
    async function twoRuns() {
      const f = await fixture();
      const a = await ingest(f);
      const b = await ingest(f);
      await emailedBy(f, a.personId);
      await emailedBy(f, b.personId);
      await f.cycle();
      const runOf = async (conversationId: string) => (await one("select id, conversation_id, thread_id, status from follow_up_runs where conversation_id = $1", [conversationId])) as unknown as { id: string; conversation_id: string; thread_id: string; status: string };
      return { f, a, b, runA: await runOf(a.conversationId), runB: await runOf(b.conversationId) };
    }

    it("counts exactly the drafts it retires, and previews the same numbers before", async () => {
      const { f, a, b, runA, runB } = await twoRuns();
      expect(runA.status).toBe("active");
      // Beyond the linked reply draft: one unlinked draft of the run (retired), one failed draft of the run (retired),
      // one sending (kept), one sent (kept) and an Inbox reply draft the run does not own (kept).
      const orphan = await draft(f, runA, "awaiting_review", true);
      const failed = await draft(f, runA, "failed", true);
      const sending = await draft(f, runA, "sending", true);
      const sent = await draft(f, runA, "sent", true);
      const inbox = await draft(f, runA, "awaiting_review", false);
      const stranger = await person(f);

      const preview = await handling.previewPersonRunStop(f.org, [a.personId, b.personId, stranger]);
      expect(preview.get(a.personId)).toEqual({ runs: 1, drafts: 3 });
      expect(preview.get(b.personId)).toEqual({ runs: 1, drafts: 1 });
      expect(preview.get(stranger)).toEqual({ runs: 0, drafts: 0 });
      expect(await count("follow_up_runs", f.org, "status = 'active'")).toBe(2);

      const now = new Date();
      const stopped = await appDb.transaction(async (tx) => {
        await handling.lockPersonConversations(tx, f.org, a.personId);
        return handling.interruptPersonRuns(tx, { organizationId: f.org, personId: a.personId, reason: "converted", now });
      });
      expect(stopped).toEqual({ runs: 1, drafts: 3 });
      expect(stopped.drafts).toBe(await count("drafts", f.org, "status = 'stale' and error = 'The follow-up sequence ended.'"));

      const status = async (id: string) => (await one("select status from drafts where id = $1", [id])).status as string;
      expect([await status(orphan), await status(failed)]).toEqual(["stale", "stale"]);
      expect([await status(sending), await status(sent), await status(inbox)]).toEqual(["sending", "sent", "awaiting_review"]);
      expect(await one("select status from follow_up_runs where id = $1", [runA.id])).toMatchObject({ status: "interrupted" });
      expect(await count("events", f.org, `event_type = 'sequence.interrupted' and meta->>'reason' = 'converted' and conversation_id = '${a.conversationId}'`)).toBe(1);

      // The other person's run and draft are untouched, and a second call finds nothing.
      expect(await one("select status from follow_up_runs where id = $1", [runB.id])).toMatchObject({ status: "active" });
      expect(await count("drafts", f.org, `conversation_id = '${b.conversationId}' and status = 'awaiting_review'`)).toBe(1);
      expect(await appDb.transaction((tx) => handling.interruptPersonRuns(tx, { organizationId: f.org, personId: a.personId, reason: "converted", now }))).toEqual({ runs: 0, drafts: 0 });
      expect((await handling.previewPersonRunStop(f.org, [a.personId])).get(a.personId)).toEqual({ runs: 0, drafts: 0 });
    });

    it("counts a paused run and ignores another organization's person", async () => {
      const { f, b, runB } = await twoRuns();
      await sql`update follow_up_runs set status = 'paused' where id = ${runB.id}`;
      expect((await handling.previewPersonRunStop(f.org, [b.personId])).get(b.personId)).toEqual({ runs: 1, drafts: 1 });
      const other = await fixture();
      expect((await handling.previewPersonRunStop(other.org, [b.personId])).get(b.personId)).toEqual({ runs: 0, drafts: 0 });
      const stopped = await appDb.transaction((tx) => handling.interruptPersonRuns(tx, { organizationId: other.org, personId: b.personId, reason: "converted", now: new Date() }));
      expect(stopped).toEqual({ runs: 0, drafts: 0 });
      expect(await one("select status from follow_up_runs where id = $1", [runB.id])).toMatchObject({ status: "paused" });
    });

    it("rolls the run and the drafts back with the caller's transaction", async () => {
      const { f, a, runA } = await twoRuns();
      await expect(
        appDb.transaction(async (tx) => {
          await handling.lockPersonConversations(tx, f.org, a.personId);
          expect(await handling.interruptPersonRuns(tx, { organizationId: f.org, personId: a.personId, reason: "converted", now: new Date() })).toEqual({ runs: 1, drafts: 1 });
          throw new Error("a later conversion step failed");
        }),
      ).rejects.toThrow("a later conversion step failed");
      expect(await one("select status from follow_up_runs where id = $1", [runA.id])).toMatchObject({ status: "active" });
      expect(await count("drafts", f.org, `conversation_id = '${a.conversationId}' and status = 'awaiting_review'`)).toBe(1);
    });
  });

  /** A person without a conversation. */
  async function person(f: Fx) {
    const n = ++counter;
    return (await one("insert into people (organization_id, email, full_name) values ($1, $2, 'Plain Person') returning id", [f.org, `plain${n}-${f.tag}@acme.test`])).id as string;
  }

  describe("lockPersonConversations", () => {
    it("holds the person's records and the person's outreach lock until the transaction ends", async () => {
      const f = await fixture();
      const { personId, conversationId } = await ingest(f);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = appDb.transaction(async (tx) => {
        await handling.lockPersonConversations(tx, f.org, personId);
        locked();
        await held;
      });
      await Promise.race([lockTaken, holder]);
      const probe = await sql.begin(async (tx) => {
        const row = await tx`select pg_try_advisory_xact_lock(hashtextextended(${`person-outreach:${f.org}:${personId}`}, 0)) as got`;
        const rec = await tx`select id from conversations where id = ${conversationId} for update skip locked`;
        return { advisory: row[0].got as boolean, conversation: rec.length === 1 };
      });
      expect(probe).toEqual({ advisory: false, conversation: false });
      release();
      await holder;
      const after = await sql.begin(async (tx) => (await tx`select pg_try_advisory_xact_lock(hashtextextended(${`person-outreach:${f.org}:${personId}`}, 0)) as got`)[0].got as boolean);
      expect(after).toBe(true);
    });

    it("takes no record lock for a person without a record", async () => {
      const f = await fixture();
      const personId = await person(f);
      await expect(appDb.transaction((tx) => handling.lockPersonConversations(tx, f.org, personId))).resolves.toBeUndefined();
    });
  });

  describe("appendPersonEvent and listPersonEvents", () => {
    it("writes an event with and without a record, and lists newest first", async () => {
      const f = await fixture();
      const { personId, conversationId } = await ingest(f);
      await appDb.transaction(async (tx) => {
        await handling.appendPersonEvent(tx, { organizationId: f.org, personId, eventType: "lifecycle.converted", actorType: "human", actorUserId: f.user, fromData: { lifecycle: "lead" }, toData: { lifecycle: "contact" }, meta: { dealId: "d1" } });
        await handling.appendPersonEvent(tx, { organizationId: f.org, personId, conversationId, eventType: "test.on_conversation", actorType: "system" });
      });
      const row = await one("select conversation_id, actor_type, actor_user_id, from_data, to_data, meta from events where person_id = $1 and event_type = 'lifecycle.converted'", [personId]);
      expect(row).toMatchObject({ conversation_id: null, actor_type: "human", actor_user_id: f.user, from_data: { lifecycle: "lead" }, to_data: { lifecycle: "contact" }, meta: { dealId: "d1" } });

      const listed = await handling.listPersonEvents(f.org, personId, 50);
      const types = listed.map((e) => e.eventType);
      expect(types).toContain("lifecycle.converted");
      expect(types).toContain("test.on_conversation");
      expect(listed[0].createdAt).toBeInstanceOf(Date);
      expect(listed.map((e) => e.createdAt.getTime())).toEqual([...listed.map((e) => e.createdAt.getTime())].sort((x, y) => y - x));
      expect(listed.find((e) => e.eventType === "lifecycle.converted")).toMatchObject({ conversationId: null, actorType: "human", meta: { dealId: "d1" }, fromData: { lifecycle: "lead" }, toData: { lifecycle: "contact" } });
      expect(await handling.listPersonEvents(f.org, personId, 1)).toHaveLength(1);
    });

    it("rolls back with the caller's transaction and refuses a human event without a user", async () => {
      const f = await fixture();
      const { personId } = await ingest(f);
      await expect(
        appDb.transaction(async (tx) => {
          await handling.appendPersonEvent(tx, { organizationId: f.org, personId, eventType: "test.rolled_back", actorType: "system" });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await count("events", f.org, "event_type = 'test.rolled_back'")).toBe(0);
      await expect(appDb.transaction((tx) => handling.appendPersonEvent(tx, { organizationId: f.org, personId, eventType: "test.human", actorType: "human" }))).rejects.toMatchObject({ cause: { constraint_name: "events_human_user_ck" } });
    });
  });

  describe("activeThreadOfPerson", () => {
    const addThread = async (f: Fx, conversationId: string, channel: "email" | "linkedin" | "whatsapp", over: { updatedAt?: Date } = {}) => {
      const n = ++counter;
      return (
        await one(
          "insert into threads (organization_id, conversation_id, channel, account_ref, provider_thread_id, updated_at) values ($1, $2, $3, $4, $5, $6) returning id",
          [f.org, conversationId, channel, `acct-${channel}-${f.tag}`, `thr-${n}`, over.updatedAt ?? new Date()],
        )
      ).id as string;
    };

    it("returns the only conversation with its channel", async () => {
      const f = await fixture();
      const { personId } = await ingest(f);
      const thread = await one("select c.id from threads c join conversations r on r.id = c.conversation_id where r.person_id = $1", [personId]);
      expect(await handling.activeThreadOfPerson(f.org, personId)).toEqual({ threadId: thread.id, channel: "email" });
    });

    it("prefers the active channel of the record, then the latest update", async () => {
      const f = await fixture();
      const { personId, conversationId } = await ingest(f);
      const email = (await one("select id from threads where conversation_id = $1", [conversationId])).id as string;
      // The email thread is the older one, so only the active channel can put it first.
      await sql`update threads set updated_at = now() - interval '2 days' where id = ${email}`;
      const linkedin = await addThread(f, conversationId, "linkedin");
      const pick = async () => (await handling.activeThreadOfPerson(f.org, personId))?.threadId;

      await sql`update conversations set active_channel = 'linkedin' where id = ${conversationId}`;
      expect(await pick()).toBe(linkedin);
      await sql`update conversations set active_channel = 'email' where id = ${conversationId}`;
      expect(await pick()).toBe(email);
      await sql`update conversations set active_channel = null where id = ${conversationId}`;
      expect(await pick()).toBe(linkedin);
      // Two conversations of one channel: the later update wins.
      const newerEmail = await addThread(f, conversationId, "email", { updatedAt: new Date(Date.now() + 60_000) });
      await sql`update conversations set active_channel = 'email' where id = ${conversationId}`;
      expect(await pick()).toBe(newerEmail);
    });

    it("returns nothing for a person without a record and another organization", async () => {
      const f = await fixture();
      const { personId } = await ingest(f);
      expect(await handling.activeThreadOfPerson(f.org, await person(f))).toBeNull();
      const other = await fixture();
      expect(await handling.activeThreadOfPerson(other.org, personId)).toBeNull();
    });
  });
});
