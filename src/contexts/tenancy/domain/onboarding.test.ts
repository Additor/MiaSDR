import { describe, expect, it } from "vitest";
import { deriveChecklist, type OnboardingFacts } from "./onboarding";

const empty: OnboardingFacts = {
  connectedMailboxes: 0,
  totalMailboxes: 0,
  connectedLinkedInAccounts: 0,
  leads: 0,
  campaigns: 0,
  startedCampaigns: 0,
  emailsSent: 0,
  replies: 0,
  aiSetup: { state: "none" },
};
const status = (facts: OnboardingFacts, id: string) => deriveChecklist(facts).steps.find((s) => s.id === id)!;

describe("deriveChecklist", () => {
  it("starts with nothing done and points at the mailbox step", () => {
    const list = deriveChecklist(empty);
    expect(list.steps.map((s) => s.status)).toEqual(["todo", "todo", "todo", "todo", "todo", "todo", "todo"]);
    expect(list).toMatchObject({ requiredDone: 0, requiredTotal: 5, complete: false, nextStepId: "mailbox", hidden: false });
  });

  it("marks optional steps and keeps them out of the required count", () => {
    const list = deriveChecklist(empty);
    expect(list.steps.filter((s) => s.optional).map((s) => s.id)).toEqual(["linkedin", "ai"]);
  });

  it("lists required steps before optional ones", () => {
    const list = deriveChecklist(empty);
    expect(list.steps.map((s) => s.id)).toEqual(["mailbox", "leads", "campaign", "send", "reply", "linkedin", "ai"]);
  });

  it("links each step to where you do it", () => {
    const hrefs = Object.fromEntries(deriveChecklist(empty).steps.map((s) => [s.id, s.href]));
    expect(hrefs).toMatchObject({ mailbox: "/settings/mailboxes", leads: "/leads/import", campaign: "/campaigns", send: "/campaigns", reply: "/inbox" });
  });

  const allRequired = { ...empty, connectedMailboxes: 1, totalMailboxes: 1, leads: 12, campaigns: 1, startedCampaigns: 1, emailsSent: 1, replies: 1 };

  it("is complete when the five required steps are done, even without optional ones", () => {
    const list = deriveChecklist(allRequired);
    expect(list.complete).toBe(true);
    expect(list.requiredDone).toBe(5);
    expect(list.nextStepId).toBe("linkedin");
  });

  it("does not count a draft as a started campaign", () => {
    const step = status({ ...empty, campaigns: 2 }, "campaign");
    expect(step).toMatchObject({ status: "todo", detail: "2 drafts, none started", action: "Open campaigns" });
    expect(status({ ...empty, campaigns: 2, startedCampaigns: 1 }, "campaign")).toMatchObject({ status: "done", detail: "1 campaign started" });
    expect(status(empty, "campaign")).toMatchObject({ detail: null, action: "Create campaign" });
  });

  it("says what the send step waits on", () => {
    expect(status(empty, "send")).toMatchObject({ status: "todo", detail: "Nothing to send yet: start a campaign first" });
    expect(status({ ...empty, startedCampaigns: 1 }, "send")).toMatchObject({ status: "todo", detail: "Waiting for the first send" });
    expect(status({ ...empty, emailsSent: 3 }, "send")).toMatchObject({ status: "done", detail: "3 emails sent" });
  });

  it("says what the reply step waits on", () => {
    expect(status(empty, "reply")).toMatchObject({ status: "todo", detail: null, href: "/inbox" });
    expect(status({ ...empty, emailsSent: 1 }, "reply").detail).toBe("No replies yet");
    expect(status({ ...empty, replies: 1 }, "reply")).toMatchObject({ status: "done", detail: "1 reply received" });
    expect(status({ ...empty, replies: 2 }, "reply").detail).toBe("2 replies received");
  });

  it("hides only after both the first send and the first reply", () => {
    expect(deriveChecklist({ ...empty, emailsSent: 1 }).hidden).toBe(false);
    expect(deriveChecklist({ ...empty, replies: 1 }).hidden).toBe(false);
    // A mailbox that later fails shows on its own step, and the guide stays hidden.
    expect(deriveChecklist({ ...empty, emailsSent: 1, replies: 1 }).hidden).toBe(true);
  });

  it("does not require the AI key", () => {
    expect(status(empty, "ai").optional).toBe(true);
    expect(deriveChecklist({ ...allRequired, aiSetup: { state: "none" } }).complete).toBe(true);
  });

  it("reports a mailbox that never connected as needing attention, not as missing", () => {
    const step = status({ ...empty, totalMailboxes: 2 }, "mailbox");
    expect(step.status).toBe("attention");
    expect(step.detail).toBe("2 mailboxes added, none connected");
    expect(step.action).toBe("Fix mailbox");
  });

  it("counts a mailbox as done when any one is connected", () => {
    const step = status({ ...empty, connectedMailboxes: 1, totalMailboxes: 3 }, "mailbox");
    expect(step.status).toBe("done");
    expect(step.detail).toBe("1 mailbox connected");
  });

  it("shows a real count for leads", () => {
    expect(status({ ...empty, leads: 1 }, "leads").detail).toBe("1 lead imported");
  });

  it("derives the optional steps from their own facts", () => {
    expect(status({ ...empty, connectedLinkedInAccounts: 2 }, "linkedin").status).toBe("done");
    expect(status({ ...empty, aiSetup: { state: "on", running: "Anthropic, claude-sonnet-5-5" } }, "ai")).toMatchObject({ status: "done", detail: "AI runs on Anthropic, claude-sonnet-5-5" });
    expect(status({ ...empty, aiSetup: { state: "needs_model", provider: "OpenRouter" } }, "ai").status).toBe("attention");
  });

  it("points at the first unfinished required step before optional ones", () => {
    const list = deriveChecklist({ ...empty, connectedLinkedInAccounts: 1, aiSetup: { state: "demo" } });
    expect(list.nextStepId).toBe("mailbox");
  });

  it("has no next step when everything is done", () => {
    const list = deriveChecklist({ ...allRequired, connectedLinkedInAccounts: 1, aiSetup: { state: "demo" } });
    expect(list.nextStepId).toBeNull();
  });
});
