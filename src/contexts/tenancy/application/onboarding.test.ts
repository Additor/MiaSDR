import { describe, expect, it } from "vitest";
import { ForbiddenError, type Actor } from "@/shared/errors";
import { dismissOnboarding, getOnboarding, type OnboardingStore } from "./onboarding";

const facts = { timeZoneSaved: true, connectedMailboxes: 0, totalMailboxes: 0, connectedLinkedInAccounts: 0, leads: 0, campaigns: 0, activeCampaigns: 0, draftsAwaiting: 0, messagesApproved: 0, aiKeyStored: false };

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
const actor = (role: string): Actor => ({ userId: "u1", organizationId: "o1", role });

describe("onboarding use cases", () => {
  it("reads facts for the actor's own organization", async () => {
    const { s, calls } = store();
    const view = await getOnboarding({ store: s }, actor("member"));
    expect(calls).toEqual(["facts:o1"]);
    expect(view.steps.find((x) => x.id === "profile")?.status).toBe("done");
    expect(view).toMatchObject({ dismissed: false, canDismiss: false });
  });

  it("lets owners and admins dismiss", async () => {
    const { s, calls } = store();
    await dismissOnboarding({ store: s }, actor("admin"));
    expect(calls).toEqual(["dismiss:o1:u1"]);
    expect((await getOnboarding({ store: store(true).s }, actor("owner"))).dismissed).toBe(true);
  });

  it("refuses members", async () => {
    const { s, calls } = store();
    await expect(dismissOnboarding({ store: s }, actor("member"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toEqual([]);
  });
});
