import { describe, expect, it } from "vitest";
import type { ReplyAi } from "../../ai/application/ai-ports";
import type { DraftContext, NewDraft } from "../../application/reply-ports";
import { createSequenceJobs } from "./sequence-jobs";

/**
 * The sequence job writes the draft with the channel of the conversation it drafts for. insertDraft
 * defaults to email, which breaks the draft channel trigger (0020) on a LinkedIn conversation.
 */
function setup(channel: "email" | "linkedin", opts: { flowActive?: boolean; sweep?: boolean } = {}) {
  const interrupted: Array<{ runId: string; reason: string }> = [];
  const inserted: Array<NewDraft & { feedback?: string | null }> = [];
  const ctx = {
    channel,
    organizationId: "org",
    recordId: "rec",
    conversationId: "conv",
    contextVersion: 3,
    replyForMessageId: "msg",
    person: { name: "Lena Lead", email: "lena@acme.test", company: null, title: null },
    thread: [],
    subject: channel === "linkedin" ? "" : "Re: hello",
    classification: null,
    stageChange: null,
    operatorInstructions: "",
    knowledge: [],
    senderName: null,
  } as unknown as DraftContext;
  const ai: ReplyAi = {
    name: "fake",
    model: "fake-1",
    classify: async () => {
      throw new Error("not used");
    },
    draft: async () => ({ output: { subject: "Following up", bodyText: "Checking in on this." } }),
  };
  let claimed = false;
  const claim = {
    stepRunId: "sr",
    organizationId: "org",
    attempts: 1,
    run: { id: "run", recordId: "rec", conversationId: "conv", sequenceVersionId: "ver", triggerMessageId: "msg" },
    step: { id: "st", sequenceVersionId: "ver", position: 2, stepType: "follow_up", name: "Nudge", delayMinutes: 60, subjectTemplate: null, bodyTemplate: null, aiInstructions: "Check in once.", knowledgeTags: [] },
    timeZone: "UTC",
  };
  const engine = {
    interruptCandidates: async (after: string | null) =>
      opts.sweep && after === null
        ? [
            {
              runId: "run",
              organizationId: "org",
              recordId: "rec",
              facts: {
                run: { triggerMessageId: "msg", subcategoryId: "sub" },
                record: { latestInboundMessageId: "msg", subcategoryId: "sub", categoryKey: "interested", subcategoryKey: "demo_request", workflowState: "waiting" },
                doNotContact: false,
                suppression: null,
                flowActive: false,
              },
            },
          ]
        : [],
    startCandidates: async () => [],
    settleDrafts: async () => 0,
    claimDue: async () => (claimed ? null : ((claimed = true), claim)),
    interruptFactsFor: async () => ({
      run: { triggerMessageId: "msg", subcategoryId: "sub" },
      record: { latestInboundMessageId: "msg", subcategoryId: "sub", categoryKey: "interested", subcategoryKey: "demo_request", workflowState: "waiting" },
      doNotContact: false,
      suppression: null,
      flowActive: opts.flowActive ?? true,
    }),
    interrupt: async (_org: string, runId: string, reason: string) => {
      interrupted.push({ runId, reason });
    },
    orphanDraft: async () => null,
    openDrafts: async () => [],
    linkDraft: async () => true,
    failAttempt: async (_id: string, message: string) => {
      throw new Error(message);
    },
  };
  const replies = {
    draftContext: async () => ctx,
    insertDraft: async (draft: NewDraft & { feedback?: string | null }) => {
      inserted.push(draft);
      return { id: "draft-1" };
    },
  };
  const [job] = createSequenceJobs({
    engine: engine as never,
    runs: {} as never,
    replies: replies as never,
    ai: { forOrganization: async () => ai },
    now: () => new Date("2026-10-16T10:00:00Z"),
    workerId: "w",
    leaseMs: 60_000,
    notConfiguredDelayMs: 60_000,
  });
  return { job, inserted, interrupted };
}

describe("sequence draft channel", () => {
  const run = (job: ReturnType<typeof setup>["job"]) => job.run({ deadline: Date.now() + 10_000, now: () => new Date("2026-10-16T10:00:00Z") });

  it("writes a draft on a LinkedIn conversation with channel linkedin", async () => {
    const { job, inserted } = setup("linkedin");
    const result = await run(job);
    expect(result.detail).toMatchObject({ drafted: 1 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].channel).toBe("linkedin");
    expect(inserted[0].conversationId).toBe("conv");
  });

  it("writes a draft on an email conversation with channel email", async () => {
    const { job, inserted } = setup("email");
    await run(job);
    expect(inserted[0].channel).toBe("email");
  });

  it("ends a run whose campaign turned After a reply off, in the sweep, before any draft", async () => {
    const { job, inserted, interrupted } = setup("email", { flowActive: false, sweep: true });
    const result = await run(job);
    // The fake engine still offers a claim after the sweep, and the guard stops it again.
    expect(interrupted[0]).toEqual({ runId: "run", reason: "after_reply_off" });
    expect(result.detail?.interrupted_after_reply_off).toBe(2);
    expect(inserted).toHaveLength(0);
  });

  it("does not draft a claimed step when the flow went off after the claim", async () => {
    const { job, inserted, interrupted } = setup("email", { flowActive: false });
    await run(job);
    expect(interrupted).toEqual([{ runId: "run", reason: "after_reply_off" }]);
    expect(inserted).toHaveLength(0);
  });
});
