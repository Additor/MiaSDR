import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@/shared/errors";
import type { NewRun, RunStore, StartFacts } from "./sequence-ports";
import { attemptRun, getRecordSequence, restartSequenceRun, startBlocker, startRun } from "./sequences";

const NOW = new Date("2026-10-15T09:00:00Z");

function facts(over: Partial<StartFacts> = {}): StartFacts {
  return {
    organizationId: "org",
    record: {
      id: "rec1",
      personId: "p1",
      replyTypeId: "sub1",
      groupKey: "interested",
      replyTypeKey: "demo_request",
      replyTypeName: "Demo request",
      followUps: "continue",
      replyDraft: true,
      latestInboundMessageId: "m1",
      lastInboundAt: new Date("2026-10-15T08:00:00Z"),
      lastOutboundAt: null,
      contextVersion: 1,
      workflowState: "action_required",
      hasEmail: true,
      stopRequested: false,
    },
    doNotContact: false,
    suppressed: false,
    contact: false,
    owner: { id: "camp", name: "Autumn", channel: "email", type: "regular", status: "active", archived: false },
    flow: { status: "active", hasPublished: true },
    conversation: { id: "c1", recordId: "rec1", channel: "email" },
    selection: { sequenceId: "seq", sequenceVersionId: "v1", campaignId: "camp" },
    steps: [
      { id: "s1", sequenceVersionId: "v1", position: 1, delayMinutes: 0 },
      { id: "s2", sequenceVersionId: "v1", position: 2, delayMinutes: 2880 },
    ],
    timeZone: "UTC",
    ...over,
  };
}

function store(f: StartFacts | null) {
  const created: NewRun[] = [];
  const runs = {
    loadStart: async () => f,
    createRun: async (run: NewRun) => {
      created.push(run);
      return { runId: "run1", created: true };
    },
  } as unknown as RunStore;
  return { runs, created, deps: { runs, now: () => NOW } };
}

describe("startRun invariants", () => {
  it("pins the run to the selected version and schedules each step", async () => {
    const s = store(facts());
    const result = await startRun(s.deps, { organizationId: "org", recordId: "rec1", source: "ai_assignment" });
    expect(result).toEqual({ runId: "run1", created: true });
    expect(s.created[0]).toMatchObject({ sequenceVersionId: "v1", startPosition: 1, triggerMessageId: "m1", conversationId: "c1" });
    expect(s.created[0].steps.map((x) => [x.position, x.dueAt.toISOString()])).toEqual([
      [1, "2026-10-15T09:00:00.000Z"],
      [2, "2026-10-17T09:00:00.000Z"],
    ]);
  });

  it("starts nothing for a contact, whatever else allows it", async () => {
    const s = store(facts({ contact: true }));
    expect(await attemptRun(s.deps, { organizationId: "org", recordId: "rec1", source: "ai_assignment" })).toEqual({ blocked: "The person is a contact, so follow-ups do not apply." });
    expect(await startRun(s.deps, { organizationId: "org", recordId: "rec1", source: "human_override", restart: true })).toBeNull();
    expect(s.created).toHaveLength(0);
  });

  it("refuses a conversation that belongs to another record", async () => {
    const s = store(facts({ conversation: { id: "c9", recordId: "other", channel: "email" } }));
    await expect(startRun(s.deps, { organizationId: "org", recordId: "rec1", conversationId: "c9", source: "human_override" })).rejects.toBeInstanceOf(ConflictError);
    expect(s.created).toHaveLength(0);
  });

  it("refuses a step that belongs to another version than the pinned one", async () => {
    const s = store(
      facts({
        steps: [
          { id: "s1", sequenceVersionId: "v1", position: 1, delayMinutes: 0 },
          { id: "s2", sequenceVersionId: "v0", position: 2, delayMinutes: 60 },
        ],
      }),
    );
    await expect(startRun(s.deps, { organizationId: "org", recordId: "rec1", source: "ai_assignment" })).rejects.toThrow(/pinned/);
    expect(s.created).toHaveLength(0);
  });

  it("starts at the first follow-up when a person already replied", async () => {
    const f = facts();
    f.record.lastOutboundAt = new Date("2026-10-15T08:30:00Z");
    const s = store(f);
    await startRun(s.deps, { organizationId: "org", recordId: "rec1", source: "ai_assignment" });
    expect(s.created[0].startPosition).toBe(2);
    expect(s.created[0].steps.map((x) => x.position)).toEqual([2]);
  });

  it("starts nothing for a type set to stop follow-ups, a non-email reply or no sequence", async () => {
    const terminal = facts();
    terminal.record.groupKey = "not_interested";
    terminal.record.replyTypeKey = "not_required_right_now";
    terminal.record.followUps = "stop";
    const ooo = facts();
    ooo.record.groupKey = "other";
    ooo.record.replyTypeKey = "out_of_office";
    ooo.record.followUps = "stop";
    const cases = [terminal, ooo, facts({ conversation: { id: "c1", recordId: "rec1", channel: "linkedin" } }), facts({ selection: null })];
    for (const f of cases) {
      const s = store(f);
      expect(await startRun(s.deps, { organizationId: "org", recordId: "rec1", source: "ai_assignment" })).toBeNull();
      expect(s.created).toHaveLength(0);
    }
  });
});

describe("restartSequenceRun", () => {
  const actor = { userId: "u1", organizationId: "org", role: "member" };

  it("starts a human run that replaces an identical one in progress", async () => {
    const s = store(facts());
    const result = await restartSequenceRun(s.deps, actor, "rec1");
    expect(result).toEqual({ runId: "run1", created: true });
    expect(s.created[0]).toMatchObject({ source: "human_override", restart: true, actorUserId: "u1", sequenceId: "seq" });
  });

  it("answers a conflict when the owning campaign has no flow to run", async () => {
    const s = store(facts({ selection: null, steps: [], flow: null }));
    await expect(restartSequenceRun(s.deps, actor, "rec1")).rejects.toBeInstanceOf(ConflictError);
    expect(s.created).toHaveLength(0);
  });

  /** Each cause answers a 409 that names it, and the record page shows the same words. */
  const causes: Array<[string, Partial<StartFacts>, RegExp]> = [
    ["the campaign is paused", { owner: { id: "camp", name: "Autumn", channel: "email", type: "regular", status: "paused", archived: false }, selection: null }, /Autumn is paused\. Resume it/],
    ["the campaign has not started", { owner: { id: "camp", name: "Autumn", channel: "email", type: "regular", status: "draft", archived: false }, selection: null }, /Autumn has not started yet/],
    ["the campaign is archived", { owner: { id: "camp", name: "Autumn", channel: "email", type: "regular", status: "active", archived: true }, selection: null }, /Autumn is archived/],
    ["AI drafts are off", { flow: { status: "archived", hasPublished: true }, selection: null }, /AI drafts are off for the campaign Autumn/],
    ["AI drafts were never turned on", { flow: null, selection: null }, /AI drafts are off for the campaign Autumn/],
    ["the flow has no published steps", { flow: { status: "active", hasPublished: false }, selection: null }, /no published follow-up steps/],
    ["no campaign emailed the person", { owner: null, flow: null, selection: null }, /No campaign has emailed this person/],
    ["the reply type stops follow-ups", { record: { ...facts().record, groupKey: "not_interested", replyTypeKey: "not_required_right_now", replyTypeName: "Not now", followUps: "stop" } }, /^Not now is set to stop follow-ups\.$/],
    ["the person is marked do not contact", { doNotContact: true }, /marked do not contact/],
    ["the address is suppressed", { suppressed: true }, /suppression list/],
    ["reply handling is closed", { record: { ...facts().record, workflowState: "closed" } }, /Reply handling is closed/],
    ["the reply is not classified", { record: { ...facts().record, replyTypeId: null } }, /no reply type yet/],
    ["the conversation is not email", { conversation: { id: "c1", recordId: "rec1", channel: "linkedin" } }, /no email reply/],
    ["there is no reply at all", { record: { ...facts().record, latestInboundMessageId: null, lastInboundAt: null } }, /no email reply/],
  ];
  it.each(causes)("names the cause when %s", async (_name, over, message) => {
    const s = store(facts(over));
    await expect(restartSequenceRun(s.deps, actor, "rec1")).rejects.toMatchObject({ message: expect.stringMatching(message), details: { code: "restart_blocked" } });
    expect(s.created).toHaveLength(0);
  });

  it("does not claim the setting is wrong when the cause is somewhere else", async () => {
    const s = store(facts({ owner: { id: "camp", name: "Autumn", channel: "email", type: "regular", status: "paused", archived: false }, selection: null }));
    await expect(restartSequenceRun(s.deps, actor, "rec1")).rejects.not.toThrow(/AI drafts/);
  });

  it("refuses when a person already answered and the flow has only the reply step", async () => {
    const f = facts({ steps: [{ id: "s1", sequenceVersionId: "v1", position: 1, delayMinutes: 0 }] });
    f.record.lastOutboundAt = new Date("2026-10-15T08:30:00Z");
    await expect(restartSequenceRun(store(f).deps, actor, "rec1")).rejects.toThrow(/no follow-up step after the reply/);
  });
});

describe("a reply type set to Don't write a reply draft", () => {
  it("starts the run at step 2, so step 1 writes no draft and the later steps continue", async () => {
    const base = facts();
    const s = store(facts({ record: { ...base.record, replyDraft: false } }));
    expect(await startRun(s.deps, { organizationId: "org", recordId: "rec1", source: "ai_assignment" })).toEqual({ runId: "run1", created: true });
    expect(s.created[0]).toMatchObject({ startPosition: 2 });
    expect(s.created[0].steps.map((x) => x.position)).toEqual([2]);
  });

  it("starts no run when the flow has only step 1", async () => {
    const base = facts();
    const s = store(facts({ record: { ...base.record, replyDraft: false }, steps: [{ id: "s1", sequenceVersionId: "v1", position: 1, delayMinutes: 0 }] }));
    expect(await attemptRun(s.deps, { organizationId: "org", recordId: "rec1", source: "ai_assignment" })).toEqual({
      blocked: "Demo request is set to not write a reply draft, and the flow has no follow-up step after the reply.",
    });
    expect(s.created).toHaveLength(0);
  });
});

describe("Restart button and restart result agree", () => {
  const record = (answered: boolean) => ({ lastInboundAt: new Date("2026-10-15T08:00:00Z"), lastOutboundAt: answered ? new Date("2026-10-15T08:30:00Z") : null });
  const stepsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, sequenceVersionId: "v1", position: i + 1, delayMinutes: 0 }));
  const cases = [false, true].flatMap((answered) =>
    [false, true].flatMap((skipReply) =>
      [false, true].flatMap((replyDraft) => [0, 1, 2, 3].flatMap((stepCount) => [false, true].map((hasRun) => ({ answered, skipReply, replyDraft, stepCount, hasRun })))),
    ),
  );

  it.each(cases)("answered=$answered skipReply=$skipReply replyDraft=$replyDraft steps=$stepCount run=$hasRun", async ({ answered, skipReply, replyDraft, stepCount, hasRun }) => {
    const base = facts();
    const f = facts({ record: { ...base.record, ...record(answered), replyDraft }, steps: stepsOf(stepCount) });
    const reason = startBlocker(f, { source: "human_override", skipReply });
    const created: NewRun[] = [];
    // An existing run in progress is the store's business (it replaces the run); it must not change the verdict.
    const runs = { loadStart: async () => f, createRun: async (run: NewRun) => (created.push(run), { runId: hasRun ? "run0" : "run1", created: true }) };
    const outcome = await attemptRun({ runs, now: () => NOW }, { organizationId: "org", recordId: "rec1", source: "human_override", skipReply, restart: hasRun });
    if (reason === null) {
      expect(outcome, "button says Restart works").toHaveProperty("started");
      expect(created).toHaveLength(1);
    } else {
      expect(outcome, "button says it is blocked").toEqual({ blocked: reason });
      expect(created).toHaveLength(0);
    }
  });
});

describe("getRecordSequence", () => {
  const actor = { userId: "u1", organizationId: "org", role: "member" };
  const run = (status: "active" | "interrupted", endedReason: string | null, startedBy: "ai_assignment" | "human_override") => ({
    id: "run1",
    status,
    version: 2,
    currentStepPosition: 2,
    totalSteps: 3,
    startedBy,
    createdAt: NOW,
    endedReason,
    steps: [],
  });

  it("adds wording for the status, the starter and the reason a run ended", async () => {
    const runs = { loadStart: async () => facts(), recordState: async () => ({ recordId: "rec1", campaign: { id: "c1", name: "Autumn", mode: "ai_drafts" as const }, run: run("interrupted", "after_reply_off", "human_override") }) } as unknown as RunStore;
    const state = await getRecordSequence({ runs, now: () => NOW }, actor, "rec1");
    expect(state.campaign).toEqual({ id: "c1", name: "Autumn", mode: "ai_drafts" });
    expect(state.run).toMatchObject({ statusLabel: "Stopped", startedByLabel: "Restarted by a person", endedReasonLabel: "Follow-ups turned off for this campaign" });
  });

  it("leaves the ended reason empty while the run goes on, and handles a record without a run", async () => {
    const running = { loadStart: async () => facts(), recordState: async () => ({ recordId: "rec1", campaign: null, run: run("active", null, "ai_assignment") }) } as unknown as RunStore;
    expect((await getRecordSequence({ runs: running, now: () => NOW }, actor, "rec1")).run).toMatchObject({ statusLabel: "Running", startedByLabel: "Automatic", endedReasonLabel: null });
    const none = { loadStart: async () => facts(), recordState: async () => ({ recordId: "rec1", campaign: null, run: null }) } as unknown as RunStore;
    expect((await getRecordSequence({ runs: none, now: () => NOW }, actor, "rec1")).run).toBeNull();
  });

  it("tells the page whether Restart can run and why not", async () => {
    const state = { recordId: "rec1", campaign: { id: "camp", name: "Autumn", mode: "ai_drafts" as const }, run: null };
    const ok = { loadStart: async () => facts(), recordState: async () => state } as unknown as RunStore;
    expect(await getRecordSequence({ runs: ok, now: () => NOW }, actor, "rec1")).toMatchObject({ canRestart: true, restartBlockedReason: null });
    const paused = { loadStart: async () => facts({ owner: { id: "camp", name: "Autumn", channel: "email", type: "regular", status: "paused", archived: false }, selection: null }), recordState: async () => state } as unknown as RunStore;
    expect(await getRecordSequence({ runs: paused, now: () => NOW }, actor, "rec1")).toMatchObject({ canRestart: false, restartBlockedReason: "The campaign Autumn is paused. Resume it to restart follow-ups." });
  });

  it("reads the record state and the start facts together", async () => {
    const log: string[] = [];
    const state = { recordId: "rec1", campaign: null, run: null };
    const runs = {
      recordState: async () => (log.push("enter recordState"), await Promise.resolve(), log.push("exit recordState"), state),
      loadStart: async () => (log.push("enter loadStart"), await Promise.resolve(), log.push("exit loadStart"), facts()),
    } as unknown as RunStore;
    await getRecordSequence({ runs, now: () => NOW }, actor, "rec1");
    expect(log.slice(0, 2)).toEqual(["enter recordState", "enter loadStart"]);
  });

  it("answers 404 for a record the organization does not have", async () => {
    const runs = { recordState: async () => null, loadStart: async () => null } as unknown as RunStore;
    await expect(getRecordSequence({ runs, now: () => NOW }, actor, "rec9")).rejects.toBeInstanceOf(NotFoundError);
  });
});
