import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { getCampaignAfterReply, getFollowUpStopTypes, saveCampaignAfterReply, type AfterReplyDeps } from "./after-reply";
import type { AfterReplyStore, FlowRunRow, FlowSave, FlowState, StepView, StopReplyTypeRow } from "./sequence-ports";

const NOW = new Date("2026-10-16T09:00:00Z");
const actor: Actor = { userId: "u1", organizationId: "org", role: "member" };

const step = (position: number, over: Partial<StepView> = {}): StepView => ({
  id: `s${position}`,
  sequenceVersionId: "v1",
  position,
  stepType: position === 1 ? "reply" : "follow_up",
  name: position === 1 ? "Reply to their answer" : "Follow-up",
  delayMinutes: position === 1 ? 0 : 2880,
  subjectTemplate: null,
  bodyTemplate: null,
  aiInstructions: "Goal",
  knowledgeTags: [],
  ...over,
});

const raw = (position: number) => ({ name: position === 1 ? "Reply" : "Nudge", delayMinutes: position === 1 ? 0 : 1440, subjectTemplate: null, bodyTemplate: null, aiInstructions: "Do it", knowledgeTags: [] });

const run = (over: Partial<FlowRunRow> = {}): FlowRunRow => ({ runId: "r1", recordId: "rec1", conversationId: "conv1", personName: "Sam", status: "active", currentStep: 2, totalSteps: 3, nextDueAt: NOW, versionNumber: 1, ...over });

const stopType = (over: Partial<StopReplyTypeRow> & Pick<StopReplyTypeRow, "id" | "name" | "groupKey">): StopReplyTypeRow => ({ key: over.id, systemRole: null, sortOrder: 0, ...over });

const STOP_TYPES: StopReplyTypeRow[] = [
  stopType({ id: "ooo", name: "Out of office", groupKey: "other", sortOrder: 2 }),
  stopType({ id: "dnc", key: "do_not_contact", name: "Asked to stop", groupKey: "not_interested", systemRole: "stop_request", sortOrder: 1 }),
  stopType({ id: "cust", name: "Customer question", groupKey: "customer", sortOrder: 0 }),
  stopType({ id: "now", name: "Not now", groupKey: "not_interested", sortOrder: 2 }),
];

function fake(state: FlowState | null, stopTypes: StopReplyTypeRow[] = STOP_TYPES) {
  const saved: FlowSave[] = [];
  const flows: AfterReplyStore = {
    state: async () => state,
    stopReplyTypes: async () => stopTypes,
    save: async (input) => {
      saved.push(input);
      return { stoppedRuns: 0 };
    },
  };
  const deps: AfterReplyDeps = { flows, now: () => NOW };
  return { deps, saved };
}

const emailState = (over: Partial<FlowState> = {}): FlowState => ({
  campaign: { id: "c1", name: "Autumn", channel: "email", type: "regular", status: "active" },
  flow: { id: "f1", status: "active" },
  published: { version: 2 },
  steps: [step(1), step(2)],
  inProgress: [],
  earlierVersionCount: 0,
  ...over,
});

describe("getCampaignAfterReply", () => {
  it("reports ai_drafts for an active flow with a published version", async () => {
    const view = await getCampaignAfterReply(fake(emailState({ inProgress: [run(), run({ runId: "r2", versionNumber: 1 })], earlierVersionCount: 1 })).deps, actor, "c1");
    expect(view).toMatchObject({ campaignId: "c1", mode: "ai_drafts", versionNumber: 2, supported: true, lockedReason: null, earlierVersionCount: 1 });
    expect(view.steps.map((s) => [s.stepType, s.delayMinutes])).toEqual([["reply", 0], ["follow_up", 2880]]);
    expect(view.inProgress).toHaveLength(2);
  });

  it("reports handoff for an archived flow and keeps its steps", async () => {
    const view = await getCampaignAfterReply(fake(emailState({ flow: { id: "f1", status: "archived" } })).deps, actor, "c1");
    expect(view.mode).toBe("handoff");
    expect(view.steps).toHaveLength(2);
  });

  it("reports handoff and no steps for a campaign without a flow", async () => {
    const view = await getCampaignAfterReply(fake(emailState({ flow: null, published: null, steps: [] })).deps, actor, "c1");
    expect(view).toMatchObject({ mode: "handoff", steps: [], versionNumber: null });
  });

  it("locks LinkedIn and Personal campaigns to handoff", async () => {
    const linkedin = await getCampaignAfterReply(fake(emailState({ campaign: { id: "c1", name: "L", channel: "linkedin", type: "regular", status: "active" } })).deps, actor, "c1");
    expect(linkedin.supported).toBe(false);
    expect(linkedin.lockedReason).toMatch(/email/);
    const personal = await getCampaignAfterReply(fake(emailState({ campaign: { id: "c1", name: "P", channel: "linkedin", type: "personal", status: "active" } })).deps, actor, "c1");
    expect(personal.lockedReason).toMatch(/Personal/);
  });

  it("answers 404 for a campaign the organization does not have", async () => {
    await expect(getCampaignAfterReply(fake(null).deps, actor, "c9")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("stop types", () => {
  it("lists the types set to stop follow-ups in group order, then list order, with the reason", async () => {
    const types = await getFollowUpStopTypes(fake(emailState()).deps, actor);
    expect(types.map((t) => t.name)).toEqual(["Customer question", "Asked to stop", "Not now", "Out of office"]);
    expect(types[1]).toEqual({ id: "dnc", key: "do_not_contact", name: "Asked to stop", groupKey: "not_interested", systemRole: "stop_request", reason: "Asked to stop is set to stop follow-ups." });
  });

  it("puts the fixed rules and then each stop type on the campaign view", async () => {
    const view = await getCampaignAfterReply(fake(emailState()).deps, actor, "c1");
    expect(view.stopReplyTypes.map((t) => t.id)).toEqual(["cust", "dnc", "now", "ooo"]);
    expect(view.stopsOn.map((l) => l.label)).toEqual([
      "The person replies again",
      "The person is marked do not contact",
      "The person unsubscribes",
      "The address bounces",
      "The address is on the suppression list",
      "Reply handling is closed",
      "The person becomes a contact",
      "The reply is classified Customer question",
      "The reply is classified Asked to stop",
      "The reply is classified Not now",
      "The reply is classified Out of office",
    ]);
  });

  it("shows only the fixed rules when no type stops follow-ups", async () => {
    const view = await getCampaignAfterReply(fake(emailState(), []).deps, actor, "c1");
    expect(view.stopReplyTypes).toEqual([]);
    expect(view.stopsOn).toHaveLength(7);
  });
});

describe("saveCampaignAfterReply", () => {
  it("passes parsed steps to the store for ai_drafts", async () => {
    const f = fake(emailState({ flow: null, published: null, steps: [] }));
    await saveCampaignAfterReply(f.deps, actor, "c1", { mode: "ai_drafts", steps: [raw(1), raw(2)] });
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]).toMatchObject({ organizationId: "org", campaignId: "c1", mode: "ai_drafts", confirmStopRuns: false, now: NOW });
    expect(f.saved[0].steps?.map((s) => s.delayMinutes)).toEqual([0, 1440]);
  });

  it("reuses the stored steps when switching back to ai_drafts without new ones", async () => {
    const f = fake(emailState({ flow: { id: "f1", status: "archived" } }));
    await saveCampaignAfterReply(f.deps, actor, "c1", { mode: "ai_drafts" });
    expect(f.saved[0].steps).toBeNull();
  });

  it("needs a reply step when nothing is stored", async () => {
    const f = fake(emailState({ flow: null, published: null, steps: [] }));
    await expect(saveCampaignAfterReply(f.deps, actor, "c1", { mode: "ai_drafts" })).rejects.toMatchObject({ details: { code: "steps_required" } });
    await expect(saveCampaignAfterReply(f.deps, actor, "c1", { mode: "ai_drafts", steps: [] })).rejects.toBeInstanceOf(ConflictError);
    expect(f.saved).toHaveLength(0);
  });

  it("rejects an invalid mode and invalid steps with a validation error", async () => {
    const f = fake(emailState());
    await expect(saveCampaignAfterReply(f.deps, actor, "c1", { mode: "auto" })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveCampaignAfterReply(f.deps, actor, "c1", { mode: "ai_drafts", steps: [{ ...raw(1), delayMinutes: 5 }] })).rejects.toBeInstanceOf(ValidationError);
    expect(f.saved).toHaveLength(0);
  });

  it("answers a conflict with code mode_locked for LinkedIn and Personal campaigns", async () => {
    for (const campaign of [
      { id: "c1", name: "L", channel: "linkedin", type: "regular", status: "active" },
      { id: "c1", name: "P", channel: "linkedin", type: "personal", status: "active" },
    ]) {
      const f = fake(emailState({ campaign, flow: null, published: null, steps: [] }));
      await expect(saveCampaignAfterReply(f.deps, actor, "c1", { mode: "ai_drafts", steps: [raw(1)] })).rejects.toMatchObject({ details: { code: "mode_locked" } });
      expect(f.saved).toHaveLength(0);
    }
  });

  it("allows handoff on a locked campaign", async () => {
    const f = fake(emailState({ campaign: { id: "c1", name: "L", channel: "linkedin", type: "regular", status: "active" }, flow: null, published: null, steps: [] }));
    await saveCampaignAfterReply(f.deps, actor, "c1", { mode: "handoff" });
    expect(f.saved).toMatchObject([{ mode: "handoff" }]);
  });

  it("asks for confirmation before stopping runs in progress", async () => {
    const f = fake(emailState({ inProgress: [run(), run({ runId: "r2" })] }));
    await expect(saveCampaignAfterReply(f.deps, actor, "c1", { mode: "handoff" })).rejects.toMatchObject({ details: { code: "runs_in_progress", count: 2 } });
    await expect(saveCampaignAfterReply(f.deps, actor, "c1", { mode: "handoff", confirmStopRuns: "yes" })).rejects.toBeInstanceOf(ConflictError);
    expect(f.saved).toHaveLength(0);
    await saveCampaignAfterReply(f.deps, actor, "c1", { mode: "handoff", confirmStopRuns: true });
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]).toMatchObject({ mode: "handoff", confirmStopRuns: true });
  });
});
