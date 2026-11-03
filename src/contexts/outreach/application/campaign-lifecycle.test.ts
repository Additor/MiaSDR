import { describe, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { MAX_ENROLL_BATCH, archiveOn, createCampaignOn, deleteOn, enrollOn, updateCampaignOn, type CampaignChannel, type CampaignLifecycleDeps, type CampaignLifecycleStore } from "./campaign-lifecycle";
import type { CampaignStatus } from "../domain/campaign";
import { MAX_CAMPAIGN_SENDERS, type EnrollmentAdminStore } from "./enrollment-admin";

type Step = { stepNumber: number; body: string };
const actor: Actor = { userId: "u1", organizationId: "org1", role: "owner" };

function setup(status: CampaignStatus, overrides: Partial<CampaignLifecycleStore<Step>> = {}) {
  const audited: Array<{ action: string; meta?: Record<string, unknown> }> = [];
  const limits: number[] = [];
  const campaigns = {
    get: async () => ({ name: "Q4", status, steps: [], archivedAt: null }),
    transaction: <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never),
    delete: async (_org: string, _id: string, audit: { action: string; meta?: Record<string, unknown> }) => {
      audited.push(audit);
      return true;
    },
    setArchived: async () => true,
    furthestStep: async () => 3,
    enroll: async (_org: string, _id: string, filter: { limit: number }) => limits.push(filter.limit),
    ...overrides,
  } as unknown as CampaignLifecycleStore<Step>;
  const deps: CampaignLifecycleDeps<Step> = { campaigns, fields: {} as never, audit: { record: async (entry) => void audited.push(entry) } };
  return { deps, audited, limits };
}

const channel: CampaignChannel<Step> = { channel: "email", validateSteps: () => [], tooFewSteps: (n) => `at least ${n}`, countConnectedSenders: async () => 1, noConnectedSender: "connect" };

describe("campaign lifecycle", () => {
  it("audits a deleted draft under the channel it is bound to", async () => {
    const { deps, audited } = setup("draft");
    await deleteOn(deps, "linkedin", actor, "c1");
    expect(audited).toEqual([expect.objectContaining({ action: "campaign.deleted", entityId: "c1", meta: { name: "Q4", channel: "linkedin" } })]);
  });

  it("refuses a delete off draft, and one the store found no draft for, with no audit row", async () => {
    const started = setup("active");
    await expect(deleteOn(started.deps, "email", actor, "c1")).rejects.toThrow(/Only a draft/);
    const raced = setup("draft", { delete: async () => false });
    await expect(deleteOn(raced.deps, "email", actor, "c1")).rejects.toMatchObject({ message: expect.stringMatching(/Only a draft/), details: { code: "campaign_not_draft" } });
    expect([...started.audited, ...raced.audited]).toEqual([]);
  });

  it("archives only a completed campaign", async () => {
    await expect(archiveOn(setup("paused").deps.campaigns, actor, "c1")).rejects.toThrow(/Only a completed/);
    await expect(archiveOn(setup("completed").deps.campaigns, actor, "c1")).resolves.toBeUndefined();
  });

  it("holds an enroll by query to one batch on every channel", async () => {
    const { deps, limits } = setup("draft");
    await enrollOn(deps.campaigns, actor, "c1", { limit: MAX_ENROLL_BATCH + 1 });
    await enrollOn(deps.campaigns, actor, "c1", {});
    expect(limits).toEqual([MAX_ENROLL_BATCH, MAX_ENROLL_BATCH]);
  });

  it("caps a campaign's senders in the use case, for a caller without the route's schema", async () => {
    const { deps } = setup("draft");
    const ids = Array.from({ length: MAX_CAMPAIGN_SENDERS + 1 }, (_, i) => `s${i}`);
    const admin = { findSenders: async () => ids.map((id) => ({ id, label: id, connected: true })) } as unknown as EnrollmentAdminStore;
    await expect(createCampaignOn({ ...deps, admin }, channel, actor, { name: "Q4", senderIds: ids }, (name) => ({ name, createdBy: actor.userId, steps: [] }))).rejects.toThrow(`Assign up to ${MAX_CAMPAIGN_SENDERS} senders`);
  });

  it("uses the channel's words when an edit would drop a step a lead reached", async () => {
    const { deps } = setup("draft");
    await expect(updateCampaignOn(deps, channel, actor, "c1", { steps: [{ stepNumber: 1, body: "x" }] })).rejects.toThrow("at least 3");
  });
});
