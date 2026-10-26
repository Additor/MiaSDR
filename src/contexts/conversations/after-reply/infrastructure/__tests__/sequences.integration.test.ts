import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, waitForLockWaiters } from "@/test-support/db";
import type { InboundEmailInput } from "../../../application/ports";
import type { FakeMailboxProvider } from "@/contexts/outreach/email/infrastructure/fake-mailbox-provider";
import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";
import { createCampaign, FLOW_STEPS, recordSentEmail } from "../after-reply-test-kit";
import type { Job } from "@/platform/jobs/types";
import { replyAiResolverOf } from "@/contexts/conversations/ai/application/ai-ports";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("After a reply flows", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  let composition: typeof import("../../../infrastructure/composition");
  let mgmt: typeof import("../../../application/reply-management");
  let aiJobsApp: typeof import("../../../ai/application/ai-jobs");
  let seqApp: typeof import("../../application/sequences");
  let arApp: typeof import("../../application/after-reply");
  let seqJobsApp: typeof import("../../application/sequence-jobs");
  let stores: {
    jobs: typeof import("../../../ai/infrastructure/drizzle-ai-job-store").drizzleAiJobStore;
    replies: typeof import("../../../infrastructure/drizzle-reply-store").drizzleReplyStore;
    flows: typeof import("../drizzle-sequence-store").drizzleAfterReplyStore;
    runs: typeof import("../drizzle-sequence-store").drizzleRunStore;
    engine: typeof import("../drizzle-sequence-engine").drizzleSequenceEngine;
  };
  let campaignIdOfSequence: typeof import("../drizzle-sequence-store").campaignIdOfSequence;
  let FakeAi: typeof import("../../../ai/infrastructure/fake-reply-ai").FakeReplyAi;
  let createReplyMailer: typeof import("../../../infrastructure/reply-mailer").createReplyMailer;
  let mailbox: FakeMailboxProvider;
  const orgs: string[] = [];
  const users: string[] = [];
  let counter = 0;

  const DAY = 86_400_000;

  async function fixture() {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('Seq', ${"seq-" + tag}) returning id`;
    orgs.push(org);
    const [{ id: user }] = await sql`insert into users (name, email) values ('Member', ${`m-${tag}@x.test`}) returning id`;
    users.push(user);
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const ai = new FakeAi();
    const state = { offsetMs: 0 };
    const clock = () => new Date(Date.now() + state.offsetMs);
    const resolver = replyAiResolverOf(async (o: string) => (o === org ? ai : null));
    const [aiTick] = aiJobsApp.createAiJobs({ jobs: stores.jobs, replies: stores.replies, ai: resolver, now: clock, workerId: "ai", leaseMs: aiJobsApp.AI_JOB_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const seqTickFor = (workerId: string) =>
      (seqJobsApp.createSequenceJobs({ engine: stores.engine, runs: stores.runs, replies: stores.replies, ai: resolver, now: clock, workerId, leaseMs: seqJobsApp.SEQUENCE_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job])[0];
    const seqTick = seqTickFor("w1");
    const ctx = () => ({ deadline: Date.now() + 60_000, now: clock });
    const replyDeps = { store: stores.replies, ai: resolver, mailer: createReplyMailer(() => mailbox), now: clock, newToken: () => `tok-${Math.random().toString(36).slice(2)}` };
    const seqDeps = { runs: stores.runs, now: clock };
    const arDeps = { flows: stores.flows, now: clock };
    return {
      org,
      user,
      actor,
      address,
      ai,
      state,
      tag,
      replyDeps,
      seqDeps,
      arDeps,
      clock,
      aiRun: () => aiTick.run(ctx()),
      seqRun: () => seqTick.run(ctx()),
      seqRunAs: (w: string) => seqTickFor(w).run(ctx()),
      /** One tick of both jobs, in the registry's order. */
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
  const sendKey = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  const STEPS = FLOW_STEPS;

  /** Ingests the first email so the pipeline exists. The AI does not run yet. */
  async function ingest(f: Fx, partial: Partial<InboundEmailInput> = {}) {
    const input = mail(f, partial);
    const result = await composition.ingestInbound(input);
    return { ...result, input };
  }

  const personOfOrg = async (org: string) => (await one("select id from people where organization_id = $1 order by created_at limit 1", [org])).id as string;

  /**
   * Makes a campaign the owner of the person's conversation: it emailed the person an hour before the reply. With
   * `steps` the campaign also turns After a reply on. Returns the campaign id.
   */
  async function emailedBy(f: Fx, over: { personId?: string; name?: string; steps?: unknown[] | null; ago?: number; status?: "active" | "paused" | "completed" | "draft"; archived?: boolean } = {}) {
    const personId = over.personId ?? (await personOfOrg(f.org));
    const campaignId = await createCampaign(sql, { organizationId: f.org, name: over.name, status: over.status ?? "active", archived: over.archived });
    await recordSentEmail(sql, { organizationId: f.org, campaignId, personId, sentAt: new Date(f.clock().getTime() - (over.ago ?? 3_600_000)) });
    if (over.steps !== null) await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: over.steps ?? STEPS });
    return campaignId;
  }

  const replyTypeId = async (org: string, key: string) => (await one("select id from reply_types where organization_id = $1 and key = $2 order by created_at limit 1", [org, key])).id as string;

  /** Org with a campaign that emailed the lead and drafts follow-ups, one classified reply, and one cycle run. */
  async function withRun(steps: unknown[] = STEPS) {
    const f = await fixture();
    const r = await ingest(f);
    const campaignId = await emailedBy(f, { steps });
    await f.cycle();
    const run = await one("select * from sequence_runs where organization_id = $1", [f.org]);
    return { f, r, campaignId, sequenceId: run.sequence_id as string, run };
  }

  const approve = async (f: Fx, draftId: string) => {
    const [d] = await sql`select revision from drafts where id = ${draftId}`;
    return mgmt.approveAndSendDraft(f.replyDeps, f.actor, draftId, { revision: d.revision, idempotencyKey: sendKey() });
  };

  beforeAll(async () => {
    composition = await import("../../../infrastructure/composition");
    mgmt = await import("../../../application/reply-management");
    aiJobsApp = await import("../../../ai/application/ai-jobs");
    seqApp = await import("../../application/sequences");
    arApp = await import("../../application/after-reply");
    seqJobsApp = await import("../../application/sequence-jobs");
    const seqStore = await import("../drizzle-sequence-store");
    stores = {
      jobs: (await import("../../../ai/infrastructure/drizzle-ai-job-store")).drizzleAiJobStore,
      replies: (await import("../../../infrastructure/drizzle-reply-store")).drizzleReplyStore,
      flows: seqStore.drizzleAfterReplyStore,
      runs: seqStore.drizzleRunStore,
      engine: (await import("../drizzle-sequence-engine")).drizzleSequenceEngine,
    };
    campaignIdOfSequence = seqStore.campaignIdOfSequence;
    FakeAi = (await import("../../../ai/infrastructure/fake-reply-ai")).FakeReplyAi;
    createReplyMailer = (await import("../../../infrastructure/reply-mailer")).createReplyMailer;
    mailbox = (await import("@/contexts/outreach/infrastructure/composition")).mailboxProvider() as FakeMailboxProvider;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  describe("saving and publishing", () => {
    it("publishes an immutable version, edits publish a new one, and runs stay pinned", async () => {
      const f = await fixture();
      const r = await ingest(f);
      const campaignId = await emailedBy(f);
      const flow = await one("select * from sequences where campaign_id = $1", [campaignId]);
      expect(flow).toMatchObject({ status: "active", organization_id: f.org });
      const v1 = await one("select * from sequence_versions where sequence_id = $1", [flow.id]);
      expect(v1).toMatchObject({ version: 1, status: "published" });
      expect(v1.published_at).not.toBeNull();
      expect((await arApp.getCampaignAfterReply(f.arDeps, f.actor, campaignId)).mode).toBe("ai_drafts");

      await f.cycle();
      const run = await one("select * from sequence_runs where organization_id = $1", [f.org]);
      expect(run).toMatchObject({ sequence_version_id: v1.id, status: "active", started_by: "ai_assignment", trigger_message_id: r.messageId, sequence_id: flow.id });

      // Saving different steps publishes version 2 in one step; version 1 stays as it was.
      const edited = STEPS.map((s, i) => (i === 1 ? { ...s, aiInstructions: "A different nudge." } : s));
      const saved = await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: edited });
      expect(saved).toMatchObject({ versionNumber: 2, mode: "ai_drafts", stoppedRuns: 0, earlierVersionCount: 1 });
      expect(saved.inProgress.map((x) => [x.versionNumber, x.status])).toEqual([[1, "active"]]);
      const versions = await sql`select version, status from sequence_versions where sequence_id = ${flow.id} order by version`;
      expect(versions.map((v) => `${v.version}:${v.status}`)).toEqual(["1:published", "2:published"]);
      const v1Steps = await sql`select name, ai_instructions from sequence_steps where sequence_version_id = ${v1.id} order by position`;
      expect(v1Steps[1].ai_instructions).toBe("Check in once.");

      // Saving the same steps again publishes nothing.
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: edited });
      expect(await count("sequence_versions", f.org)).toBe(2);

      // The running run keeps its version, and its step rows still point at version 1's steps.
      const after = await one("select sequence_version_id from sequence_runs where id = $1", [run.id]);
      expect(after.sequence_version_id).toBe(v1.id);
      const pinned = await sql`select st.sequence_version_id from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id where sr.sequence_run_id = ${run.id}`;
      expect(new Set(pinned.map((p) => p.sequence_version_id))).toEqual(new Set([v1.id]));

      // A later reply interrupts that run and the next one pins version 2.
      await ingest(f, { providerThreadId: r.input.providerThreadId, bodyText: "Another demo question please." });
      await f.cycle();
      const runs = await sql`select r.status, v.version from sequence_runs r join sequence_versions v on v.id = r.sequence_version_id where r.organization_id = ${f.org} order by r.created_at`;
      expect(runs.map((x) => `${x.version}:${x.status}`)).toEqual(["1:interrupted", "2:active"]);
    });

    it("names the first flow after the campaign and keeps one flow per campaign", async () => {
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f, { name: "Autumn push" });
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: [STEPS[0]] });
      const flows = await sql`select name, status from sequences where campaign_id = ${campaignId}`;
      expect(flows).toHaveLength(1);
      expect(flows[0]).toMatchObject({ name: "Autumn push (after a reply)", status: "active" });
    });

    it("finds the campaign of a flow only inside its own organization", async () => {
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f);
      const { id: sequenceId } = await one("select id from sequences where campaign_id = $1", [campaignId]);
      expect(await campaignIdOfSequence(f.org, sequenceId)).toBe(campaignId);

      const other = await fixture();
      expect(await campaignIdOfSequence(other.org, sequenceId)).toBeNull();
      expect(await campaignIdOfSequence(f.org, "00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("switching off archives the flow, keeps its steps, and switching on again reuses the version", async () => {
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f);
      const off = await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff" });
      expect(off).toMatchObject({ mode: "handoff", stoppedRuns: 0, versionNumber: 1 });
      expect(off.steps).toHaveLength(3);
      expect(await one("select status from sequences where campaign_id = $1", [campaignId])).toMatchObject({ status: "archived" });
      const on = await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts" });
      expect(on).toMatchObject({ mode: "ai_drafts", versionNumber: 1 });
      expect(await count("sequence_versions", f.org)).toBe(1);
    });

    it("handoff creates no flow for a campaign that never had one", async () => {
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f, { steps: null });
      const view = await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff" });
      expect(view).toMatchObject({ mode: "handoff", steps: [], versionNumber: null, stoppedRuns: 0 });
      expect(await count("sequences", f.org)).toBe(0);
    });

    it("refuses AI drafts without a reply step, and a flow without steps stays off", async () => {
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f, { steps: null });
      await expect(arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts" })).rejects.toMatchObject({ details: { code: "steps_required" } });
      await expect(arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: [{ ...STEPS[0], delayMinutes: 30 }] })).rejects.toThrow(/Step 1/);
      expect(await count("sequences", f.org)).toBe(0);
      expect((await arApp.getCampaignAfterReply(f.arDeps, f.actor, campaignId)).mode).toBe("handoff");
    });

    it("locks LinkedIn and Personal campaigns to handoff", async () => {
      const f = await fixture();
      const linkedin = await createCampaign(sql, { organizationId: f.org, channel: "linkedin" });
      const personal = await createCampaign(sql, { organizationId: f.org, channel: "linkedin", type: "personal" });
      for (const id of [linkedin, personal]) {
        const view = await arApp.getCampaignAfterReply(f.arDeps, f.actor, id);
        expect(view).toMatchObject({ mode: "handoff", supported: false });
        expect(view.lockedReason).not.toBeNull();
        const err = await arApp.saveCampaignAfterReply(f.arDeps, f.actor, id, { mode: "ai_drafts", steps: [STEPS[0]] }).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toMatchObject({ code: "mode_locked" });
        expect(await arApp.saveCampaignAfterReply(f.arDeps, f.actor, id, { mode: "handoff" })).toMatchObject({ mode: "handoff" });
      }
      expect(await count("sequences", f.org)).toBe(0);
    });

    it("lists the runs in progress with their version and next step", async () => {
      const { f, campaignId, run } = await withRun();
      const view = await arApp.getCampaignAfterReply(f.arDeps, f.actor, campaignId);
      expect(view.inProgress).toHaveLength(1);
      expect(view.inProgress[0]).toMatchObject({ runId: run.id, recordId: run.record_id, status: "active", currentStep: 1, totalSteps: 3, versionNumber: 1 });
      expect(view.inProgress[0].personName).toBe("Lena Lead");
      expect(view.inProgress[0].nextDueAt).toBeInstanceOf(Date);
    });
  });

  describe("which campaign owns the conversation", () => {
    it("starts a run from the campaign that emailed the lead, not from other flows", async () => {
      const f = await fixture();
      await ingest(f);
      const mine = await emailedBy(f, { name: "Mine" });
      // Another campaign has a flow too but never emailed this person.
      const other = await createCampaign(sql, { organizationId: f.org, name: "Other" });
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, other, { mode: "ai_drafts", steps: STEPS });
      await f.cycle();
      const runs = await sql`select q.campaign_id from sequence_runs r join sequences q on q.id = r.sequence_id where r.organization_id = ${f.org}`;
      expect(runs.map((x) => x.campaign_id)).toEqual([mine]);
    });

    it("the campaign that emailed the person most recently wins", async () => {
      const f = await fixture();
      await ingest(f);
      const older = await emailedBy(f, { name: "Older", ago: 5 * DAY });
      const newer = await emailedBy(f, { name: "Newer", ago: 2 * DAY, steps: [STEPS[0], STEPS[1]] });
      await f.cycle();
      const run = await one("select q.campaign_id, (select count(*)::int from sequence_step_runs sr where sr.sequence_run_id = r.id) as steps from sequence_runs r join sequences q on q.id = r.sequence_id where r.organization_id = $1", [f.org]);
      expect(run).toMatchObject({ campaign_id: newer, steps: 2 });
      void older;
    });

    it("a send after the reply does not count", async () => {
      const f = await fixture();
      await ingest(f);
      const older = await emailedBy(f, { name: "Older", ago: 5 * DAY });
      await emailedBy(f, { name: "Later", ago: -2 * DAY });
      await f.cycle();
      const run = await one("select q.campaign_id from sequence_runs r join sequences q on q.id = r.sequence_id where r.organization_id = $1", [f.org]);
      expect(run.campaign_id).toBe(older);
    });

    it("a campaign in handoff mode blocks an older campaign's flow", async () => {
      const f = await fixture();
      await ingest(f);
      await emailedBy(f, { name: "Older with flow", ago: 5 * DAY });
      await emailedBy(f, { name: "Newer handoff", ago: DAY, steps: null });
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
      // The reply draft is untouched: the conversation goes to the Inbox.
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("a switched-off newer campaign blocks the older one too", async () => {
      const f = await fixture();
      await ingest(f);
      await emailedBy(f, { name: "Older", ago: 5 * DAY });
      const newer = await emailedBy(f, { name: "Newer", ago: DAY });
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, newer, { mode: "handoff" });
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
    });

    it("no campaign email, no run", async () => {
      const f = await fixture();
      await ingest(f);
      const campaignId = await createCampaign(sql, { organizationId: f.org });
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: STEPS });
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
    });

    it("ignores a send that is not a sent email of a campaign", async () => {
      const f = await fixture();
      await ingest(f);
      const personId = await personOfOrg(f.org);
      const campaignId = await createCampaign(sql, { organizationId: f.org });
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: STEPS });
      await recordSentEmail(sql, { organizationId: f.org, campaignId, personId, sentAt: new Date(f.clock().getTime() - 3_600_000), status: "failed" });
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
    });

    it("only email, regular, running or finished campaigns start runs", async () => {
      for (const over of [{ status: "paused" as const }, { status: "draft" as const }, { archived: true, status: "completed" as const }]) {
        const f = await fixture();
        await ingest(f);
        await emailedBy(f, over);
        await f.cycle();
        expect(await count("sequence_runs", f.org), JSON.stringify(over)).toBe(0);
      }
      const f = await fixture();
      await ingest(f);
      await emailedBy(f, { status: "completed" });
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(1);
    });

    it("restart follows the same owner", async () => {
      const { f, run, campaignId } = await withRun();
      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, draft.id);
      await seqApp.cancelSequenceRun(f.seqDeps, f.actor, run.record_id);
      const restarted = await seqApp.restartSequenceRun(f.seqDeps, f.actor, run.record_id);
      expect(restarted.created).toBe(true);
      const runs = await sql`select r.status, r.started_by, q.campaign_id from sequence_runs r join sequences q on q.id = r.sequence_id where r.organization_id = ${f.org} order by r.created_at`;
      expect(runs.map((x) => `${x.status}:${x.started_by}`)).toEqual(["cancelled:ai_assignment", "active:human_override"]);
      expect(runs[1].campaign_id).toBe(campaignId);
      // The person already got a hand-written answer, so the new run starts at the first follow-up.
      expect(await one("select start_step_position from sequence_runs where id = $1", [restarted.runId])).toMatchObject({ start_step_position: 2 });
      // In handoff mode a restart answers a conflict.
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff", confirmStopRuns: true });
      await expect(seqApp.restartSequenceRun(f.seqDeps, f.actor, run.record_id)).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe("campaign state", () => {
    it("a paused campaign starts no run and holds drafting for runs in progress; resuming continues", async () => {
      const { f, campaignId, run } = await withRun();
      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, draft.id);
      await f.seqRun();
      await sql`update campaigns set status = 'paused' where id = ${campaignId}`;
      f.state.offsetMs += 3 * DAY;
      await f.seqRun();
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      expect(await count("sequence_step_runs", f.org, "status = 'drafting'")).toBe(0);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
      await sql`update campaigns set status = 'active' where id = ${campaignId}`;
      const tick = await f.seqRun();
      expect(tick.detail?.drafted).toBe(1);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("a paused campaign starts no new run for a fresh reply", async () => {
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f);
      await sql`update campaigns set status = 'paused' where id = ${campaignId}`;
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
      await sql`update campaigns set status = 'active' where id = ${campaignId}`;
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(1);
    });

    it("completed and archived campaigns let runs in progress continue", async () => {
      for (const change of ["status = 'completed'", "status = 'completed', archived_at = now()"]) {
        const { f, campaignId, run } = await withRun();
        const draft = await one("select id from drafts where organization_id = $1", [f.org]);
        await approve(f, draft.id);
        await f.seqRun();
        await sql.unsafe(`update campaigns set ${change} where id = $1`, [campaignId]);
        f.state.offsetMs += 3 * DAY;
        const tick = await f.seqRun();
        expect(tick.detail?.drafted, change).toBe(1);
        expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
      }
    });
  });

  describe("switching After a reply off", () => {
    it("asks first, then ends the runs in progress at once with reason after_reply_off", async () => {
      const { f, campaignId, run } = await withRun();
      const err = await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff" }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.details).toEqual({ code: "runs_in_progress", count: 1 });
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
      expect(await one("select status from sequences where campaign_id = $1", [campaignId])).toMatchObject({ status: "active" });

      const done = await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff", confirmStopRuns: true });
      expect(done).toMatchObject({ mode: "handoff", stoppedRuns: 1, inProgress: [] });
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "interrupted" });
      expect(await count("events", f.org, "event_type = 'sequence.interrupted' and meta->>'reason' = 'after_reply_off'")).toBe(1);
      expect(await count("sequence_step_runs", f.org, "status in ('scheduled', 'drafting', 'awaiting_review')")).toBe(0);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      expect(await count("drafts", f.org, "status = 'stale'")).toBe(1);
      const state = await seqApp.getRecordSequence(f.seqDeps, f.actor, run.record_id);
      expect(state.run).toMatchObject({ status: "interrupted", endedReason: "after_reply_off", endedReasonLabel: "Follow-ups turned off for this campaign", statusLabel: "Stopped" });
      expect(state.campaign).toMatchObject({ id: campaignId, mode: "handoff" });
    });

    it("the sweep ends runs whose flow was archived behind the app's back within one tick", async () => {
      const { f, run, sequenceId } = await withRun();
      await sql`update sequences set status = 'archived' where id = ${sequenceId}`;
      const tick = await f.seqRun();
      expect(tick.detail?.interrupted_after_reply_off).toBe(1);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "interrupted" });
      expect(await count("events", f.org, "event_type = 'sequence.interrupted' and meta->>'reason' = 'after_reply_off'")).toBe(1);
    });

    it("a run of a legacy standalone sequence (no campaign) survives the sweep even though the sequence is archived", async () => {
      const { f, run, sequenceId } = await withRun();
      // Turn the flow into a legacy one: archived, owned by no campaign.
      await sql`update sequences set campaign_id = null, status = 'archived', name = ${"Legacy " + f.tag} where id = ${sequenceId}`;
      const tick = await f.seqRun();
      expect(tick.detail?.interrupted_after_reply_off ?? 0).toBe(0);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
      expect(await count("events", f.org, "event_type = 'sequence.interrupted'")).toBe(0);
      // It keeps going on its pinned version: the reply draft stays and the next step still drafts when due.
      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, draft.id);
      await f.seqRun();
      f.state.offsetMs += 3 * DAY;
      const later = await f.seqRun();
      expect(later.detail?.drafted).toBe(1);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
    });

    it("the sweep and the step claim agree: a campaign-owned flow that is not active is not claimed, a legacy one is", async () => {
      const lease = seqJobsApp.SEQUENCE_LEASE_MS;
      /** A run whose follow-up is due: the reply went out, so step 2 waits for its delay. */
      const dueRun = async () => {
        const ctx = await withRun();
        const draft = await one("select id from drafts where organization_id = $1", [ctx.f.org]);
        await approve(ctx.f, draft.id);
        await ctx.f.seqRun();
        ctx.f.state.offsetMs += 10 * DAY;
        return ctx;
      };
      const owned = await dueRun();
      // Control: while the flow is active the step is claimable.
      expect(await stores.engine.claimDue("w", owned.f.clock(), lease)).toMatchObject({ run: { id: owned.run.id } });
      await stores.engine.release((await one("select id from sequence_step_runs where sequence_run_id = $1 and status = 'drafting'", [owned.run.id])).id, owned.f.clock(), owned.f.clock());
      await sql`update sequences set status = 'archived' where id = ${owned.sequenceId}`;
      // The claim runs before any sweep and still refuses the archived campaign flow.
      expect(await stores.engine.claimDue("w", owned.f.clock(), lease)).toBeNull();
      const swept = await owned.f.seqRun();
      expect(swept.detail?.interrupted_after_reply_off).toBe(1);
      expect(await one("select status from sequence_runs where id = $1", [owned.run.id])).toMatchObject({ status: "interrupted" });

      const legacy = await dueRun();
      await sql`update sequences set campaign_id = null, status = 'archived', name = ${"Legacy " + legacy.f.tag} where id = ${legacy.sequenceId}`;
      expect(await stores.engine.claimDue("w", legacy.f.clock(), lease)).toMatchObject({ run: { id: legacy.run.id } });
    });

    it("switching a campaign to handoff still ends its runs with after_reply_off while a legacy run of the same organization goes on", async () => {
      const { f, campaignId, run } = await withRun();
      // A second record with a run on a legacy sequence in the same organization.
      const lead = await ingest(f, { from: { email: `second-${f.tag}@acme.test`, name: "Second Lead" } });
      const legacyCampaign = await emailedBy(f, { personId: lead.personId, steps: STEPS });
      await f.cycle();
      const legacyRun = await one("select r.id, r.sequence_id from sequence_runs r join records rec on rec.id = r.record_id where rec.person_id = $1", [lead.personId]);
      await sql`update sequences set campaign_id = null, status = 'archived', name = ${"Legacy " + f.tag} where id = ${legacyRun.sequence_id}`;
      expect(legacyCampaign).not.toBe(campaignId);

      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff", confirmStopRuns: true });
      await f.seqRun();
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "interrupted" });
      expect(await count("events", f.org, "event_type = 'sequence.interrupted' and meta->>'reason' = 'after_reply_off'")).toBe(1);
      expect(await one("select status from sequence_runs where id = $1", [legacyRun.id])).toMatchObject({ status: "active" });
    });

    it("a paused run stops too", async () => {
      const { f, campaignId, run } = await withRun();
      await seqApp.pauseSequenceRun(f.seqDeps, f.actor, run.record_id);
      const done = await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff", confirmStopRuns: true });
      expect(done.stoppedRuns).toBe(1);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "interrupted" });
    });
  });

  describe("switching off while a run starts", () => {
    /** An org whose lead has a classified reply and an owner campaign with After a reply on, and no run yet. */
    async function readyToStart() {
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f);
      await f.aiRun();
      const record = (await one("select id from records where organization_id = $1", [f.org])).id as string;
      return { f, campaignId, record };
    }

    it("a run that is mid-creation is counted by the switch-off, which then asks for confirmation", async () => {
      const { f, campaignId, record } = await readyToStart();
      // Another transaction holds the record, so the run start waits at the record lock, after it took its hold on the flow.
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const holder = sql.begin(async (tx) => {
        await tx`select id from records where id = ${record} for update`;
        locked();
        await held;
      });
      await holding;
      const start = seqApp.attemptRun({ runs: stores.runs, now: f.clock }, { organizationId: f.org, recordId: record, source: "human_override" });
      await waitForLockWaiters(sql, 1);
      let switchedOff = false;
      const off = arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff" }).then(
        () => ((switchedOff = true), null),
        (error: unknown) => error,
      );
      // The switch-off blocks behind the run start's hold on the flow.
      await waitForLockWaiters(sql, 2);
      expect(switchedOff, "the switch-off waits for the run start instead of passing it").toBe(false);
      release();
      await holder;
      expect(await start).toHaveProperty("started");
      const error = await off;
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toEqual({ code: "runs_in_progress", count: 1 });
      expect(await one("select status from sequences where campaign_id = $1", [campaignId])).toMatchObject({ status: "active" });
      expect(await count("sequence_runs", f.org, "status = 'active'")).toBe(1);
    });

    it("a run start that comes after the switch-off committed is refused, not created on the archived flow", async () => {
      const { f, campaignId, record } = await readyToStart();
      const runs = {
        ...stores.runs,
        // The facts say the flow is on; the switch-off commits before the run is written.
        loadStart: async (...args: Parameters<typeof stores.runs.loadStart>) => {
          const facts = await stores.runs.loadStart(...args);
          await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff" });
          return facts;
        },
      };
      await expect(seqApp.attemptRun({ runs, now: f.clock }, { organizationId: f.org, recordId: record, source: "human_override" })).rejects.toMatchObject({ details: { code: "flow_off" } });
      expect(await count("sequence_runs", f.org)).toBe(0);
    });
  });

  describe("the record page read", () => {
    it("reads the start facts in at most four queries and answers like the explicit-conversation read", async () => {
      const f = await fixture();
      await ingest(f);
      await emailedBy(f);
      await f.aiRun();
      const record = (await one("select id from records where organization_id = $1", [f.org])).id as string;
      const conversation = (await one("select id from conversations where organization_id = $1", [f.org])).id as string;
      const { loadStartOn } = await import("../drizzle-sequence-store");
      const { db } = await import("@/platform/db/client");
      let queries = 0;
      const counting = { execute: (query: Parameters<typeof db.execute>[0]) => (queries++, db.execute(query)) } as unknown as typeof db;
      const facts = await loadStartOn(counting, f.org, record, {});
      expect(queries, "record and conversation, owner with flow and version, steps, zone").toBeLessThanOrEqual(4);
      expect(await loadStartOn(db, f.org, record, { conversationId: conversation })).toEqual(facts);
      expect(facts).toMatchObject({ conversation: { id: conversation, channel: "email" }, flow: { status: "active", hasPublished: true }, selection: { campaignId: expect.any(String) } });
      expect(facts?.steps).toHaveLength(3);
      const state = await seqApp.getRecordSequence(f.seqDeps, f.actor, record);
      expect(state).toMatchObject({ run: null, canRestart: true, restartBlockedReason: null });
    });
  });

  describe("the type's Follow-ups rule decides the start", () => {
    it("a reply type set to stop starts no run, and the same type set to keep going starts one", async () => {
      const stopped = await fixture();
      await ingest(stopped, { bodyText: "Not now, thanks." });
      await emailedBy(stopped);
      await stopped.cycle();
      expect(await one("select s.key from records r join reply_types s on s.id = r.reply_type_id where r.organization_id = $1", [stopped.org])).toMatchObject({ key: "not_required_right_now" });
      expect(await count("sequence_runs", stopped.org)).toBe(0);

      const going = await fixture();
      await ingest(going, { bodyText: "Not now, thanks." });
      await sql`update reply_types set follow_ups = 'continue' where organization_id = ${going.org} and key = 'not_required_right_now'`;
      await emailedBy(going);
      await going.cycle();
      expect(await count("sequence_runs", going.org, "status = 'active'")).toBe(1);
    });

    it("an Interested type set to stop starts no run", async () => {
      const f = await fixture();
      await ingest(f);
      await sql`update reply_types set follow_ups = 'stop' where organization_id = ${f.org} and key = 'demo_request'`;
      await emailedBy(f);
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
      const record = (await one("select id from records where organization_id = $1", [f.org])).id as string;
      const state = await seqApp.getRecordSequence(f.seqDeps, f.actor, record);
      expect(state).toMatchObject({ canRestart: false, restartBlockedReason: "Demo request is set to stop follow-ups." });
    });
  });

  describe("only new replies start a run", () => {
    const MIN = 60_000;

    it("a reply from before the flow was turned on gets no run, a later reply from the same lead does", async () => {
      const f = await fixture();
      const old = await ingest(f, { receivedAt: new Date(f.clock().getTime() - 30 * DAY) });
      await emailedBy(f, { ago: 31 * DAY });
      await f.cycle();
      expect(await count("sequence_runs", f.org), "historical reply").toBe(0);
      expect(await stores.engine.startCandidates(50)).toEqual([]);

      f.state.offsetMs += 2 * MIN;
      await ingest(f, { from: old.input.from, providerThreadId: "thread-new", receivedAt: new Date(f.clock().getTime() - 1000) });
      await f.cycle();
      expect(await count("sequence_runs", f.org), "reply after turning on").toBe(1);
    });

    it("a reply that arrived minutes before the save and is classified after it still starts", async () => {
      const f = await fixture();
      await ingest(f, { receivedAt: new Date(f.clock().getTime() - 5 * MIN) });
      await emailedBy(f, { ago: 60 * MIN });
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(1);
    });

    it("a reply from just outside the margin before the save does not start", async () => {
      const f = await fixture();
      await ingest(f, { receivedAt: new Date(f.clock().getTime() - 15 * MIN) });
      await emailedBy(f, { ago: 60 * MIN });
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
    });

    it("editing the steps later keeps old replies out: the save leaves the turned-on time alone", async () => {
      const f = await fixture();
      await ingest(f, { receivedAt: new Date(f.clock().getTime() - 30 * DAY) });
      const campaignId = await emailedBy(f, { ago: 31 * DAY });
      const before = await one("select updated_at from sequences where campaign_id = $1", [campaignId]);
      f.state.offsetMs += 2 * DAY;
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: [...STEPS, { ...STEPS[2], name: "One more" }] });
      const after = await one("select updated_at from sequences where campaign_id = $1", [campaignId]);
      expect(after.updated_at).toEqual(before.updated_at);
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
    });

    it("another write to the flow row does not move the cut-off: a reply after the real turn-on time still starts", async () => {
      const f = await fixture();
      const first = await ingest(f, { receivedAt: new Date(f.clock().getTime() - 30 * DAY) });
      const campaignId = await emailedBy(f, { ago: 31 * DAY });
      f.state.offsetMs += 1 * DAY;
      await ingest(f, { from: first.input.from, providerThreadId: "thread-after-enable", receivedAt: new Date(f.clock().getTime() - 1000) });
      // Something else touches the row two days after the turn-on, before the engine looks at the new reply.
      f.state.offsetMs += 1 * DAY;
      await sql`update sequences set name = name || ' (renamed)', updated_at = ${f.clock()} where campaign_id = ${campaignId}`;
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(1);
    });

    it("turning After a reply off and on again sets a new cut-off; the first save and a step edit do not move it", async () => {
      const f = await fixture();
      const first = await ingest(f, { receivedAt: new Date(f.clock().getTime() - 30 * DAY) });
      const campaignId = await emailedBy(f, { ago: 31 * DAY });
      const enabledAt = async () => (await one("select after_reply_enabled_at as t from sequences where campaign_id = $1", [campaignId])).t as Date;
      const turnedOn = await enabledAt();
      expect(Math.abs(turnedOn.getTime() - f.clock().getTime())).toBeLessThan(5000);

      f.state.offsetMs += 1 * DAY;
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: [...STEPS, { ...STEPS[2], name: "One more" }] });
      expect(await enabledAt(), "a step edit leaves it").toEqual(turnedOn);

      // A reply arrives while the flow is on, but the engine has not looked yet. The setting goes off and on again.
      await ingest(f, { from: first.input.from, providerThreadId: "thread-during", receivedAt: new Date(f.clock().getTime() - 1000) });
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff" });
      f.state.offsetMs += 2 * DAY;
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts" });
      expect(Math.abs((await enabledAt()).getTime() - f.clock().getTime()), "re-enabling resets it").toBeLessThan(5000);
      await f.cycle();
      expect(await count("sequence_runs", f.org), "the reply from before the re-enable is history").toBe(0);
    });

    it("editing the steps later does not exclude a new reply that was waiting, and it starts on the newer version", async () => {
      const f = await fixture();
      const first = await ingest(f, { receivedAt: new Date(f.clock().getTime() - 30 * DAY) });
      const campaignId = await emailedBy(f, { ago: 31 * DAY });
      // The campaign pauses, so a new reply waits without a run.
      await sql`update campaigns set status = 'paused' where id = ${campaignId}`;
      f.state.offsetMs += 1 * DAY;
      await ingest(f, { from: first.input.from, providerThreadId: "thread-waiting", receivedAt: new Date(f.clock().getTime() - 1000) });
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
      // The steps change two days after the setting was turned on, then the campaign resumes.
      f.state.offsetMs += 1 * DAY;
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts", steps: [...STEPS, { ...STEPS[2], name: "One more" }] });
      await sql`update campaigns set status = 'active' where id = ${campaignId}`;
      await f.cycle();
      const runs = await sql`select v.version, (select count(*)::int from sequence_steps st where st.sequence_version_id = v.id) as steps from sequence_runs r join sequence_versions v on v.id = r.sequence_version_id where r.organization_id = ${f.org}`;
      expect(runs.map((x) => [x.version, x.steps])).toEqual([[2, 4]]);
    });

    it("switching off and on again moves the cut-off: a reply that came while it was off does not start", async () => {
      const f = await fixture();
      const first = await ingest(f);
      const campaignId = await emailedBy(f, { steps: STEPS });
      await f.cycle();
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff", confirmStopRuns: true });
      f.state.offsetMs += 1 * DAY;
      await ingest(f, { from: first.input.from, providerThreadId: "thread-off", receivedAt: new Date(f.clock().getTime() - 1000) });
      f.state.offsetMs += 1 * DAY;
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "ai_drafts" });
      await f.cycle();
      expect(await count("sequence_runs", f.org, "status = 'active'")).toBe(0);
    });
  });

  describe("why Restart cannot run", () => {
    /** One run, then `change` breaks one condition. The record page and the 409 name the same cause. */
    async function blocked(change: (ctx: Awaited<ReturnType<typeof withRun>> & { personId: string }) => Promise<void>) {
      const ctx = await withRun();
      const personId = (await one("select person_id from records where id = $1", [ctx.run.record_id])).person_id as string;
      expect((await seqApp.getRecordSequence(ctx.f.seqDeps, ctx.f.actor, ctx.run.record_id)).canRestart, "restartable before the change").toBe(true);
      await change({ ...ctx, personId });
      const state = await seqApp.getRecordSequence(ctx.f.seqDeps, ctx.f.actor, ctx.run.record_id);
      const err = await seqApp.restartSequenceRun(ctx.f.seqDeps, ctx.f.actor, ctx.run.record_id).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(state.canRestart).toBe(false);
      expect(err.message).toBe(state.restartBlockedReason);
      return { ...ctx, state, message: err.message as string };
    }

    it("a paused campaign", async () => {
      const r = await blocked(async ({ campaignId }) => void (await sql`update campaigns set status = 'paused' where id = ${campaignId}`));
      expect(r.message).toMatch(/is paused\. Resume it to restart follow-ups\./);
      expect(r.state.campaign?.mode).toBe("ai_drafts");
    });

    it("a campaign that has not started", async () => {
      const r = await blocked(async ({ campaignId }) => void (await sql`update campaigns set status = 'draft' where id = ${campaignId}`));
      expect(r.message).toMatch(/has not started yet/);
    });

    it("an archived campaign", async () => {
      const r = await blocked(async ({ campaignId }) => void (await sql`update campaigns set archived_at = now() where id = ${campaignId}`));
      expect(r.message).toMatch(/is archived/);
    });

    it("AI drafts turned off", async () => {
      const r = await blocked(async ({ f, campaignId }) => void (await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff", confirmStopRuns: true })));
      expect(r.message).toMatch(/AI drafts are off for the campaign/);
      expect(r.state.campaign?.mode).toBe("handoff");
    });

    it("a flow without published steps", async () => {
      // The owner's flow exists and is active but holds no published version.
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f, { steps: null });
      await sql`insert into sequences (organization_id, name, campaign_id, status) values (${f.org}, ${"Unpublished " + f.tag}, ${campaignId}, 'active')`;
      const record = (await one("select id from records where organization_id = $1", [f.org])).id as string;
      const state = await seqApp.getRecordSequence(f.seqDeps, f.actor, record);
      expect(state.canRestart).toBe(false);
      expect(state.restartBlockedReason).toMatch(/no published follow-up steps/);
      await expect(seqApp.restartSequenceRun(f.seqDeps, f.actor, record)).rejects.toThrow(/no published follow-up steps/);
    });

    it("no campaign emailed the person", async () => {
      const f = await fixture();
      await ingest(f);
      const record = (await one("select id from records where organization_id = $1", [f.org])).id as string;
      const state = await seqApp.getRecordSequence(f.seqDeps, f.actor, record);
      expect(state).toMatchObject({ canRestart: false, restartBlockedReason: "No campaign has emailed this person, so no follow-ups apply." });
      await expect(seqApp.restartSequenceRun(f.seqDeps, f.actor, record)).rejects.toThrow("No campaign has emailed this person, so no follow-ups apply.");
    });

    it("a record without an email reply", async () => {
      const f = await fixture();
      await ingest(f);
      const record = (await one("select id from records where organization_id = $1", [f.org])).id as string;
      await sql`update records set latest_inbound_message_id = null, last_inbound_at = null where id = ${record}`;
      const state = await seqApp.getRecordSequence(f.seqDeps, f.actor, record);
      expect(state.restartBlockedReason).toBe("This conversation has no email reply to follow up on.");
      await expect(seqApp.restartSequenceRun(f.seqDeps, f.actor, record)).rejects.toThrow("no email reply");
    });

    it("a reply type set to stop follow-ups, named", async () => {
      const r = await blocked(async ({ f, run }) => {
        const sub = await one("select id, group_key from reply_types where organization_id = $1 and key = 'customer'", [f.org]);
        await sql`update records set reply_type_id = ${sub.id}, group_key = ${sub.group_key} where id = ${run.record_id}`;
      });
      expect(r.message).toBe("Customer question is set to stop follow-ups.");
    });

    it("do not contact", async () => {
      const r = await blocked(async ({ f, personId }) => void (await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${personId}, ${f.org}, true, 'human', now())`));
      expect(r.message).toMatch(/do not contact/);
    });

    it("a suppressed address", async () => {
      const r = await blocked(async ({ f, personId }) => {
        const person = await one("select email from people where id = $1", [personId]);
        await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${person.email}, 'manual')`;
      });
      expect(r.message).toMatch(/suppression list/);
    });

    it("a closed record", async () => {
      const r = await blocked(async ({ run }) => void (await sql`update records set workflow_state = 'closed' where id = ${run.record_id}`));
      expect(r.message).toMatch(/Reply handling is closed/);
    });

    it("a contact", async () => {
      const r = await blocked(async ({ personId }) => void (await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`));
      expect(r.message).toBe("The person is a contact, so follow-ups do not apply.");
    });
  });

  describe("a run", () => {
    it("adopts the reply draft, schedules follow-ups after the send, and only ever drafts", async () => {
      const { f, r, run } = await withRun();
      const steps = await sql`select sr.*, st.position from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id where sr.sequence_run_id = ${run.id} order by st.position`;
      expect(steps.map((s) => s.status)).toEqual(["awaiting_review", "scheduled", "scheduled"]);
      const draft = await one("select * from drafts where organization_id = $1", [f.org]);
      expect(draft).toMatchObject({ status: "awaiting_review", reply_for_message_id: r.messageId });
      expect(steps[0].draft_id).toBe(draft.id);
      expect(mailbox.delivered).toHaveLength(0 + mailbox.delivered.length);
      const deliveredBefore = mailbox.delivered.length;

      // Nothing becomes due while the reply waits for a person, however much time passes.
      f.state.offsetMs += 10 * DAY;
      await f.seqRun();
      expect(await count("drafts", f.org)).toBe(1);

      const sent = await approve(f, draft.id);
      expect(sent.status).toBe("sent");
      expect(mailbox.delivered.length).toBe(deliveredBefore + 1);
      await f.seqRun();
      const afterSend = await sql`select sr.status, sr.due_at, sr.sent_message_id, st.position from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id where sr.sequence_run_id = ${run.id} order by st.position`;
      expect(afterSend[0]).toMatchObject({ status: "sent" });
      expect(afterSend[0].sent_message_id).not.toBeNull();
      const message = await one("select sent_at from messages where id = $1", [afterSend[0].sent_message_id]);
      // Step 2 waits its own two days after the message went out.
      expect(afterSend[1].due_at.getTime()).toBe(new Date(message.sent_at).getTime() + 2 * DAY);
      expect(await one("select current_step_position from sequence_runs where id = $1", [run.id])).toMatchObject({ current_step_position: 2 });
      expect(await count("drafts", f.org)).toBe(1);

      // Not yet due, then due: a draft appears, awaiting review, and still nothing is sent.
      f.state.offsetMs += 1 * DAY;
      await f.seqRun();
      expect(await count("drafts", f.org)).toBe(1);
      f.state.offsetMs += 2 * DAY;
      const tick = await f.seqRun();
      expect(tick.detail?.drafted).toBe(1);
      const follow = await one("select * from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      expect(follow.request).toMatchObject({ stepPosition: 2 });
      expect(follow.reply_for_message_id).toBe(r.messageId);
      expect(mailbox.delivered.length).toBe(deliveredBefore + 1);
      expect(f.ai.lastDraftInput?.operatorInstructions).toContain("Check in once.");
      expect(f.ai.lastDraftInput?.operatorInstructions).toContain("has not replied");
      expect(await one("select workflow_state from records where organization_id = $1", [f.org])).toMatchObject({ workflow_state: "action_required" });

      // The human sends it. The last step follows, then the run completes.
      expect((await approve(f, follow.id)).status).toBe("sent");
      await f.seqRun();
      f.state.offsetMs += 4 * DAY;
      await f.seqRun();
      const last = await one("select * from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      expect(last.request).toMatchObject({ stepPosition: 3 });
      expect((await approve(f, last.id)).status).toBe("sent");
      await f.seqRun();
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "completed" });
      expect(await one("select workflow_state, next_action_at from records where organization_id = $1", [f.org])).toMatchObject({ workflow_state: "idle", next_action_at: null });
      expect(mailbox.delivered.length).toBe(deliveredBefore + 3);
    });

    it("skips the step when the human discards its draft and schedules the next from now", async () => {
      const { f, run } = await withRun();
      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await mgmt.discardDraft(f.replyDeps, f.actor, draft.id);
      await f.seqRun();
      const steps = await sql`select sr.status, sr.due_at, st.position from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id where sr.sequence_run_id = ${run.id} order by st.position`;
      expect(steps.map((s) => s.status)).toEqual(["skipped", "scheduled", "scheduled"]);
      expect(Math.abs(steps[1].due_at.getTime() - (f.clock().getTime() + 2 * DAY))).toBeLessThan(60_000);
    });

    it("drafts a step again when its draft goes stale with no stop reason, and fails it on the third stale draft", async () => {
      const { f, run } = await withRun();
      const first = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, first.id);
      await f.seqRun();
      f.state.offsetMs += 3 * DAY;
      await f.seqRun();
      const step2 = async () =>
        one("select sr.status, sr.draft_id, sr.attempt_count from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id where sr.sequence_run_id = $1 and st.position = 2", [run.id]);
      const drafted: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const step = await step2();
        expect(step).toMatchObject({ status: "awaiting_review", attempt_count: attempt });
        expect(drafted).not.toContain(step.draft_id);
        drafted.push(step.draft_id);
        // Superseded by a write that did not stop the run.
        await sql`update drafts set status = 'stale' where id = ${step.draft_id}`;
        await f.seqRun();
      }
      expect(await step2()).toMatchObject({ status: "failed", draft_id: drafted[2], attempt_count: 3 });
      expect(await count("drafts", f.org, `request->>'stepPosition' = '2'`)).toBe(3);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
    });

    it("schedules whole-day delays in the organization time zone", async () => {
      const f = await fixture();
      await sql`insert into channel_settings (organization_id, channel, "values") values (${f.org}, 'general', ${JSON.stringify({ timeZone: "America/New_York" })}::jsonb)`;
      await ingest(f);
      await emailedBy(f);
      await f.cycle();
      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, draft.id);
      await f.seqRun();
      const msg = await one("select sent_at from messages where organization_id = $1 and direction = 'outbound'", [f.org]);
      const step2 = await one("select sr.due_at from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id where sr.organization_id = $1 and st.position = 2", [f.org]);
      const sent = new Date(msg.sent_at);
      const wall = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
      expect(wall(step2.due_at)).toBe(wall(sent));
      expect(step2.due_at.getTime() - sent.getTime()).toBeGreaterThanOrEqual(2 * DAY - DAY / 24);
    });

    it("refuses a conversation of another record when a person restarts the follow-ups", async () => {
      const f = await fixture();
      const a = await ingest(f);
      const b = await ingest(f);
      await emailedBy(f);
      const recordA = (await one("select record_id from conversations where id = $1", [a.conversationId])).record_id;
      await expect(seqApp.restartSequenceRun(f.seqDeps, f.actor, recordA, { conversationId: b.conversationId })).rejects.toBeInstanceOf(ConflictError);
      expect(await count("sequence_runs", f.org)).toBe(0);
    });
  });

  describe("what stops a run", () => {
    const expectStopped = async (f: Fx, runId: string, reason?: string) => {
      const run = await one("select status from sequence_runs where id = $1", [runId]);
      expect(run.status).toBe("interrupted");
      const open = await count("sequence_step_runs", f.org, "status in ('scheduled', 'drafting', 'awaiting_review')");
      expect(open).toBe(0);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      if (reason) expect(await count("events", f.org, `event_type = 'sequence.interrupted' and meta->>'reason' = '${reason}'`)).toBe(1);
      // Time passes and nothing new is drafted.
      const drafts = await count("drafts", f.org);
      f.state.offsetMs += 30 * DAY;
      await f.seqRun();
      expect(await count("drafts", f.org)).toBe(drafts);
    };

    it("a reply cancels the run in the same transaction as the ingest", async () => {
      const { f, r, run } = await withRun();
      await composition.ingestInbound(mail(f, { providerThreadId: r.input.providerThreadId, bodyText: "Actually, one more thing." }));
      // No tick ran: the ingest itself ended the run and retired its draft.
      await expectStopped(f, run.id, "reply");
    });

    it("an automatic reply does not stop it", async () => {
      const { f, r, run } = await withRun();
      await composition.ingestInbound(mail(f, { providerThreadId: r.input.providerThreadId, bodyText: "I am out of office.", autoReply: true }));
      await f.seqRun();
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
    });

    it("do not contact", async () => {
      const { f, run } = await withRun();
      const person = await one("select id from people where organization_id = $1", [f.org]);
      await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${person.id}, ${f.org}, true, 'human', now())`;
      await f.seqRun();
      await expectStopped(f, run.id, "do_not_contact");
    });

    it("the lead page toggle stops the run at once, without waiting for a tick", async () => {
      const { f, run } = await withRun();
      const person = await one("select id from people where organization_id = $1", [f.org]);
      const { setPersonDoNotContact } = await import("../../../application/reply-handling");
      const { replyHandlingDeps } = await import("../../../infrastructure/reply-handling-composition");
      await expect(setPersonDoNotContact(replyHandlingDeps(), f.actor, person.id, { enabled: true })).rejects.toThrow(/Say why/);
      await setPersonDoNotContact(replyHandlingDeps(), f.actor, person.id, { enabled: true, reason: "Asked to stop" });
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "interrupted" });
      expect(await count("sequence_step_runs", f.org, "status in ('scheduled', 'drafting', 'awaiting_review')")).toBe(0);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      expect(await one("select do_not_contact, source from contact_policies where person_id = $1", [person.id])).toMatchObject({ do_not_contact: true, source: "human" });
    });

    it("unsubscribe", async () => {
      const { f, run } = await withRun();
      const person = await one("select email from people where organization_id = $1", [f.org]);
      await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${person.email}, 'unsubscribed')`;
      await f.seqRun();
      await expectStopped(f, run.id, "unsubscribed");
    });

    it("bounce", async () => {
      const { f, run } = await withRun();
      const person = await one("select email from people where organization_id = $1", [f.org]);
      await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${person.email}, 'bounced')`;
      await f.seqRun();
      await expectStopped(f, run.id, "bounce");
    });

    it("a type change to a type set to stop follow-ups", async () => {
      const { f, run } = await withRun();
      const sub = await replyTypeId(f.org, "not_required_right_now");
      await sql`update records set group_key = 'not_interested', reply_type_id = ${sub}, context_version = context_version where organization_id = ${f.org}`;
      await f.seqRun();
      await expectStopped(f, run.id, "terminal_stage");
    });

    it("a type change to Out of office, which the seed sets to stop follow-ups", async () => {
      const { f, run } = await withRun();
      const ooo = await one("select id, group_key, follow_ups from reply_types where organization_id = $1 and key = 'out_of_office'", [f.org]);
      expect(ooo.follow_ups).toBe("stop");
      await sql`update records set group_key = ${ooo.group_key}, reply_type_id = ${ooo.id} where organization_id = ${f.org}`;
      await f.seqRun();
      await expectStopped(f, run.id, "terminal_stage");
    });

    it("reads the type's Follow-ups rule, not its group or key", async () => {
      // A Not interested type set to keep going does not end the run; an Interested type set to stop does.
      const kept = await withRun();
      const keepGoing = await one("select id, group_key from reply_types where organization_id = $1 and key = 'already_using_a_tool'", [kept.f.org]);
      await sql`update reply_types set follow_ups = 'continue' where id = ${keepGoing.id}`;
      await sql`update records set group_key = ${keepGoing.group_key}, reply_type_id = ${keepGoing.id} where organization_id = ${kept.f.org}`;
      await kept.f.seqRun();
      expect(await one("select status from sequence_runs where id = $1", [kept.run.id])).toMatchObject({ status: "active" });

      const { f, run } = await withRun();
      const stop = await one("select id, group_key from reply_types where organization_id = $1 and key = 'meeting_requested'", [f.org]);
      await sql`update reply_types set follow_ups = 'stop' where id = ${stop.id}`;
      await sql`update records set group_key = ${stop.group_key}, reply_type_id = ${stop.id} where organization_id = ${f.org}`;
      await f.seqRun();
      await expectStopped(f, run.id, "terminal_stage");
    });

    it("an edit of the rule of the type a run started on leaves the run going", async () => {
      const { f, run } = await withRun();
      await sql`update reply_types set follow_ups = 'stop' where id = ${run.reply_type_id}`;
      await f.seqRun();
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
    });

    it("a trigger after the step was claimed still stops the draft", async () => {
      const { f, run } = await withRun();
      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, draft.id);
      await f.seqRun();
      f.state.offsetMs += 3 * DAY;
      const person = await one("select email from people where organization_id = $1", [f.org]);
      await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${person.email}, 'unsubscribed')`;
      // The sweep runs first in a tick, but even the guard before drafting would catch it.
      await f.seqRun();
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "interrupted" });
    });
  });

  describe("an immediate stop, with no tick", () => {
    /** The run ended and its drafts retired in the trigger's own transaction. No job ran. */
    const expectStoppedNow = async (f: Fx, runId: string, reason: string) => {
      expect(await one("select status from sequence_runs where id = $1", [runId])).toMatchObject({ status: "interrupted" });
      expect(await count("sequence_step_runs", f.org, "status in ('scheduled', 'drafting', 'awaiting_review')")).toBe(0);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      expect(await count("drafts", f.org, "status = 'stale'")).toBe(1);
      expect(await count("events", f.org, `event_type = 'sequence.interrupted' and meta->>'reason' = '${reason}'`)).toBe(1);
    };
    const personOf = (f: Fx) => one("select id, email from people where organization_id = $1", [f.org]);
    const suppression = async () => (await import("@/test-support/suppression")).suppressionStore();

    it("do not contact through the reply handling store", async () => {
      const { f, run } = await withRun();
      const person = await personOf(f);
      const { drizzleReplyHandlingStore } = await import("../../../infrastructure/drizzle-reply-handling-store");
      await drizzleReplyHandlingStore.setDoNotContact({ organizationId: f.org, actorUserId: f.user, personId: person.id, enabled: true, reason: "Asked", now: f.clock() });
      await expectStoppedNow(f, run.id, "do_not_contact");
    });

    it("unsubscribe", async () => {
      const { f, run } = await withRun();
      const person = await personOf(f);
      await (await suppression()).suppressEmail({ organizationId: f.org, email: person.email.toUpperCase(), reason: "unsubscribed" });
      await expectStoppedNow(f, run.id, "unsubscribed");
    });

    it("bounce", async () => {
      const { f, run } = await withRun();
      const person = await personOf(f);
      await (await suppression()).suppressEmail({ organizationId: f.org, email: person.email, reason: "bounced", note: "Bounced" });
      await expectStoppedNow(f, run.id, "bounce");
    });

    it("manual suppression", async () => {
      const { f, run } = await withRun();
      const person = await personOf(f);
      await (await suppression()).suppressEmail({ organizationId: f.org, email: person.email, reason: "manual" });
      await expectStoppedNow(f, run.id, "suppressed");
    });

    it("the stop-request banner button", async () => {
      const { f, run } = await withRun();
      const conversation = await one("select id from conversations where organization_id = $1", [f.org]);
      await stores.replies.suppressSender({ organizationId: f.org, conversationId: conversation.id, actorUserId: f.user });
      await expectStoppedNow(f, run.id, "unsubscribed");
    });

    it("a person's move to a terminal subcategory", async () => {
      const { f, run } = await withRun();
      const record = await one("select id, context_version from records where organization_id = $1", [f.org]);
      const { drizzleReplyHandlingStore } = await import("../../../infrastructure/drizzle-reply-handling-store");
      await drizzleReplyHandlingStore.changeReplyType({
        organizationId: f.org,
        actorUserId: f.user,
        recordId: record.id,
        groupKey: "not_interested",
        replyTypeId: await replyTypeId(f.org, "not_required_right_now"),
        expectedContextVersion: record.context_version,
        confirmUnlock: false,
        note: null,
        occurredAt: f.clock(),
        now: f.clock(),
      });
      await expectStoppedNow(f, run.id, "stage_moved");
    });

    it("a person's classification into a terminal subcategory", async () => {
      const { f, run } = await withRun();
      const conversation = await one("select c.id, r.context_version from conversations c join records r on r.id = c.record_id where c.organization_id = $1", [f.org]);
      await stores.replies.applyHumanReplyTypePick({ organizationId: f.org, conversationId: conversation.id, replyTypeKey: "not_required_right_now", expectedContextVersion: conversation.context_version, actorUserId: f.user, wantsDraft: () => false });
      await expectStoppedNow(f, run.id, "classification_corrected");
    });

    it("a move to a non-terminal subcategory ends the run too (restart rules live in restart-record-work.integration.test.ts)", async () => {
      const { f, run } = await withRun();
      const record = await one("select id, context_version from records where organization_id = $1", [f.org]);
      const { drizzleReplyHandlingStore } = await import("../../../infrastructure/drizzle-reply-handling-store");
      // The run started on demo_request. Information requested is another non-terminal subcategory of the default pipeline.
      const other = await one("select id, group_key from reply_types where organization_id = $1 and key = 'information_requested'", [f.org]);
      expect(other).toBeDefined();
      expect(await one("select s.key from sequence_runs r join reply_types s on s.id = r.reply_type_id where r.id = $1", [run.id])).toMatchObject({ key: "demo_request" });
      await drizzleReplyHandlingStore.changeReplyType({
        organizationId: f.org,
        actorUserId: f.user,
        recordId: record.id,
        groupKey: other.group_key,
        replyTypeId: other.id,
        expectedContextVersion: record.context_version,
        confirmUnlock: false,
        note: null,
        occurredAt: f.clock(),
        now: f.clock(),
      });
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "interrupted" });
    });

    it("interruptOnTerminalStageTx reads the record's current type when the caller passes no decision", async () => {
      const { interruptOnTerminalStageTx } = await import("../sequence-run-tx");
      const { db } = await import("@/platform/db/client");
      const { f, run } = await withRun();
      const record = await one("select id from records where organization_id = $1", [f.org]);
      const ooo = await one("select id, group_key from reply_types where organization_id = $1 and key = 'out_of_office'", [f.org]);
      // Still on the type the run started on, which keeps going: nothing ends.
      expect(await db.transaction((tx) => interruptOnTerminalStageTx(tx, { organizationId: f.org, recordId: record.id, replyTypeId: run.reply_type_id, now: f.clock() }))).toBe(0);
      await sql`update records set group_key = ${ooo.group_key}, reply_type_id = ${ooo.id} where id = ${record.id}`;
      // The caller's decision wins over the stored rule.
      expect(await db.transaction((tx) => interruptOnTerminalStageTx(tx, { organizationId: f.org, recordId: record.id, replyTypeId: ooo.id, followUps: "continue", now: f.clock() }))).toBe(0);
      expect(await db.transaction((tx) => interruptOnTerminalStageTx(tx, { organizationId: f.org, recordId: record.id, replyTypeId: ooo.id, now: f.clock() }))).toBe(1);
      await expectStoppedNow(f, run.id, "terminal_stage");
    });

    it("another organization's person with the same address keeps its run", async () => {
      const a = await withRun();
      const b = await withRun();
      const person = await personOf(a.f);
      await sql`update people set email = ${person.email} where organization_id = ${b.f.org}`;
      await (await suppression()).suppressEmail({ organizationId: a.f.org, email: person.email, reason: "bounced" });
      expect(await one("select status from sequence_runs where id = $1", [a.run.id])).toMatchObject({ status: "interrupted" });
      expect(await one("select status from sequence_runs where id = $1", [b.run.id])).toMatchObject({ status: "active" });
    });
  });

  describe("a stop racing a due run", () => {
    /** Every draft of the run is retired or was never written once the run is stopped. */
    const expectNoLiveDraft = async (f: Fx, runId: string) => {
      expect(await one("select status from sequence_runs where id = $1", [runId])).toMatchObject({ status: "interrupted" });
      expect(await count("drafts", f.org, `status in ('generating', 'awaiting_review') and request->>'sequenceRunId' = '${runId}'`)).toBe(0);
      expect(await count("sequence_step_runs", f.org, "status in ('scheduled', 'drafting', 'awaiting_review')")).toBe(0);
    };

    /** Ticks with a draft writer that lets `beforeWrite` run first: the stop lands after the claim and before the draft. */
    async function dueRun() {
      const ctxRun = await withRun();
      const { f, run } = ctxRun;
      const first = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, first.id);
      await f.seqRun();
      f.state.offsetMs += 3 * DAY;
      // Only this organization has AI, so a due step another test left behind is released and this run's step is the one drafted.
      const resolver = replyAiResolverOf(async (o: string) => (o === f.org ? f.ai : null));
      const tickWith = (beforeWrite: () => Promise<void>) =>
        (seqJobsApp.createSequenceJobs({
          engine: stores.engine,
          runs: stores.runs,
          replies: { ...stores.replies, insertDraft: async (input) => (await beforeWrite(), stores.replies.insertDraft(input)) },
          ai: resolver,
          now: f.clock,
          workerId: "race",
          leaseMs: seqJobsApp.SEQUENCE_LEASE_MS,
          notConfiguredDelayMs: 60_000,
        }) as [Job])[0].run({ deadline: Date.now() + 60_000, now: f.clock });
      return { f, run, tickWith };
    }

    it("a stop between the claim and the draft write leaves no live draft", async () => {
      const { f, run, tickWith } = await dueRun();
      const person = await one("select email from people where organization_id = $1", [f.org]);
      const result = await tickWith(async () => {
        await (await (await import("@/test-support/suppression")).suppressionStore()).suppressEmail({ organizationId: f.org, email: person.email, reason: "unsubscribed" });
      });
      expect((result as { detail?: Record<string, number> }).detail).toMatchObject({ stopped_while_drafting: 1 });
      await expectNoLiveDraft(f, run.id);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
    });

    it("a stop between the draft write and the link retires the unlinked draft", async () => {
      const { f, run, tickWith } = await dueRun();
      const person = await one("select email from people where organization_id = $1", [f.org]);
      // The draft is written, then the stop lands, then the worker links.
      const realLink = stores.engine.linkDraft;
      let stopped = false;
      stores.engine.linkDraft = async (...args) => {
        if (!stopped) {
          stopped = true;
          await (await (await import("@/test-support/suppression")).suppressionStore()).suppressEmail({ organizationId: f.org, email: person.email, reason: "bounced" });
        }
        return realLink(...args);
      };
      try {
        await tickWith(async () => undefined);
      } finally {
        stores.engine.linkDraft = realLink;
      }
      await expectNoLiveDraft(f, run.id);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
    });

    it("real concurrent stops and ticks never leave a live draft for a stopped run", async () => {
      for (let i = 0; i < 6; i += 1) {
        const { f, run } = await dueRun();
        const person = await one("select id, email from people where organization_id = $1", [f.org]);
        const stop = async () => {
          if (i % 2 === 0) await (await (await import("@/test-support/suppression")).suppressionStore()).suppressEmail({ organizationId: f.org, email: person.email, reason: "unsubscribed" });
          else await (await import("../../../infrastructure/drizzle-reply-handling-store")).drizzleReplyHandlingStore.setDoNotContact({ organizationId: f.org, actorUserId: f.user, personId: person.id, enabled: true, reason: "Asked", now: f.clock() });
        };
        const delayed = async () => {
          await new Promise((r) => setTimeout(r, i * 7));
          await stop();
        };
        await Promise.all([f.seqRunAs("a"), f.seqRunAs("b"), delayed()]);
        await expectNoLiveDraft(f, run.id);
        expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      }
    }, 60_000);
  });

  describe("tenant isolation", () => {
    it("never shows or edits another organization's campaign flow", async () => {
      const a = await fixture();
      const b = await fixture();
      await ingest(a);
      await ingest(b);
      const campaignA = await emailedBy(a, { name: "Only A" });
      await emailedBy(b, { name: "Only B" });
      await expect(arApp.getCampaignAfterReply(b.arDeps, b.actor, campaignA)).rejects.toBeInstanceOf(NotFoundError);
      await expect(arApp.saveCampaignAfterReply(b.arDeps, b.actor, campaignA, { mode: "handoff" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(arApp.saveCampaignAfterReply(b.arDeps, b.actor, campaignA, { mode: "ai_drafts", steps: [STEPS[0]] })).rejects.toBeInstanceOf(NotFoundError);
      // A record of another organization is NotFound for every per-record control.
      const recordA = (await one("select id from records where organization_id = $1", [a.org])).id;
      await expect(seqApp.getRecordSequence(b.seqDeps, b.actor, recordA)).rejects.toBeInstanceOf(NotFoundError);
      await expect(seqApp.restartSequenceRun(b.seqDeps, b.actor, recordA)).rejects.toThrow();
      await expect(seqApp.pauseSequenceRun(b.seqDeps, b.actor, recordA)).rejects.toThrow();
      expect(await count("sequence_runs", a.org)).toBe(0);
      expect((await arApp.getCampaignAfterReply(a.arDeps, a.actor, campaignA)).mode).toBe("ai_drafts");
      expect(await one("select name from sequences where campaign_id = $1", [campaignA])).toMatchObject({ name: "Only A (after a reply)" });
    });

    it("keeps one organization's drafts and runs apart when both tick", async () => {
      const a = await withRun();
      const b = await withRun();
      expect(a.run.organization_id).toBe(a.f.org);
      expect(b.run.organization_id).toBe(b.f.org);
      expect(await count("sequence_runs", a.f.org)).toBe(1);
      expect(await count("sequence_runs", b.f.org)).toBe(1);
      expect(a.run.sequence_id).not.toBe(b.run.sequence_id);
    });
  });

  describe("two workers", () => {
    it("draft one due step once and start one run per reply", async () => {
      const f = await fixture();
      await ingest(f);
      await emailedBy(f);
      await f.aiRun();
      // Two workers race to start the run and to adopt the reply draft.
      await Promise.all([f.seqRunAs("a"), f.seqRunAs("b"), f.seqRunAs("c")]);
      expect(await count("sequence_runs", f.org)).toBe(1);
      expect(await count("sequence_step_runs", f.org)).toBe(3);
      expect(await count("sequence_step_runs", f.org, "draft_id is not null")).toBe(1);

      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, draft.id);
      await f.seqRun();
      f.state.offsetMs += 3 * DAY;
      const before = f.ai.draftCalls;
      await Promise.all([f.seqRunAs("a"), f.seqRunAs("b"), f.seqRunAs("c"), f.seqRunAs("d")]);
      expect(f.ai.draftCalls).toBe(before + 1);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
      expect(await count("sequence_step_runs", f.org, "status = 'awaiting_review'")).toBe(1);
      // Running again changes nothing.
      await f.seqRun();
      expect(f.ai.draftCalls).toBe(before + 1);
      expect(await count("sequence_runs", f.org)).toBe(1);
    });

    it("takes over a step whose worker died while drafting", async () => {
      const { f, run } = await withRun();
      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, draft.id);
      await f.seqRun();
      f.state.offsetMs += 3 * DAY;
      await sql`update sequence_step_runs set status = 'drafting', attempt_count = 1, updated_at = ${f.clock()} where sequence_run_id = ${run.id} and status = 'scheduled' and due_at <= ${f.clock()}`;
      await f.seqRun();
      expect(await count("sequence_step_runs", f.org, "status = 'awaiting_review'")).toBe(0);
      f.state.offsetMs += 11 * 60_000;
      await f.seqRun();
      expect(await count("sequence_step_runs", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("relinks a draft that a crash left unlinked instead of writing a second", async () => {
      const { f, run } = await withRun();
      const draft = await one("select id from drafts where organization_id = $1", [f.org]);
      await approve(f, draft.id);
      await f.seqRun();
      f.state.offsetMs += 3 * DAY;
      await f.seqRun();
      const created = await one("select id, request from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      // Simulate the crash: the step lost its link and sits as drafting past its lease.
      await sql`update sequence_step_runs set status = 'drafting', draft_id = null, updated_at = ${new Date(f.clock().getTime() - 3600_000)} where id = ${created.request.sequenceStepRunId}`;
      const calls = f.ai.draftCalls;
      await f.seqRun();
      expect(f.ai.draftCalls).toBe(calls);
      expect(await one("select status, draft_id from sequence_step_runs where id = $1", [created.request.sequenceStepRunId])).toMatchObject({ status: "awaiting_review", draft_id: created.id });
      expect(await count("drafts", f.org)).toBe(2);
      void run;
    });
  });

  describe("per-record controls", () => {
    it("pauses, resumes, skips and cancels", async () => {
      const { f, run } = await withRun();
      const recordId = run.record_id;
      await seqApp.pauseSequenceRun(f.seqDeps, f.actor, recordId);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "paused" });
      // The reply draft is retired and its step is back to scheduled.
      expect(await count("drafts", f.org, "status = 'stale'")).toBe(1);
      f.state.offsetMs += 10 * DAY;
      await f.seqRun();
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      await expect(seqApp.pauseSequenceRun(f.seqDeps, f.actor, recordId)).rejects.toBeInstanceOf(ConflictError);

      await seqApp.resumeSequenceRun(f.seqDeps, f.actor, recordId);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "active" });
      await f.seqRun();
      // The reply is drafted afresh.
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);

      const skipped = await seqApp.skipSequenceStep(f.seqDeps, f.actor, recordId);
      expect(skipped).toEqual({ skipped: 1, next: 2 });
      expect(await count("drafts", f.org, "status = 'discarded'")).toBe(1);

      await seqApp.cancelSequenceRun(f.seqDeps, f.actor, recordId);
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "cancelled" });
      expect(await count("sequence_step_runs", f.org, "status in ('scheduled', 'drafting', 'awaiting_review')")).toBe(0);
      await expect(seqApp.cancelSequenceRun(f.seqDeps, f.actor, recordId)).rejects.toBeInstanceOf(ConflictError);
    });

    it("reads the record's campaign and run with labels", async () => {
      const { f, run, campaignId } = await withRun();
      const state = await seqApp.getRecordSequence(f.seqDeps, f.actor, run.record_id);
      expect(state.campaign).toMatchObject({ id: campaignId, mode: "ai_drafts" });
      expect(state.run).toMatchObject({ id: run.id, status: "active", statusLabel: "Running", startedBy: "ai_assignment", startedByLabel: "Automatic", version: 1, totalSteps: 3, currentStepPosition: 1, endedReason: null, endedReasonLabel: null });
      expect(state.run?.steps.map((x) => x.status)).toEqual(["awaiting_review", "scheduled", "scheduled"]);
      await seqApp.cancelSequenceRun(f.seqDeps, f.actor, run.record_id);
      const ended = await seqApp.getRecordSequence(f.seqDeps, f.actor, run.record_id);
      expect(ended.run).toMatchObject({ status: "cancelled", endedReason: "manual", endedReasonLabel: "A person cancelled the follow-ups" });
    });

    it("names the owning campaign for a record that never had a run", async () => {
      const f = await fixture();
      await ingest(f);
      const campaignId = await emailedBy(f, { steps: null });
      const record = (await one("select id from records where organization_id = $1", [f.org])).id;
      const state = await seqApp.getRecordSequence(f.seqDeps, f.actor, record);
      expect(state).toMatchObject({ run: null, campaign: { id: campaignId, mode: "handoff" } });
    });
  });

  describe("a contact", () => {
    const makeContact = (personId: string) => sql`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;

    /** A contact (inserted as one, as support SQL may) whose reply arrives after a campaign emailed them. */
    async function contactWhoReplies() {
      const f = await fixture();
      const email = `contact-${f.tag}@acme.test`;
      const [{ id: personId }] = await sql`insert into people (organization_id, email, full_name, lifecycle, converted_at) values (${f.org}, ${email}, 'Cora Contact', 'contact', now()) returning id`;
      const input = mail(f, { from: { email, name: "Cora Contact" } });
      await composition.ingestInbound(input);
      await emailedBy(f, { personId });
      await f.cycle();
      return { f, personId };
    }

    it("has its reply stored, classified and queued for a person, and starts no run", async () => {
      const { f, personId } = await contactWhoReplies();
      expect(await count("people", f.org)).toBe(1);
      expect(await one("select lifecycle from people where id = $1", [personId])).toMatchObject({ lifecycle: "contact" });
      expect(await count("messages", f.org, "direction = 'inbound'")).toBe(1);
      expect(await count("reply_type_picks", f.org, "status in ('auto_applied', 'proposed')")).toBe(1);
      expect(await one("select workflow_state, group_key from records where organization_id = $1", [f.org])).toMatchObject({ workflow_state: "action_required", group_key: "interested" });
      // The Inbox reply draft still waits for approval.
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
      expect(await count("sequence_runs", f.org)).toBe(0);
      f.state.offsetMs += 10 * DAY;
      await f.cycle();
      expect(await count("sequence_runs", f.org)).toBe(0);
    });

    it("is left out of the start candidates and the start facts, and a lead is not", async () => {
      // The contact's cycle runs first: a cycle starts runs for every organization, so the lead's reply must come after it.
      const { f } = await contactWhoReplies();
      const lead = await fixture();
      await ingest(lead);
      await emailedBy(lead);
      await lead.aiRun();
      const leadRecord = (await one("select id from records where organization_id = $1", [lead.org])).id as string;
      const record = (await one("select id from records where organization_id = $1", [f.org])).id as string;

      const candidates = await stores.engine.startCandidates(1000);
      expect(candidates.filter((c) => c.organizationId === lead.org).map((c) => c.recordId)).toEqual([leadRecord]);
      expect(candidates.filter((c) => c.organizationId === f.org)).toEqual([]);
      expect((await stores.runs.loadStart(lead.org, leadRecord, {}))?.contact).toBe(false);
      expect((await stores.runs.loadStart(f.org, record, {}))?.contact).toBe(true);
      expect(await seqApp.attemptRun({ runs: stores.runs, now: f.clock }, { organizationId: f.org, recordId: record, source: "ai_assignment" })).toEqual({ blocked: "The person is a contact, so follow-ups do not apply." });
    });

    it("has its active run interrupted by the sweep with the converted reason, and a lead's run is left alone", async () => {
      const converted = await withRun();
      const lead = await withRun();
      const personId = (await one("select person_id from records where id = $1", [converted.run.record_id])).person_id as string;
      await makeContact(personId);

      await converted.f.seqRun();
      expect(await one("select status from sequence_runs where id = $1", [converted.run.id])).toMatchObject({ status: "interrupted" });
      expect(await count("events", converted.f.org, "event_type = 'sequence.interrupted' and meta->>'reason' = 'converted'")).toBe(1);
      expect(await count("drafts", converted.f.org, "status = 'awaiting_review'")).toBe(0);
      expect(await count("sequence_step_runs", converted.f.org, "status in ('scheduled', 'drafting', 'awaiting_review')")).toBe(0);
      expect(await one("select status from sequence_runs where id = $1", [lead.run.id])).toMatchObject({ status: "active" });
      expect(await count("drafts", lead.f.org, "status = 'awaiting_review'")).toBe(1);
      expect(await count("events", lead.f.org, "event_type = 'sequence.interrupted'")).toBe(0);
    });

    it("keeps a paused run from surviving the sweep too", async () => {
      const { f, run } = await withRun();
      await seqApp.pauseSequenceRun(f.seqDeps, f.actor, run.record_id);
      await makeContact((await one("select person_id from records where id = $1", [run.record_id])).person_id as string);
      await f.seqRun();
      expect(await one("select status from sequence_runs where id = $1", [run.id])).toMatchObject({ status: "interrupted" });
      expect(await count("events", f.org, "event_type = 'sequence.interrupted' and meta->>'reason' = 'converted'")).toBe(1);
    });
  });
});
