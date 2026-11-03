import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import { createCampaign, recordSentEmail } from "../../after-reply/infrastructure/after-reply-test-kit";
import type { FakeMailboxProvider } from "@/contexts/outreach/email/infrastructure/fake-mailbox-provider";
import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";
import type { Job } from "@/platform/jobs/types";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { replyAiResolverOf } from "@/contexts/conversations/ai/application/ai-ports";

/** Set `fault.createRun` to make the next run write fail inside the restart transaction, after its row went in. */
const fault = vi.hoisted(() => ({ createRun: null as Error | null }));
vi.mock("../../after-reply/infrastructure/drizzle-follow-up-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../after-reply/infrastructure/drizzle-follow-up-store")>();
  return {
    ...actual,
    createRunOn: async (...args: Parameters<typeof actual.createRunOn>) => {
      const created = await actual.createRunOn(...args);
      const error = fault.createRun;
      fault.createRun = null;
      if (error) throw error;
      return created;
    },
  };
});

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("restart conversation work: type change, correction, stale drafts", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  let composition: typeof import("../composition");
  let mgmt: typeof import("../../application/reply-management");
  let aiJobsApp: typeof import("../../ai/application/ai-jobs");
  let arApp: typeof import("../../after-reply/application/after-reply");
  let followUpJobsApp: typeof import("../../after-reply/application/follow-up-jobs");
  let replyHandlingApp: typeof import("../../application/reply-handling");
  let stores: {
    jobs: typeof import("../../ai/infrastructure/drizzle-ai-job-store").drizzleAiJobStore;
    replies: typeof import("../drizzle-reply-store").drizzleReplyStore;
    flows: typeof import("../../after-reply/infrastructure/drizzle-follow-up-store").drizzleAfterReplyStore;
    runs: typeof import("../../after-reply/infrastructure/drizzle-follow-up-store").drizzleRunStore;
    engine: typeof import("../../after-reply/infrastructure/drizzle-follow-up-engine").drizzleFollowUpEngine;
    crm: typeof import("../drizzle-reply-handling-store").drizzleReplyHandlingStore;
  };
  let FakeAi: typeof import("../../ai/infrastructure/fake-reply-ai").FakeReplyAi;
  let createReplyMailer: typeof import("../reply-mailer").createReplyMailer;
  let mailbox: FakeMailboxProvider;
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture() {
    const created = await createTestOrg(sql, "Restart", "member");
    orgs.push(created);
    const { organizationId: org, userId: user, slug: tag } = created;
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const ai = new FakeAi();
    const state = { offsetMs: 0 };
    const clock = () => new Date(Date.now() + state.offsetMs);
    const resolver = replyAiResolverOf(async (o: string) => (o === org ? ai : null));
    const [aiTick] = aiJobsApp.createAiJobs({ jobs: stores.jobs, ai: resolver, now: clock, workerId: "ai", leaseMs: aiJobsApp.AI_JOB_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const [followUpTick] = followUpJobsApp.createFollowUpJobs({ engine: stores.engine, runs: stores.runs, replies: stores.replies, ai: resolver, now: clock, workerId: "w1", leaseMs: followUpJobsApp.FOLLOW_UP_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const ctx = () => ({ deadline: Date.now() + 60_000, now: clock });
    const replyDeps = { store: stores.replies, ai: resolver, mailer: createReplyMailer(() => mailbox), now: clock, newToken: () => `tok-${Math.random().toString(36).slice(2)}` };
    const followUpDeps = { runs: stores.runs, now: clock };
    const arDeps = { flows: stores.flows, now: clock };
    const replyHandlingDeps = { store: stores.crm, inbox: (await import("../drizzle-inbox-store")).drizzleInboxStore, now: clock, replay: { email: composition.ingestInbound, linkedin: composition.ingestInboundLinkedInMessage } };
    return {
      org,
      user,
      actor,
      address,
      ai,
      tag,
      state,
      clock,
      replyDeps,
      followUpDeps,
      arDeps,
      replyHandlingDeps,
      aiRun: () => aiTick.run(ctx()),
      /** One tick of both jobs, in the registry's order. */
      cycle: async () => {
        await aiTick.run(ctx());
        return followUpTick.run(ctx());
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
  const rows = async (query: string, params: unknown[]) => sql.unsafe(query, params as never[]);
  const count = async (table: string, org: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1 and ${where}`, [org]))[0].n);
  const sendKey = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  const STEPS = (label: string) => [
    { name: `${label} reply`, delayMinutes: 0, subjectTemplate: null, bodyTemplate: null, aiInstructions: `${label}: answer.`, knowledgeTags: [] },
    { name: `${label} nudge`, delayMinutes: 2 * 1440, subjectTemplate: null, bodyTemplate: null, aiInstructions: `${label}: check in.`, knowledgeTags: [] },
  ];
  const sub = async (org: string, key: string) => (await one("select id, group_key from reply_types where organization_id = $1 and key = $2 order by created_at limit 1", [org, key])) as unknown as { id: string; group_key: string };

  /**
   * One classified reply from a lead that a campaign emailed an hour earlier. The campaign drafts follow-ups ("Flow"
   * steps) unless `flow` is false. After one cycle the conversation sits in demo_request with an active run and its reply draft.
   */
  async function withRun(opts: { flow?: boolean } = {}) {
    const f = await fixture();
    const input = mail(f);
    const r = await composition.ingestInbound(input);
    const personId = (await one("select id from people where organization_id = $1", [f.org])).id as string;
    const campaignId = await createCampaign(sql, { organizationId: f.org, name: "Autumn" });
    await recordSentEmail(sql, { organizationId: f.org, campaignId, personId, sentAt: new Date(f.clock().getTime() - 3_600_000) });
    if (opts.flow !== false) await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: STEPS("Flow") });
    await f.cycle();
    const conversation = await one("select id, context_version from conversations where organization_id = $1", [f.org]);
    const flow = await one("select id from follow_up_flows where campaign_id = $1", [campaignId]).catch(() => undefined);
    return { f, r, input, campaignId, flowId: flow?.id as string | undefined, conversationId: conversation.id as string, version: Number(conversation.context_version) };
  }

  const move = async (f: Fx, conversationId: string, key: string, expectedContextVersion: number, note: string | null = null) => {
    const target = await sub(f.org, key);
    return replyHandlingApp.changeReplyType(f.replyHandlingDeps, f.actor, conversationId, { groupKey: target.group_key, replyTypeId: target.id, expectedContextVersion, note });
  };
  const versionOf = async (conversationId: string) => Number((await one("select context_version from conversations where id = $1", [conversationId])).context_version);

  beforeAll(async () => {
    composition = await import("../composition");
    mgmt = await import("../../application/reply-management");
    aiJobsApp = await import("../../ai/application/ai-jobs");
    arApp = await import("../../after-reply/application/after-reply");
    followUpJobsApp = await import("../../after-reply/application/follow-up-jobs");
    replyHandlingApp = await import("../../application/reply-handling");
    const followUpStore = await import("../../after-reply/infrastructure/drizzle-follow-up-store");
    stores = {
      jobs: (await import("../../ai/infrastructure/drizzle-ai-job-store")).drizzleAiJobStore,
      replies: (await import("../drizzle-reply-store")).drizzleReplyStore,
      flows: followUpStore.drizzleAfterReplyStore,
      runs: followUpStore.drizzleRunStore,
      engine: (await import("../../after-reply/infrastructure/drizzle-follow-up-engine")).drizzleFollowUpEngine,
      crm: (await import("../drizzle-reply-handling-store")).drizzleReplyHandlingStore,
    };
    FakeAi = (await import("../../ai/infrastructure/fake-reply-ai")).FakeReplyAi;
    createReplyMailer = (await import("../reply-mailer")).createReplyMailer;
    mailbox = (await import("@/contexts/outreach/infrastructure/composition")).mailboxProvider() as FakeMailboxProvider;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("type change", () => {
    it("ends the old run, retires its draft, bumps the version and starts a fresh run of the campaign flow in one commit", async () => {
      const { f, conversationId, version, flowId } = await withRun();
      const old = await one("select id, status from follow_up_runs where organization_id = $1", [f.org]);
      expect(old.status).toBe("active");
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);

      const result = await move(f, conversationId, "meeting_done", version, "Call went well");
      expect(result.contextVersion).toBe(version + 1);
      expect(await versionOf(conversationId)).toBe(version + 1);

      expect(await one("select status from follow_up_runs where id = $1", [old.id])).toMatchObject({ status: "interrupted" });
      expect(await count("events", f.org, "event_type = 'follow_up.interrupted' and meta->>'reason' = 'type_changed'")).toBe(1);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      expect(await one("select status, error from drafts where organization_id = $1", [f.org])).toMatchObject({ status: "stale", error: "A person changed the reply type after this draft was written." });
      expect(await count("follow_up_step_runs", f.org, `follow_up_run_id = '${old.id}' and status in ('scheduled', 'drafting', 'awaiting_review')`)).toBe(0);

      const runs = await rows("select id, flow_id, status, reply_type_id, trigger_message_id from follow_up_runs where organization_id = $1 and status = 'active'", [f.org]);
      expect(runs).toHaveLength(1);
      expect(runs[0].flow_id).toBe(flowId);
      expect(runs[0].id).not.toBe(old.id);
      expect(runs[0].reply_type_id).toBe((await sub(f.org, "meeting_done")).id);
      expect(await count("follow_up_step_runs", f.org, `follow_up_run_id = '${runs[0].id}'`)).toBe(2);
      expect(await one("select expected_context_version from follow_up_step_runs where follow_up_run_id = $1 limit 1", [runs[0].id])).toMatchObject({ expected_context_version: version + 1 });

      // The next follow-up tick drafts the new run's reply step.
      await f.cycle();
      const fresh = await one("select expected_context_version, status, request from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      expect(fresh.expected_context_version).toBe(version + 1);
      expect(f.ai.lastDraftInput?.operatorInstructions).toContain("Flow: answer.");
    });

    it("retires an AI pick held for a check, so nothing reads it as waiting after the move", async () => {
      const f = await fixture();
      await composition.ingestInbound(mail(f));
      f.ai!.classifyWith = () => ({ replyTypeKey: "demo_request", confidence: 0.5, reason: "Unsure." });
      await f.aiRun();
      const held = await one("select id, status from reply_type_picks where organization_id = $1", [f.org]);
      expect(held.status).toBe("proposed");
      const conversation = await one("select id, context_version from conversations where organization_id = $1", [f.org]);

      await move(f, conversation.id as string, "meeting_done", Number(conversation.context_version));
      expect(await one("select status from reply_type_picks where id = $1", [held.id])).toMatchObject({ status: "stale" });
    });

    it("starts no run for a contact, and still moves the reply type", async () => {
      const { f, conversationId, version } = await withRun();
      const personId = (await one("select person_id from conversations where id = $1", [conversationId])).person_id as string;
      await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;

      const result = await move(f, conversationId, "meeting_done", version, "Call went well");
      expect(result.contextVersion).toBe(version + 1);
      expect(await one("select context_version, reply_type_id from conversations where id = $1", [conversationId])).toMatchObject({ context_version: version + 1, reply_type_id: (await sub(f.org, "meeting_done")).id });
      expect(await count("follow_up_runs", f.org)).toBe(1);
      expect(await count("follow_up_runs", f.org, "status = 'active'")).toBe(0);
      expect(await count("events", f.org, "event_type = 'follow_up.started'")).toBe(1);
      expect(await count("events", f.org, "event_type = 'follow_up.interrupted' and meta->>'reason' = 'type_changed'")).toBe(1);
    });

    it("starts no run for a contact whose conversation never had one", async () => {
      const { f, conversationId, version } = await withRun({ flow: false });
      const personId = (await one("select person_id from conversations where id = $1", [conversationId])).person_id as string;
      await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;
      await move(f, conversationId, "meeting_done", version);
      expect(await versionOf(conversationId)).toBe(version + 1);
      expect(await count("follow_up_runs", f.org)).toBe(0);
    });

    it("ends the run and starts nothing when the new reply type is terminal", async () => {
      const { f, conversationId, version } = await withRun();
      await move(f, conversationId, "not_required_right_now", version);
      expect(await count("follow_up_runs", f.org, "status = 'active'")).toBe(0);
      expect(await count("follow_up_runs", f.org, "status = 'interrupted'")).toBe(1);
      expect(await count("follow_up_runs", f.org)).toBe(1);
    });

    it("ends the run and starts nothing when the campaign has Follow-ups after a reply off", async () => {
      const { f, conversationId, version, campaignId } = await withRun();
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff", confirmStopRuns: true });
      await move(f, conversationId, "meeting_done", version);
      expect(await count("follow_up_runs", f.org, "status = 'active'")).toBe(0);
      expect(await count("follow_up_runs", f.org)).toBe(1);
    });

    it("a replay with the old version answers 409 and starts nothing twice", async () => {
      const { f, conversationId, version } = await withRun();
      await move(f, conversationId, "meeting_done", version);
      const before = { runs: await count("follow_up_runs", f.org), events: await count("events", f.org, "event_type = 'reply_type.changed'"), version: await versionOf(conversationId) };
      await expect(move(f, conversationId, "meeting_done", version)).rejects.toBeInstanceOf(ConflictError);
      expect({ runs: await count("follow_up_runs", f.org), events: await count("events", f.org, "event_type = 'reply_type.changed'"), version: await versionOf(conversationId) }).toEqual(before);
    });

    it("rolls the move back when the run cannot start", async () => {
      const { f, conversationId, version } = await withRun();
      // A broken start must not leave a half-moved conversation: the new run's row goes in, then its write fails.
      const target = await sub(f.org, "meeting_done");
      fault.createRun = new Error("the run write failed");
      try {
        await expect(move(f, conversationId, "meeting_done", version)).rejects.toThrow("the run write failed");
      } finally {
        fault.createRun = null;
      }
      expect(await count("follow_up_runs", f.org)).toBe(1);
      const conversation = await one("select context_version, reply_type_id from conversations where id = $1", [conversationId]);
      expect(Number(conversation.context_version)).toBe(version);
      expect(conversation.reply_type_id).not.toBe(target.id);
      expect(await count("follow_up_runs", f.org, "status = 'active'")).toBe(1);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("does not touch another organization", async () => {
      const a = await withRun();
      const b = await withRun();
      await move(a.f, a.conversationId, "meeting_done", a.version);
      expect(await count("follow_up_runs", b.f.org, "status = 'active'")).toBe(1);
      expect(await count("drafts", b.f.org, "status = 'awaiting_review'")).toBe(1);
      expect(await versionOf(b.conversationId)).toBe(b.version);
      await expect(replyHandlingApp.changeReplyType(a.f.replyHandlingDeps, b.f.actor, a.conversationId, { groupKey: "interested", replyTypeId: null, expectedContextVersion: a.version + 1 })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("a run start reads the rules the pick stored", () => {
    /** A reply the AI picks and applies, from a lead the campaign emailed an hour earlier. The follow-up tick has not run. */
    async function picked(body: string) {
      const f = await fixture();
      const r = await composition.ingestInbound(mail(f, { bodyText: body }));
      const personId = (await one("select id from people where organization_id = $1", [f.org])).id as string;
      const campaignId = await createCampaign(sql, { organizationId: f.org, name: "Autumn" });
      await recordSentEmail(sql, { organizationId: f.org, campaignId, personId, sentAt: new Date(f.clock().getTime() - 3_600_000) });
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: STEPS("Flow") });
      await f.aiRun();
      const conversationId = (await one("select id from conversations where organization_id = $1", [f.org])).id as string;
      return { f, r, conversationId };
    }

    it("starts no run when a type set to stop follow-ups is edited to keep going after the pick", async () => {
      const { f, conversationId } = await picked("Not now, thanks.");
      expect(await one("select status, rules from reply_type_picks where organization_id = $1", [f.org])).toMatchObject({ status: "auto_applied", rules: { followUps: "stop" } });
      await sql`update reply_types set follow_ups = 'continue' where organization_id = ${f.org} and key = 'not_required_right_now'`;
      await f.cycle();
      expect(await count("follow_up_runs", f.org)).toBe(0);
      const followUps = await import("../../after-reply/application/follow-ups");
      expect((await followUps.getConversationFollowUp(f.followUpDeps, f.actor, conversationId)).restartBlockedReason).toBe("Not now is set to stop follow-ups.");
    });

    it("starts at the step the pick's Reply draft rule chose, after the type's rule changed", async () => {
      const { f } = await picked("Could we book a demo next week?");
      await sql`update reply_types set reply_draft = false where organization_id = ${f.org} and key = 'demo_request'`;
      await f.cycle();
      const run = await one("select id from follow_up_runs where organization_id = $1 and status = 'active'", [f.org]);
      // The pick wrote a reply draft, so the run starts at step 1 and adopts it.
      expect(await count("follow_up_step_runs", f.org, `follow_up_run_id = '${run.id}'`)).toBe(2);
    });
  });

  describe("outcomes for a campaign that starts no runs", () => {
    it("names the campaign state on the follow-ups line, as the start rule reads it", async () => {
      const { f, conversationId, campaignId } = await withRun();
      const meetingDone = (await sub(f.org, "meeting_done")).id;
      const followUpsOf = async () => (await replyHandlingApp.getTypeChangeOutcomes(f.replyHandlingDeps, f.actor, conversationId, "correct")).find((o) => o.replyTypeId === meetingDone)?.outcome.followUps;
      expect(await followUpsOf()).toBe("Follow-ups: keep going.");
      await sql`update campaigns set status = 'paused' where id = ${campaignId}`;
      expect(await followUpsOf()).toBe("Follow-ups: none while the campaign is paused.");
      await sql`update campaigns set status = 'draft' where id = ${campaignId}`;
      expect(await followUpsOf()).toBe("Follow-ups: none until the campaign starts.");
      await sql`update campaigns set status = 'active', archived_at = now() where id = ${campaignId}`;
      expect(await followUpsOf()).toBe("Follow-ups: none, because the campaign is archived.");
      await sql`update campaigns set status = 'completed', archived_at = null where id = ${campaignId}`;
      expect(await followUpsOf()).toBe("Follow-ups: keep going.");
    });
  });

  describe("a stop request in the reply text", () => {
    it("a person's pick before the AI's writes no draft and starts no run, and the outcomes say so", async () => {
      const f = await fixture();
      const r = await composition.ingestInbound(mail(f, { bodyText: "Please unsubscribe me and stop emailing me." }));
      const personId = (await one("select id from people where organization_id = $1", [f.org])).id as string;
      const campaignId = await createCampaign(sql, { organizationId: f.org, name: "Autumn" });
      await recordSentEmail(sql, { organizationId: f.org, campaignId, personId, sentAt: new Date(f.clock().getTime() - 3_600_000) });
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: STEPS("Flow") });
      const conversation = await one("select id, context_version from conversations where organization_id = $1", [f.org]);
      const demo = await sub(f.org, "demo_request");

      const outcomes = await replyHandlingApp.getTypeChangeOutcomes(f.replyHandlingDeps, f.actor, conversation.id, "correct");
      expect(outcomes.find((o) => o.replyTypeId === demo.id)?.outcome).toMatchObject({
        replyDraft: "Reply draft: none, because they asked to stop.",
        followUps: "Follow-ups: stop, because they asked to stop.",
      });

      const result = await mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "demo_request", expectedContextVersion: Number(conversation.context_version) });
      expect(result.draftQueued).toBe(false);
      expect(await count("follow_up_runs", f.org)).toBe(0);
      expect(await one("select response from reply_type_picks where organization_id = $1", [f.org])).toMatchObject({ response: { stopRequested: true } });
      // The sweep reads the flag the person's pick stored, and starts nothing either.
      await f.cycle();
      expect(await count("follow_up_runs", f.org)).toBe(0);
      expect(await count("drafts", f.org)).toBe(0);
    });
  });

  describe("replyTypeChange in the draft prompt", () => {
    it("passes the new type, time and note to the model and drops the classifier's reason", async () => {
      const { f, r, conversationId, version } = await withRun({ flow: false });
      await move(f, conversationId, "meeting_done", version, "Met on Tuesday, they want the contract");
      await mgmt.requestDraft(f.replyDeps, f.actor, r.threadId);
      const input = f.ai.lastDraftInput!;
      expect(input.replyTypeChange).toMatchObject({ replyTypeName: "After a meeting", note: "Met on Tuesday, they want the contract" });
      expect(input.replyTypeChange!.occurredAt).toBeInstanceOf(Date);
      // The classifier read the old inbound message; that reading is stale after the move.
      expect(input.classification?.reason).toBeNull();
    });

    it("leaves replyTypeChange null with no move, and ignores a move that came before the last inbound message", async () => {
      const { f, r, input, conversationId, version } = await withRun({ flow: false });
      // The drafts written before any move carry no type change.
      expect(f.ai.lastDraftInput).not.toBeNull();
      expect(f.ai.lastDraftInput?.replyTypeChange).toBeNull();

      await move(f, conversationId, "meeting_done", version, "Old note");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await composition.ingestInbound(mail(f, { providerThreadId: input.providerThreadId, bodyText: "Actually one more question." }));
      const panel = await mgmt.getReplyPanel(f.replyDeps, f.actor, r.threadId);
      expect(panel?.draft?.status).toBe("stale");
      await mgmt.requestDraft(f.replyDeps, f.actor, r.threadId);
      expect(f.ai.lastDraftInput?.replyTypeChange).toBeNull();
      expect(f.ai.lastDraftInput?.classification?.reason ?? "kept").not.toBeNull();
    });

    it("takes the newest of several moves", async () => {
      const { f, r, conversationId, version } = await withRun({ flow: false });
      await move(f, conversationId, "meeting_done", version, "first");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await move(f, conversationId, "trial_requested", version + 1, "second");
      await mgmt.requestDraft(f.replyDeps, f.actor, r.threadId);
      expect(f.ai.lastDraftInput?.replyTypeChange).toMatchObject({ note: "second" });
    });
  });

  describe("human correction", () => {
    it("answers 409 on a version mismatch and changes nothing", async () => {
      const { f, r, conversationId, version } = await withRun();
      const before = { runs: await count("follow_up_runs", f.org), jobs: await count("ai_jobs", f.org), drafts: await count("drafts", f.org, "status = 'awaiting_review'") };
      await expect(mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "meeting_done", expectedContextVersion: version - 1 })).rejects.toThrow("Reply handling changed after you opened it. Reload and choose the type again.");
      await expect(mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "meeting_done", expectedContextVersion: version + 1 })).rejects.toBeInstanceOf(ConflictError);
      expect(await versionOf(conversationId)).toBe(version);
      expect({ runs: await count("follow_up_runs", f.org), jobs: await count("ai_jobs", f.org), drafts: await count("drafts", f.org, "status = 'awaiting_review'") }).toEqual(before);
    });

    it("bumps the version, retires the draft, swaps the run and writes a fresh draft for the corrected reply type", async () => {
      const { f, r, conversationId, version, flowId } = await withRun();
      const stale = await one("select id from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      const result = await mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "meeting_done", expectedContextVersion: version });
      expect(result).toMatchObject({ replyTypeKey: "meeting_done", draftQueued: true });
      expect(await versionOf(conversationId)).toBe(version + 1);
      expect(await one("select status, error from drafts where id = $1", [stale.id])).toMatchObject({ status: "stale", error: "A person corrected the reply type after this draft was written." });
      expect(await count("events", f.org, "event_type = 'follow_up.interrupted' and meta->>'reason' = 'type_corrected'")).toBe(1);
      const active = await rows("select flow_id from follow_up_runs where organization_id = $1 and status = 'active'", [f.org]);
      expect(active.map((a) => a.flow_id)).toEqual([flowId]);
      // The classification row moved to the new version, so the draft job accepts it.
      expect(await one("select expected_context_version, status from reply_type_picks where organization_id = $1", [f.org])).toMatchObject({ expected_context_version: version + 1 });

      await f.aiRun();
      const fresh = await rows("select id, status, expected_context_version from drafts where organization_id = $1 and status = 'awaiting_review' order by created_at", [f.org]);
      expect(fresh.length).toBeGreaterThanOrEqual(1);
      expect(fresh.every((d) => d.expected_context_version === version + 1)).toBe(true);
      expect(fresh.some((d) => d.id === stale.id)).toBe(false);
      expect(f.ai.lastDraftInput?.classification?.replyTypeName).toBe("After a meeting");
      // The panel shows the fresh draft, not the retired one.
      const panel = await mgmt.getReplyPanel(f.replyDeps, f.actor, r.threadId);
      expect(panel?.draft?.status).toBe("awaiting_review");
      expect(panel?.contextVersion).toBe(version + 1);
    });

    it("replaying the same correction answers 409 and queues nothing more", async () => {
      const { f, r, version } = await withRun();
      await mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "meeting_done", expectedContextVersion: version });
      const before = { runs: await count("follow_up_runs", f.org), jobs: await count("ai_jobs", f.org), events: await count("events", f.org) };
      await expect(mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "meeting_done", expectedContextVersion: version })).rejects.toBeInstanceOf(ConflictError);
      expect({ runs: await count("follow_up_runs", f.org), jobs: await count("ai_jobs", f.org), events: await count("events", f.org) }).toEqual(before);
    });

    it("a second correction after the first queues its own draft job", async () => {
      const { f, r, version } = await withRun();
      await mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "meeting_done", expectedContextVersion: version });
      await f.aiRun();
      await mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "demo_request", expectedContextVersion: version + 1 });
      expect(await count("ai_jobs", f.org, "kind = 'initial_draft' and status = 'queued'")).toBe(1);
      await f.aiRun();
      expect(await one("select expected_context_version from drafts where organization_id = $1 and status = 'awaiting_review' order by created_at desc limit 1", [f.org])).toMatchObject({ expected_context_version: version + 2 });
    });

    it("a pick after a failed AI pick stores a fresh pick that Undo can take back", async () => {
      const f = await fixture();
      const r = await composition.ingestInbound(mail(f));
      const conversationId = (await one("select id from conversations where organization_id = $1", [f.org])).id as string;
      await move(f, conversationId, "meeting_done", await versionOf(conversationId));
      const conversation = await one("select context_version, latest_inbound_message_id from conversations where id = $1", [conversationId]);
      // What `fail` writes when the classification job gives up.
      await sql`insert into reply_type_picks (organization_id, conversation_id, message_id, expected_context_version, status, error)
                values (${f.org}, ${conversationId}, ${conversation.latest_inbound_message_id}, ${conversation.context_version}, 'failed', 'the model was down')`;

      await mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "demo_request", expectedContextVersion: Number(conversation.context_version) });
      const picks = await rows("select id, status, provider, previous_reply_type_id from reply_type_picks where organization_id = $1 order by created_at", [f.org]);
      expect(picks.map((p) => p.status)).toEqual(["failed", "overridden"]);
      expect(picks[1]).toMatchObject({ provider: "human", previous_reply_type_id: (await sub(f.org, "meeting_done")).id });

      await replyHandlingApp.undoReplyTypePick(f.replyHandlingDeps, f.actor, picks[1].id as string);
      expect(await one("select reply_type_id from conversations where id = $1", [conversationId])).toMatchObject({ reply_type_id: (await sub(f.org, "meeting_done")).id });
    });

    it("a correction while the pick's draft job runs drafts again once that job ends", async () => {
      const { f, r, version } = await withRun({ flow: false });
      // The pick's draft job is running in another worker, which read the old version.
      const job = await one("select id, entity_id from ai_jobs where organization_id = $1 and kind = 'initial_draft'", [f.org]);
      const [held] = await sql`update ai_jobs set status = 'running', attempts = 1, locked_at = now(), locked_by = 'other', completed_at = null, claim_token = gen_random_uuid() where id = ${job.id} returning claim_token`;

      const result = await mgmt.setReplyType(f.replyDeps, f.actor, r.threadId, { replyTypeKey: "meeting_requested", expectedContextVersion: version });
      expect(result.draftQueued).toBe(true);
      // The other worker finishes: its draft is stale, and the job goes back to the queue for the new version.
      await stores.jobs.complete({ id: job.id, organizationId: f.org, kind: "initial_draft", entityId: job.entity_id, attempts: 1, maxAttempts: 3, claimToken: held.claim_token }, f.clock());
      expect(await one("select status from ai_jobs where id = $1", [job.id])).toMatchObject({ status: "queued" });
      await f.aiRun();
      expect(await one("select expected_context_version from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org])).toMatchObject({ expected_context_version: version + 1 });
      expect(await one("select status from ai_jobs where id = $1", [job.id])).toMatchObject({ status: "succeeded" });
    });

    it("another organization's person gets 404", async () => {
      const a = await withRun();
      const b = await withRun();
      await expect(mgmt.setReplyType(b.f.replyDeps, b.f.actor, a.r.threadId, { replyTypeKey: "meeting_done", expectedContextVersion: a.version })).rejects.toBeInstanceOf(NotFoundError);
      expect(await versionOf(a.conversationId)).toBe(a.version);
    });
  });

  describe("a person's draft request while the thread changes", () => {
    /** Reply deps whose context reads are followed by a version bump, as when a new reply lands while the AI writes. */
    const racing = (f: Fx, conversationId: string) => {
      const bump = () => sql`update conversations set context_version = context_version + 1 where id = ${conversationId}`;
      const store = {
        ...stores.replies,
        draftContext: async (o: string, c: string) => {
          const ctx = await stores.replies.draftContext(o, c);
          await bump();
          return ctx;
        },
        draftContextForDraft: async (o: string, d: string) => {
          const ctx = await stores.replies.draftContextForDraft(o, d);
          await bump();
          return ctx;
        },
      };
      return { ...f.replyDeps, store };
    };

    it("Write draft and Regenerate answer 409 and leave no draft to send", async () => {
      const { f, r, conversationId } = await withRun({ flow: false });
      const draft = await one("select id from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      await expect(mgmt.regenerateDraft(racing(f, conversationId), f.actor, draft.id, {})).rejects.toThrow("The thread changed while the draft was written.");
      await sql`update drafts set status = 'discarded' where organization_id = ${f.org}`;
      await expect(mgmt.requestDraft(racing(f, conversationId), f.actor, r.threadId)).rejects.toBeInstanceOf(ConflictError);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
    });
  });

  describe("stale drafts on a new inbound message", () => {
    it("marks the open draft stale in the ingest transaction, shows it as out of date, and refuses to send it", async () => {
      const { f, r, input } = await withRun();
      const draft = await one("select id, revision from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      await composition.ingestInbound(mail(f, { providerThreadId: input.providerThreadId, bodyText: "One more thing." }));
      expect(await one("select status, error from drafts where id = $1", [draft.id])).toMatchObject({ status: "stale", error: "A newer message arrived after this draft was written." });
      const panel = await mgmt.getReplyPanel(f.replyDeps, f.actor, r.threadId);
      expect(panel?.draft).toMatchObject({ id: draft.id, status: "stale" });
      await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: sendKey() })).rejects.toBeInstanceOf(ConflictError);
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("an auto-reply leaves the draft alone", async () => {
      const { f, input } = await withRun();
      await composition.ingestInbound(mail(f, { providerThreadId: input.providerThreadId, bodyText: "Out of office", autoReply: true }));
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("send still refuses an awaiting_review draft whose version is old", async () => {
      const { f, conversationId } = await withRun();
      const draft = await one("select id, revision from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      await sql`update conversations set context_version = context_version + 1 where id = ${conversationId}`;
      await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: sendKey() })).rejects.toBeInstanceOf(ConflictError);
      expect(await one("select status from drafts where id = $1", [draft.id])).toMatchObject({ status: "stale" });
    });

    it("keeps the compose rule: a manual draft supersedes the out-of-date one and is the one the panel shows", async () => {
      const { f, r, input } = await withRun();
      const old = await one("select id from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      await composition.ingestInbound(mail(f, { providerThreadId: input.providerThreadId, bodyText: "Following up." }));
      const created = await mgmt.createManualDraft(f.replyDeps, f.actor, r.threadId, { subject: "Re: hello", bodyText: "Typed by a person." });
      expect(await one("select status from drafts where id = $1", [old.id])).toMatchObject({ status: "stale" });
      const panel = await mgmt.getReplyPanel(f.replyDeps, f.actor, r.threadId);
      expect(panel?.draft).toMatchObject({ id: created.draftId, status: "awaiting_review" });
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("does not touch another organization's drafts", async () => {
      const a = await withRun();
      const b = await withRun();
      await composition.ingestInbound(mail(a.f, { providerThreadId: a.input.providerThreadId, bodyText: "More." }));
      expect(await count("drafts", b.f.org, "status = 'awaiting_review'")).toBe(1);
    });
  });
});
