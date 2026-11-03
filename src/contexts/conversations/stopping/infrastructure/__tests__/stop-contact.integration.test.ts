import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { haltOutcome } from "@/contexts/outreach/domain/enrollment-status";
import { holdLocks } from "@/test-support/deals-test-kit";
import { createTestOrg, describeDb, dropOrgs, TEST_DATABASE_URL, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { STOP_TABLE, STOP_TRIGGERS, type StopTriggerKind } from "../../domain/stop-table";

const RUN_DRAFT_ERROR = "The follow-ups ended.";

/**
 * Walks `STOP_TABLE` against real rows: each trigger ends exactly what its row says, and everything else stays. The world
 * holds three people. `reached` is the trigger's target, with a live email enrollment, a live LinkedIn enrollment, a
 * finished enrollment, a run on a LinkedIn thread and three drafts. `sender` owns the address of a reply that `reached`'s
 * thread received. `bystander` shares nothing with either.
 */
describeDb("stopContactTx walks the trigger table", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let stopContactTx: typeof import("../stop-contact").stopContactTx;
  let db: typeof import("@/platform/db/client").db;
  const orgs: TestOrg[] = [];

  beforeAll(async () => {
    stopContactTx = (await import("../stop-contact")).stopContactTx;
    db = (await import("@/platform/db/client")).db;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  const NOW = new Date("2026-11-03T10:00:00Z");

  async function world() {
    const created = await createTestOrg(sql, "Stop", "member");
    orgs.push(created);
    const { organizationId: org, userId: user, slug: tag } = created;
    const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id;
    const set = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'set', true) returning id`);
    const type = await one(sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name) values (${org}, ${set}, 'interested', 'a', 'A') returning id`);
    const steps = sql.json([{ stepNumber: 1, kind: "email", subject: "Hi", body: "Hello", waitDays: 0 }] as never);
    const emailCampaign = await one(sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'email', 'e', 'active', ${steps}) returning id`);
    const linkedinCampaign = await one(sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'linkedin', 'l', 'active', ${steps}) returning id`);
    const earlierCampaign = await one(sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'email', 'earlier', 'completed', ${steps}) returning id`);
    const account = await one(sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id) values (${org}, ${"acct-" + tag}, ${"li-" + tag}) returning id`);
    const flow = await one(sql`insert into follow_up_flows (organization_id, name, campaign_id) values (${org}, 'f', ${emailCampaign}) returning id`);
    const version = await one(sql`insert into follow_up_versions (organization_id, flow_id, version, status, published_at) values (${org}, ${flow}, 1, 'published', now()) returning id`);

    const person = async (name: string) => {
      const email = `${name}-${tag}@lead.test`;
      const id = await one(sql`insert into people (organization_id, email, first_name, linkedin_slug) values (${org}, ${email}, ${name}, ${`${name}-${tag}`}) returning id`);
      const enroll = (campaign: string, channel: string, status = "active") =>
        one(sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, next_send_at, linkedin_account_id)
                values (${org}, ${campaign}, ${id}, ${channel}, ${status}, ${status === "active" ? new Date(NOW.getTime() + 86_400_000) : null}, ${channel === "linkedin" ? account : null}) returning id`);
      const emailEnrollment = await enroll(emailCampaign, "email");
      const linkedinEnrollment = await enroll(linkedinCampaign, "linkedin");
      await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, profile_url, connection_state, resolve_next_attempt_at)
                values (${linkedinEnrollment}, ${org}, ${"ACo-" + name + tag}, ${"https://www.linkedin.com/in/" + name + tag}, 'connected', ${new Date(NOW.getTime() + 60_000)})`;
      const conversation = await one(sql`insert into conversations (organization_id, person_id, reply_type_set_id, workflow_state, next_action_at) values (${org}, ${id}, ${set}, 'waiting', ${NOW}) returning id`);
      const thread = await one(sql`insert into threads (organization_id, conversation_id, channel, account_ref) values (${org}, ${conversation}, 'linkedin', ${"acct-" + tag}) returning id`);
      const message = await one(sql`
        insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, body_text, sent_at, raw)
        values (${org}, ${thread}, 'linkedin', ${"acct-" + tag}, 'inbound', ${"m-" + name + tag}, 'Please stop contacting me', now(), ${sql.json({ stopAsked: true } as never)}) returning id`);
      await sql`update conversations set latest_inbound_message_id = ${message} where id = ${conversation}`;
      const run = await one(sql`
        insert into follow_up_runs (organization_id, conversation_id, thread_id, flow_id, follow_up_version_id, reply_type_id, started_by, trigger_message_id, last_inbound_at_start)
        values (${org}, ${conversation}, ${thread}, ${flow}, ${version}, ${type}, 'ai_assignment', ${message}, now()) returning id`);
      const draft = (status: string, request: Record<string, string>) =>
        one(sql`insert into drafts (organization_id, conversation_id, thread_id, expected_context_version, channel, status, request)
                values (${org}, ${conversation}, ${thread}, 0, 'linkedin', ${status}, ${sql.json(request as never)}) returning id`);
      return {
        id,
        email,
        emailEnrollment,
        linkedinEnrollment,
        finished: await enroll(earlierCampaign, "email", "completed"),
        conversation,
        thread,
        run,
        runDraft: await draft("awaiting_review", { followUpRunId: run }),
        reviewDraft: await draft("awaiting_review", {}),
        failedDraft: await draft("failed", {}),
      };
    };
    return { org, user, reached: await person("reached"), sender: await person("sender"), bystander: await person("bystander") };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const raise = (w: World, kind: StopTriggerKind) =>
    db.transaction((tx) => {
      const { org: organizationId, reached, user: actorUserId } = w;
      switch (kind) {
        case "reply":
          return stopContactTx(tx, { organizationId, personId: reached.id, senderEmail: w.sender.email.toUpperCase() }, { kind, channel: "email", now: NOW });
        case "bounce":
        case "unsubscribe":
        case "suppression":
          return stopContactTx(tx, { organizationId, email: reached.email }, { kind, note: "n", now: NOW });
        case "sender_suppressed":
          return stopContactTx(tx, { organizationId, email: reached.email }, { kind, conversationId: reached.conversation, personId: reached.id, threadId: reached.thread, actorUserId, note: "n", now: NOW });
        case "do_not_contact":
          return stopContactTx(tx, { organizationId, personId: reached.id }, { kind, reason: "asked", actorUserId, now: NOW });
        case "conversion":
          return stopContactTx(tx, { organizationId, personId: reached.id }, { kind, now: NOW });
      }
    });

  const enrollment = async (id: string) => (await sql`select status, stop_reason, next_send_at from campaign_enrollments where id = ${id}`)[0];
  const runState = async (id: string) => (await sql`select status from follow_up_runs where id = ${id}`)[0].status as string;
  const draftState = async (id: string) => (await sql`select status, error from drafts where id = ${id}`)[0];
  const eventCount = async (org: string, type: string) => (await sql`select count(*)::int as n from events where organization_id = ${org} and event_type = ${type}`)[0].n as number;

  describe.each([...STOP_TRIGGERS])("%s", (kind) => {
    const row = STOP_TABLE[kind];

    it("ends the enrollments, runs and drafts its row lists, for the row's reason", async () => {
      const w = await world();
      const result = await raise(w, kind);
      const outcome = haltOutcome(row.halt);
      const ended = { status: outcome.status, stop_reason: outcome.reason, next_send_at: null };
      const live = { status: "active", stop_reason: null };

      expect(await enrollment(w.reached.emailEnrollment)).toMatchObject(ended);
      expect(await enrollment(w.reached.linkedinEnrollment)).toMatchObject(row.enrollments === "email_only" ? live : ended);
      expect(await enrollment(w.reached.finished)).toMatchObject({ status: "completed", stop_reason: null });

      // Runs end on every channel: an email_only trigger still ends this run on a LinkedIn thread.
      expect(await runState(w.reached.run)).toBe("interrupted");
      const [runEvent] = await sql`select meta from events where organization_id = ${w.org} and conversation_id = ${w.reached.conversation} and event_type = 'follow_up.interrupted'`;
      expect(runEvent.meta).toEqual({ reason: row.runReason });

      expect(await draftState(w.reached.runDraft)).toMatchObject({ status: "stale", error: row.drafts === "all_open" ? row.draftError : RUN_DRAFT_ERROR });
      expect(await draftState(w.reached.reviewDraft)).toMatchObject(row.drafts === "run_drafts" ? { status: "awaiting_review", error: null } : { status: "stale", error: row.draftError });
      expect(await draftState(w.reached.failedDraft)).toMatchObject(row.drafts === "all_open" ? { status: "stale", error: row.draftError } : { status: "failed" });

      expect(result.enrollments).toBe(row.enrollments === "email_only" ? 1 : row.people === "person_and_sender" ? 4 : 2);
      expect(result.runs).toBe(row.people === "person_and_sender" ? 2 : 1);
    });

    it("reaches the sender only where its row says, and never a bystander", async () => {
      const w = await world();
      await raise(w, kind);
      const reachesSender = row.people === "person_and_sender";
      for (const id of [w.sender.emailEnrollment, w.sender.linkedinEnrollment]) expect((await enrollment(id)).status).toBe(reachesSender ? haltOutcome(row.halt).status : "active");
      expect(await runState(w.sender.run)).toBe(reachesSender ? "interrupted" : "active");
      for (const id of [w.bystander.emailEnrollment, w.bystander.linkedinEnrollment]) expect(await enrollment(id)).toMatchObject({ status: "active" });
      expect(await runState(w.bystander.run)).toBe("active");
      expect(await draftState(w.bystander.reviewDraft)).toMatchObject({ status: "awaiting_review" });
    });

    it("records the row's mark through people's writers", async () => {
      const w = await world();
      const result = await raise(w, kind);
      const listed = await sql`select reason from suppression_list where organization_id = ${w.org}`;
      expect(listed.map((r) => r.reason)).toEqual(row.suppressionReason ? [row.suppressionReason] : []);
      expect(result.added).toBe(row.suppressionReason !== null);
      const [policy] = await sql`select do_not_contact from contact_policies where person_id = ${w.reached.id}`;
      expect(policy?.do_not_contact ?? false).toBe(row.marksDoNotContact);
    });

    it("settles the conversations only where its row says", async () => {
      const w = await world();
      const result = await raise(w, kind);
      const [conversation] = await sql`select workflow_state, context_version, next_action_at from conversations where id = ${w.reached.conversation}`;
      const reviews = await sql`select 1 from stop_reviews where organization_id = ${w.org}`;
      if (row.settlesConversations) {
        expect(conversation).toMatchObject({ workflow_state: "action_required", context_version: 1, next_action_at: null });
        expect(reviews).toHaveLength(1);
        expect(result.conversations).toBe(1);
      } else {
        expect(conversation).toMatchObject({ workflow_state: "waiting", context_version: 0 });
        expect(reviews).toHaveLength(0);
        expect(result.conversations).toBe(0);
      }
    });

    it("writes the row's events and no other stop event", async () => {
      const w = await world();
      await raise(w, kind);
      const expected: Record<string, number> = { "outreach.stopped_by_reply": 0, "contact.suppressed": 0, "contact_policy.dnc_set": 0, "contact_policy.enforced": 0 };
      if (row.eventType) expected[row.eventType] = kind === "reply" ? 2 : 1;
      if (row.conversationEventType) expected[row.conversationEventType] = 1;
      for (const [type, count] of Object.entries(expected)) expect(await eventCount(w.org, type)).toBe(count);
    });

    it("clears the LinkedIn resolve retry only where its row says", async () => {
      const w = await world();
      await raise(w, kind);
      const [details] = await sql`select resolve_next_attempt_at from linkedin_enrollment_details where enrollment_id = ${w.reached.linkedinEnrollment}`;
      if (row.enrollments === "every_channel_locked") expect(details.resolve_next_attempt_at).toBeNull();
      else expect(details.resolve_next_attempt_at).not.toBeNull();
    });

    it("takes the outreach lock only where its row says", async () => {
      const w = await world();
      const key = `person-outreach:${w.org}:${w.reached.id}`;
      const holder = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      try {
        const attempt = db.transaction(async (tx) => {
          await tx.execute("set local lock_timeout = '300ms'");
          return kind === "reply"
            ? stopContactTx(tx, { organizationId: w.org, personId: w.reached.id }, { kind, channel: "email", now: NOW })
            : raiseInTx(tx, w, kind);
        });
        if (row.takesOutreachLock) await expect(attempt).rejects.toThrow();
        else await expect(attempt).resolves.toBeDefined();
      } finally {
        await holder.release();
      }
    });
  });

  const raiseInTx = (tx: Parameters<typeof stopContactTx>[0], w: World, kind: Exclude<StopTriggerKind, "reply">) => {
    const { org: organizationId, reached, user: actorUserId } = w;
    if (kind === "do_not_contact") return stopContactTx(tx, { organizationId, personId: reached.id }, { kind, reason: "asked", actorUserId, now: NOW });
    if (kind === "conversion") return stopContactTx(tx, { organizationId, personId: reached.id }, { kind, now: NOW });
    if (kind === "sender_suppressed") return stopContactTx(tx, { organizationId, email: reached.email }, { kind, conversationId: reached.conversation, personId: reached.id, threadId: reached.thread, actorUserId, note: "n", now: NOW });
    return stopContactTx(tx, { organizationId, email: reached.email }, { kind, now: NOW });
  };

  describe("the guards", () => {
    it("a reply already filed stops nothing, so a replayed batch leaves a new enrollment alone", async () => {
      const w = await world();
      const [{ id: thread }] = await sql`insert into threads (organization_id, conversation_id, channel, account_ref) values (${w.org}, ${w.reached.conversation}, 'email', 'box@corp.test') returning id`;
      await sql`insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, provider_message_id, body_text, sent_at)
                values (${w.org}, ${thread}, 'email', 'box@corp.test', 'inbound', ${"filed-" + w.org}, ${"filed"}, 'Hello', now())`;
      const stop = (unlessId: string) =>
        db.transaction((tx) => stopContactTx(tx, { organizationId: w.org, personId: w.reached.id }, { kind: "reply", channel: "email", unlessFiled: { accountRef: "box@corp.test", providerMessageId: unlessId }, now: NOW }));
      expect(await stop("filed")).toMatchObject({ enrollments: 0, runs: 0 });
      expect(await enrollment(w.reached.emailEnrollment)).toMatchObject({ status: "active" });
      expect(await stop("not-filed")).toMatchObject({ enrollments: 2, runs: 1 });
    });

    it("do not contact on a person already marked ends nothing and writes nothing", async () => {
      const w = await world();
      await raise(w, "do_not_contact");
      const again = await raise(w, "do_not_contact");
      expect(again).toMatchObject({ changed: false, enrollments: 0, runs: 0, drafts: 0, conversations: 0 });
      expect(await eventCount(w.org, "contact_policy.dnc_set")).toBe(1);
    });

    it("reads a stop request from the stored flag and a pick, not from the text again", async () => {
      const { replyAskedToStop } = await import("../stop-requested-sql");
      const w = await world();
      const [{ latest }] = await sql`select latest_inbound_message_id as latest from conversations where id = ${w.reached.conversation}`;
      expect(await replyAskedToStop(db, latest)).toBe(true);
      const [{ id: unflagged }] = await sql`
        insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        select organization_id, thread_id, channel, account_ref, direction, ${"unflagged-" + w.org}, body_text, sent_at from messages where id = ${latest} returning id`;
      expect(await replyAskedToStop(db, unflagged)).toBe(false);
      expect(await replyAskedToStop(db, null)).toBe(false);
    });

    it("refuses a target of the wrong kind", async () => {
      const w = await world();
      await expect(db.transaction((tx) => stopContactTx(tx, { organizationId: w.org, email: w.reached.email }, { kind: "conversion", now: NOW }))).rejects.toThrow("takes a person");
      await expect(db.transaction((tx) => stopContactTx(tx, { organizationId: w.org, personId: w.reached.id }, { kind: "bounce", now: NOW }))).rejects.toThrow("takes an address");
    });
  });
});
