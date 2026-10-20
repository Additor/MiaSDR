import { describe, expect, it } from "vitest";
import { deriveChecklist, type OnboardingFacts } from "./onboarding";

const empty: OnboardingFacts = {
  timeZoneSaved: false,
  connectedMailboxes: 0,
  totalMailboxes: 0,
  connectedLinkedInAccounts: 0,
  leads: 0,
  campaigns: 0,
  activeCampaigns: 0,
  draftsAwaiting: 0,
  messagesApproved: 0,
  aiKeyStored: false,
};
const status = (facts: OnboardingFacts, id: string) => deriveChecklist(facts).steps.find((s) => s.id === id)!;

describe("deriveChecklist", () => {
  it("starts with nothing done and points at the profile step", () => {
    const list = deriveChecklist(empty);
    expect(list.steps.map((s) => s.status)).toEqual(["todo", "todo", "todo", "todo", "todo", "todo", "todo"]);
    expect(list).toMatchObject({ requiredDone: 0, requiredTotal: 5, complete: false, nextStepId: "profile" });
  });

  it("marks optional steps and keeps them out of the required count", () => {
    const list = deriveChecklist(empty);
    expect(list.steps.filter((s) => s.optional).map((s) => s.id)).toEqual(["linkedin", "ai"]);
  });

  it("lists required steps before optional ones", () => {
    const list = deriveChecklist(empty);
    expect(list.steps.map((s) => s.id)).toEqual(["profile", "mailbox", "leads", "campaign", "approve", "linkedin", "ai"]);
  });

  const allRequired = { ...empty, timeZoneSaved: true, connectedMailboxes: 1, totalMailboxes: 1, leads: 12, campaigns: 1, messagesApproved: 1 };

  it("is complete when the five required steps are done, even without optional ones", () => {
    const list = deriveChecklist(allRequired);
    expect(list.complete).toBe(true);
    expect(list.requiredDone).toBe(5);
    expect(list.nextStepId).toBe("linkedin");
  });

  it("stays incomplete until a person has approved a message", () => {
    const list = deriveChecklist({ ...allRequired, messagesApproved: 0, draftsAwaiting: 2 });
    expect(list).toMatchObject({ complete: false, requiredDone: 4, nextStepId: "approve" });
  });

  it("tells what is waiting on the approve step and links to where it lives", () => {
    const waiting = status({ ...empty, campaigns: 1, draftsAwaiting: 2 }, "approve");
    expect(waiting).toMatchObject({ status: "todo", detail: "2 drafts waiting for your approval", href: "/inbox", action: "Review drafts" });
    expect(status({ ...empty, draftsAwaiting: 1 }, "approve").detail).toBe("1 draft waiting for your approval");
    expect(status(empty, "approve")).toMatchObject({ detail: "Nothing to approve yet: start a campaign first", href: "/campaigns" });
    expect(status({ ...empty, campaigns: 1 }, "approve").detail).toBe("No drafts waiting yet");
  });

  it("marks the approve step done from an approved message, not from a waiting draft", () => {
    expect(status({ ...empty, draftsAwaiting: 3 }, "approve").status).toBe("todo");
    const done = status({ ...empty, messagesApproved: 2, draftsAwaiting: 1 }, "approve");
    expect(done).toMatchObject({ status: "done", detail: "2 messages approved and sent" });
  });

  it("does not require the AI key", () => {
    expect(status(empty, "ai").optional).toBe(true);
    expect(deriveChecklist({ ...allRequired, aiKeyStored: false }).complete).toBe(true);
  });

  it("names the time zone step after what it checks", () => {
    expect(status(empty, "profile").title).toBe("Set the time zone");
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

  it("shows real counts for leads and campaigns", () => {
    expect(status({ ...empty, leads: 1 }, "leads").detail).toBe("1 lead imported");
    expect(status({ ...empty, campaigns: 3, activeCampaigns: 2 }, "campaign").detail).toBe("3 campaigns, 2 running");
  });

  it("derives the optional steps from their own facts", () => {
    expect(status({ ...empty, connectedLinkedInAccounts: 2 }, "linkedin").status).toBe("done");
    expect(status({ ...empty, aiKeyStored: true }, "ai").status).toBe("done");
  });

  it("points at the first unfinished required step before optional ones", () => {
    const list = deriveChecklist({ ...empty, timeZoneSaved: true, connectedLinkedInAccounts: 1, aiKeyStored: true });
    expect(list.nextStepId).toBe("mailbox");
  });

  it("has no next step when everything is done", () => {
    const list = deriveChecklist({ ...allRequired, connectedLinkedInAccounts: 1, aiKeyStored: true });
    expect(list.nextStepId).toBeNull();
  });
});
