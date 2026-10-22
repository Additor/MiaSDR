import { describe, expect, it } from "vitest";
import { ForbiddenError, type Actor } from "@/shared/errors";
import { dismissOnboarding, getOnboarding, type OnboardingStore } from "./onboarding";

const facts = { timeZoneSaved: true, connectedMailboxes: 0, totalMailboxes: 0, connectedLinkedInAccounts: 0, leads: 0, campaigns: 0, activeCampaigns: 0, draftsAwaiting: 0, messagesApproved: 0 };

function store(dismissed = false) {
  const calls: string[] = [];
  const s: OnboardingStore = {
    async facts(org) {
      calls.push(`facts:${org}`);
      return facts;
    },
    async isDismissed() {
      return dismissed;
    },
    async dismiss(org, user) {
      calls.push(`dismiss:${org}:${user}`);
    },
  };
  return { s, calls };
}
const noAi = async () => ({ state: "none" as const });
const actor = (role: string): Actor => ({ userId: "u1", organizationId: "o1", role });

describe("onboarding use cases", () => {
  it("reads facts for the actor's own organization", async () => {
    const { s, calls } = store();
    const view = await getOnboarding({ store: s, aiSetup: noAi }, actor("member"));
    expect(calls).toEqual(["facts:o1"]);
    expect(view.steps.find((x) => x.id === "profile")?.status).toBe("done");
    expect(view).toMatchObject({ dismissed: false, canDismiss: false });
  });

  it("asks for a model when a key is saved but AI is off", async () => {
    const view = await getOnboarding({ store: store().s, aiSetup: async () => ({ state: "needs_model", provider: "OpenRouter" }) }, actor("owner"));
    expect(view.steps.find((x) => x.id === "ai")).toMatchObject({ status: "attention", detail: "OpenRouter key saved. AI is off until a model is picked.", action: "Pick a model" });
  });

  it("lets owners and admins dismiss", async () => {
    const { s, calls } = store();
    await dismissOnboarding({ store: s, aiSetup: noAi }, actor("admin"));
    expect(calls).toEqual(["dismiss:o1:u1"]);
    expect((await getOnboarding({ store: store(true).s, aiSetup: noAi }, actor("owner"))).dismissed).toBe(true);
  });

  it("refuses members", async () => {
    const { s, calls } = store();
    await expect(dismissOnboarding({ store: s, aiSetup: noAi }, actor("member"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toEqual([]);
  });
});
