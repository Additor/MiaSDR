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
vi.mock("../../after-reply/infrastructure/drizzle-sequence-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../after-reply/infrastructure/drizzle-sequence-store")>();
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
describeDb("restart record work: stage move, correction, stale drafts", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  let composition: typeof import("../composition");
  let mgmt: typeof import("../../application/reply-management");
  let aiJobsApp: typeof import("../../ai/application/ai-jobs");
  let arApp: typeof import("../../after-reply/application/after-reply");
  let seqJobsApp: typeof import("../../after-reply/application/sequence-jobs");
  let replyHandlingApp: typeof import("../../application/reply-handling");
  let stores: {
    jobs: typeof import("../../ai/infrastructure/drizzle-ai-job-store").drizzleAiJobStore;
    replies: typeof import("../drizzle-reply-store").drizzleReplyStore;
    flows: typeof import("../../after-reply/infrastructure/drizzle-sequence-store").drizzleAfterReplyStore;
    runs: typeof import("../../after-reply/infrastructure/drizzle-sequence-store").drizzleRunStore;
    engine: typeof import("../../after-reply/infrastructure/drizzle-sequence-engine").drizzleSequenceEngine;
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
    const [aiTick] = aiJobsApp.createAiJobs({ jobs: stores.jobs, replies: stores.replies, ai: resolver, now: clock, workerId: "ai", leaseMs: aiJobsApp.AI_JOB_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const [seqTick] = seqJobsApp.createSequenceJobs({ engine: stores.engine, runs: stores.runs, replies: stores.replies, ai: resolver, now: clock, workerId: "w1", leaseMs: seqJobsApp.SEQUENCE_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const ctx = () => ({ deadline: Date.now() + 60_000, now: clock });
    const replyDeps = { store: stores.replies, ai: resolver, mailer: createReplyMailer(() => mailbox), now: clock, newToken: () => `tok-${Math.random().toString(36).slice(2)}` };
    const seqDeps = { runs: stores.runs, now: clock };
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
      seqDeps,
      arDeps,
      replyHandlingDeps,
      aiRun: () => aiTick.run(ctx()),
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
   * steps) unless `flow` is false. After one cycle the record sits in demo_request with an active run and its reply draft.
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
    const record = await one("select id, context_version from records where organization_id = $1", [f.org]);
    const flow = await one("select id from sequences where campaign_id = $1", [campaignId]).catch(() => undefined);
    return { f, r, input, campaignId, flowId: flow?.id as string | undefined, recordId: record.id as string, version: Number(record.context_version) };
  }

  const move = async (f: Fx, recordId: string, key: string, expectedContextVersion: number, note: string | null = null) => {
    const target = await sub(f.org, key);
    return replyHandlingApp.changeReplyType(f.replyHandlingDeps, f.actor, recordId, { groupKey: target.group_key, replyTypeId: target.id, expectedContextVersion, note });
  };
  const versionOf = async (recordId: string) => Number((await one("select context_version from records where id = $1", [recordId])).context_version);

  beforeAll(async () => {
    composition = await import("../composition");
    mgmt = await import("../../application/reply-management");
    aiJobsApp = await import("../../ai/application/ai-jobs");
    arApp = await import("../../after-reply/application/after-reply");
    seqJobsApp = await import("../../after-reply/application/sequence-jobs");
    replyHandlingApp = await import("../../application/reply-handling");
    const seqStore = await import("../../after-reply/infrastructure/drizzle-sequence-store");
    stores = {
      jobs: (await import("../../ai/infrastructure/drizzle-ai-job-store")).drizzleAiJobStore,
      replies: (await import("../drizzle-reply-store")).drizzleReplyStore,
      flows: seqStore.drizzleAfterReplyStore,
      runs: seqStore.drizzleRunStore,
      engine: (await import("../../after-reply/infrastructure/drizzle-sequence-engine")).drizzleSequenceEngine,
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

  describe("stage move", () => {
    it("ends the old run, retires its draft, bumps the version and starts a fresh run of the campaign flow in one commit", async () => {
      const { f, recordId, version, flowId } = await withRun();
      const old = await one("select id, status from sequence_runs where organization_id = $1", [f.org]);
      expect(old.status).toBe("active");
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);

      const result = await move(f, recordId, "meeting_done", version, "Call went well");
      expect(result.contextVersion).toBe(version + 1);
      expect(await versionOf(recordId)).toBe(version + 1);

      expect(await one("select status from sequence_runs where id = $1", [old.id])).toMatchObject({ status: "interrupted" });
      expect(await count("events", f.org, "event_type = 'sequence.interrupted' and meta->>'reason' = 'stage_moved'")).toBe(1);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(0);
      expect(await one("select status, error from drafts where organization_id = $1", [f.org])).toMatchObject({ status: "stale", error: "A person changed the reply type after this draft was written." });
      expect(await count("sequence_step_runs", f.org, `sequence_run_id = '${old.id}' and status in ('scheduled', 'drafting', 'awaiting_review')`)).toBe(0);

      const runs = await rows("select id, sequence_id, status, reply_type_id, trigger_message_id from sequence_runs where organization_id = $1 and status = 'active'", [f.org]);
      expect(runs).toHaveLength(1);
      expect(runs[0].sequence_id).toBe(flowId);
      expect(runs[0].id).not.toBe(old.id);
      expect(runs[0].reply_type_id).toBe((await sub(f.org, "meeting_done")).id);
      expect(await count("sequence_step_runs", f.org, `sequence_run_id = '${runs[0].id}'`)).toBe(2);
      expect(await one("select expected_context_version from sequence_step_runs where sequence_run_id = $1 limit 1", [runs[0].id])).toMatchObject({ expected_context_version: version + 1 });

      // The next sequence tick drafts the new run's reply step.
      await f.cycle();
      const fresh = await one("select expected_context_version, status, request from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      expect(fresh.expected_context_version).toBe(version + 1);
      expect(f.ai.lastDraftInput?.operatorInstructions).toContain("Flow: answer.");
    });

    it("a record with only private conversations still moves by the type's rules", async () => {
      const { f, recordId, version } = await withRun();
      const personal = await createCampaign(sql, { organizationId: f.org, channel: "linkedin", type: "personal" });
      await sql`update conversations set private_campaign_id = ${personal} where record_id = ${recordId}`;
      const result = await move(f, recordId, "meeting_done", version);
      // Meeting done writes a draft: the record stays in front of a person, as on a public record.
      expect(await one("select workflow_state from records where id = $1", [recordId])).toMatchObject({ workflow_state: "action_required" });
      // The old run ends. The new run start reads only public conversations, so a private-only record starts none.
      expect(result.runStarted).toBe(false);
      expect(await count("sequence_runs", f.org, "status = 'active'")).toBe(0);
    });

    it("starts no run for a contact, and still moves the category", async () => {
      const { f, recordId, version } = await withRun();
      const personId = (await one("select person_id from records where id = $1", [recordId])).person_id as string;
      await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;

      const result = await move(f, recordId, "meeting_done", version, "Call went well");
      expect(result.contextVersion).toBe(version + 1);
      expect(await one("select context_version, reply_type_id from records where id = $1", [recordId])).toMatchObject({ context_version: version + 1, reply_type_id: (await sub(f.org, "meeting_done")).id });
      expect(await count("sequence_runs", f.org)).toBe(1);
      expect(await count("sequence_runs", f.org, "status = 'active'")).toBe(0);
      expect(await count("events", f.org, "event_type = 'sequence.started'")).toBe(1);
      expect(await count("events", f.org, "event_type = 'sequence.interrupted' and meta->>'reason' = 'stage_moved'")).toBe(1);
    });

    it("starts no run for a contact whose record never had one", async () => {
      const { f, recordId, version } = await withRun({ flow: false });
      const personId = (await one("select person_id from records where id = $1", [recordId])).person_id as string;
      await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;
      await move(f, recordId, "meeting_done", version);
      expect(await versionOf(recordId)).toBe(version + 1);
      expect(await count("sequence_runs", f.org)).toBe(0);
    });

    it("ends the run and starts nothing when the new subcategory is terminal", async () => {
      const { f, recordId, version } = await withRun();
      await move(f, recordId, "not_required_right_now", version);
      expect(await count("sequence_runs", f.org, "status = 'active'")).toBe(0);
      expect(await count("sequence_runs", f.org, "status = 'interrupted'")).toBe(1);
      expect(await count("sequence_runs", f.org)).toBe(1);
    });

    it("ends the run and starts nothing when the campaign has After a reply off", async () => {
      const { f, recordId, version, campaignId } = await withRun();
      await arApp.saveCampaignAfterReply(f.arDeps, f.actor, campaignId, { mode: "handoff", confirmStopRuns: true });
      await move(f, recordId, "meeting_done", version);
      expect(await count("sequence_runs", f.org, "status = 'active'")).toBe(0);
      expect(await count("sequence_runs", f.org)).toBe(1);
    });

    it("a replay with the old version answers 409 and starts nothing twice", async () => {
      const { f, recordId, version } = await withRun();
      await move(f, recordId, "meeting_done", version);
      const before = { runs: await count("sequence_runs", f.org), events: await count("events", f.org, "event_type = 'reply_type.changed'"), version: await versionOf(recordId) };
      await expect(move(f, recordId, "meeting_done", version)).rejects.toBeInstanceOf(ConflictError);
      expect({ runs: await count("sequence_runs", f.org), events: await count("events", f.org, "event_type = 'reply_type.changed'"), version: await versionOf(recordId) }).toEqual(before);
    });

    it("rolls the move back when the run cannot start", async () => {
      const { f, recordId, version } = await withRun();
      // A broken start must not leave a half-moved record: the new run's row goes in, then its write fails.
      const target = await sub(f.org, "meeting_done");
      fault.createRun = new Error("the run write failed");
      try {
        await expect(move(f, recordId, "meeting_done", version)).rejects.toThrow("the run write failed");
      } finally {
        fault.createRun = null;
      }
      expect(await count("sequence_runs", f.org)).toBe(1);
      const record = await one("select context_version, reply_type_id from records where id = $1", [recordId]);
      expect(Number(record.context_version)).toBe(version);
      expect(record.reply_type_id).not.toBe(target.id);
      expect(await count("sequence_runs", f.org, "status = 'active'")).toBe(1);
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("does not touch another organization", async () => {
      const a = await withRun();
      const b = await withRun();
      await move(a.f, a.recordId, "meeting_done", a.version);
      expect(await count("sequence_runs", b.f.org, "status = 'active'")).toBe(1);
      expect(await count("drafts", b.f.org, "status = 'awaiting_review'")).toBe(1);
      expect(await versionOf(b.recordId)).toBe(b.version);
      await expect(replyHandlingApp.changeReplyType(a.f.replyHandlingDeps, b.f.actor, a.recordId, { groupKey: "interested", replyTypeId: null, expectedContextVersion: a.version + 1 })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("replyTypeChange in the draft prompt", () => {
    it("passes the move's stage, time and note to the model and drops the classifier's reason", async () => {
      const { f, r, recordId, version } = await withRun({ flow: false });
      await move(f, recordId, "meeting_done", version, "Met on Tuesday, they want the contract");
      await mgmt.requestDraft(f.replyDeps, f.actor, r.conversationId);
      const input = f.ai.lastDraftInput!;
      expect(input.replyTypeChange).toMatchObject({ stage: "After a meeting", note: "Met on Tuesday, they want the contract" });
      expect(input.replyTypeChange!.occurredAt).toBeInstanceOf(Date);
      // The classifier read the old inbound message; that reading is stale after the move.
      expect(input.classification?.reason).toBeNull();
    });

    it("leaves replyTypeChange null with no move, and ignores a move that came before the last inbound message", async () => {
      const { f, r, input, recordId, version } = await withRun({ flow: false });
      // The drafts written before any move carry no stage change.
      expect(f.ai.lastDraftInput).not.toBeNull();
      expect(f.ai.lastDraftInput?.replyTypeChange).toBeNull();

      await move(f, recordId, "meeting_done", version, "Old note");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await composition.ingestInbound(mail(f, { providerThreadId: input.providerThreadId, bodyText: "Actually one more question." }));
      const panel = await mgmt.getReplyPanel(f.replyDeps, f.actor, r.conversationId);
      expect(panel?.draft?.status).toBe("stale");
      await mgmt.requestDraft(f.replyDeps, f.actor, r.conversationId);
      expect(f.ai.lastDraftInput?.replyTypeChange).toBeNull();
      expect(f.ai.lastDraftInput?.classification?.reason ?? "kept").not.toBeNull();
    });

    it("takes the newest of several moves", async () => {
      const { f, r, recordId, version } = await withRun({ flow: false });
      await move(f, recordId, "meeting_done", version, "first");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await move(f, recordId, "trial_requested", version + 1, "second");
      await mgmt.requestDraft(f.replyDeps, f.actor, r.conversationId);
      expect(f.ai.lastDraftInput?.replyTypeChange).toMatchObject({ note: "second" });
    });
  });

  describe("human correction", () => {
    it("answers 409 on a version mismatch and changes nothing", async () => {
      const { f, r, recordId, version } = await withRun();
      const before = { runs: await count("sequence_runs", f.org), jobs: await count("ai_jobs", f.org), drafts: await count("drafts", f.org, "status = 'awaiting_review'") };
      await expect(mgmt.setReplyType(f.replyDeps, f.actor, r.conversationId, { replyTypeKey: "meeting_done", expectedContextVersion: version - 1 })).rejects.toBeInstanceOf(ConflictError);
      await expect(mgmt.setReplyType(f.replyDeps, f.actor, r.conversationId, { replyTypeKey: "meeting_done", expectedContextVersion: version + 1 })).rejects.toBeInstanceOf(ConflictError);
      expect(await versionOf(recordId)).toBe(version);
      expect({ runs: await count("sequence_runs", f.org), jobs: await count("ai_jobs", f.org), drafts: await count("drafts", f.org, "status = 'awaiting_review'") }).toEqual(before);
    });

    it("bumps the version, retires the draft, swaps the run and writes a fresh draft for the corrected category", async () => {
      const { f, r, recordId, version, flowId } = await withRun();
      const stale = await one("select id from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      const result = await mgmt.setReplyType(f.replyDeps, f.actor, r.conversationId, { replyTypeKey: "meeting_done", expectedContextVersion: version });
      expect(result).toMatchObject({ replyTypeKey: "meeting_done", draftQueued: true });
      expect(await versionOf(recordId)).toBe(version + 1);
      expect(await one("select status, error from drafts where id = $1", [stale.id])).toMatchObject({ status: "stale", error: "A person corrected the reply type after this draft was written." });
      expect(await count("events", f.org, "event_type = 'sequence.interrupted' and meta->>'reason' = 'classification_corrected'")).toBe(1);
      const active = await rows("select sequence_id from sequence_runs where organization_id = $1 and status = 'active'", [f.org]);
      expect(active.map((a) => a.sequence_id)).toEqual([flowId]);
      // The classification row moved to the new version, so the draft job accepts it.
      expect(await one("select expected_context_version, status from reply_type_picks where organization_id = $1", [f.org])).toMatchObject({ expected_context_version: version + 1 });

      await f.aiRun();
      const fresh = await rows("select id, status, expected_context_version from drafts where organization_id = $1 and status = 'awaiting_review' order by created_at", [f.org]);
      expect(fresh.length).toBeGreaterThanOrEqual(1);
      expect(fresh.every((d) => d.expected_context_version === version + 1)).toBe(true);
      expect(fresh.some((d) => d.id === stale.id)).toBe(false);
      expect(f.ai.lastDraftInput?.classification?.replyTypeName).toBe("After a meeting");
      // The panel shows the fresh draft, not the retired one.
      const panel = await mgmt.getReplyPanel(f.replyDeps, f.actor, r.conversationId);
      expect(panel?.draft?.status).toBe("awaiting_review");
      expect(panel?.contextVersion).toBe(version + 1);
    });

    it("replaying the same correction answers 409 and queues nothing more", async () => {
      const { f, r, version } = await withRun();
      await mgmt.setReplyType(f.replyDeps, f.actor, r.conversationId, { replyTypeKey: "meeting_done", expectedContextVersion: version });
      const before = { runs: await count("sequence_runs", f.org), jobs: await count("ai_jobs", f.org), events: await count("events", f.org) };
      await expect(mgmt.setReplyType(f.replyDeps, f.actor, r.conversationId, { replyTypeKey: "meeting_done", expectedContextVersion: version })).rejects.toBeInstanceOf(ConflictError);
      expect({ runs: await count("sequence_runs", f.org), jobs: await count("ai_jobs", f.org), events: await count("events", f.org) }).toEqual(before);
    });

    it("a second correction after the first queues its own draft job", async () => {
      const { f, r, version } = await withRun();
      await mgmt.setReplyType(f.replyDeps, f.actor, r.conversationId, { replyTypeKey: "meeting_done", expectedContextVersion: version });
      await f.aiRun();
      await mgmt.setReplyType(f.replyDeps, f.actor, r.conversationId, { replyTypeKey: "demo_request", expectedContextVersion: version + 1 });
      expect(await count("ai_jobs", f.org, "kind = 'initial_draft' and status = 'queued'")).toBe(1);
      await f.aiRun();
      expect(await one("select expected_context_version from drafts where organization_id = $1 and status = 'awaiting_review' order by created_at desc limit 1", [f.org])).toMatchObject({ expected_context_version: version + 2 });
    });

    it("another organization's person gets 404", async () => {
      const a = await withRun();
      const b = await withRun();
      await expect(mgmt.setReplyType(b.f.replyDeps, b.f.actor, a.r.conversationId, { replyTypeKey: "meeting_done", expectedContextVersion: a.version })).rejects.toBeInstanceOf(NotFoundError);
      expect(await versionOf(a.recordId)).toBe(a.version);
    });
  });

  describe("stale drafts on a new inbound message", () => {
    it("marks the open draft stale in the ingest transaction, shows it as out of date, and refuses to send it", async () => {
      const { f, r, input } = await withRun();
      const draft = await one("select id, revision from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      await composition.ingestInbound(mail(f, { providerThreadId: input.providerThreadId, bodyText: "One more thing." }));
      expect(await one("select status, error from drafts where id = $1", [draft.id])).toMatchObject({ status: "stale", error: "A newer message arrived after this draft was written." });
      const panel = await mgmt.getReplyPanel(f.replyDeps, f.actor, r.conversationId);
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
      const { f, recordId } = await withRun();
      const draft = await one("select id, revision from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      await sql`update records set context_version = context_version + 1 where id = ${recordId}`;
      await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: sendKey() })).rejects.toBeInstanceOf(ConflictError);
      expect(await one("select status from drafts where id = $1", [draft.id])).toMatchObject({ status: "stale" });
    });

    it("keeps the compose rule: a manual draft supersedes the out-of-date one and is the one the panel shows", async () => {
      const { f, r, input } = await withRun();
      const old = await one("select id from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
      await composition.ingestInbound(mail(f, { providerThreadId: input.providerThreadId, bodyText: "Following up." }));
      const created = await mgmt.createManualDraft(f.replyDeps, f.actor, r.conversationId, { subject: "Re: hello", bodyText: "Typed by a person." });
      expect(await one("select status from drafts where id = $1", [old.id])).toMatchObject({ status: "stale" });
      const panel = await mgmt.getReplyPanel(f.replyDeps, f.actor, r.conversationId);
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
