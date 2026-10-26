import { describe, expect, it } from "vitest";
import {
  assertConversationBelongsToRecord,
  assertPublishable,
  assertRunTransition,
  assertStepsBelongToVersion,
  assertStepTransition,
  dueAfter,
  interruptReason,
  followUpsContinue,
  parseSteps,
  planDueDates,
  renderTemplate,
  startPosition,
  stepGuidance,
  type InterruptFacts,
} from "./sequences";

const step = (over: Record<string, unknown> = {}) => ({ name: "Reply", delayMinutes: 0, subjectTemplate: null, bodyTemplate: null, aiInstructions: "Answer the question.", knowledgeTags: [], ...over });
const followUp = (over: Record<string, unknown> = {}) => step({ name: "Nudge", delayMinutes: 2880, ...over });

describe("parseSteps", () => {
  it("accepts a reply followed by follow-ups and lowercases tags", () => {
    const steps = parseSteps([step(), followUp({ knowledgeTags: ["Pricing", "FAQ"] })]);
    expect(steps).toHaveLength(2);
    expect(steps[1].knowledgeTags).toEqual(["pricing", "faq"]);
  });

  it("fixes the delay rules by position", () => {
    expect(() => parseSteps([step({ delayMinutes: 5 })])).toThrow(/immediate reply/);
    expect(() => parseSteps([step(), followUp({ delayMinutes: 0 })])).toThrow(/at least one minute/);
    expect(() => parseSteps([step(), followUp({ delayMinutes: 1.5 })])).toThrow(/whole number/);
    expect(() => parseSteps([step(), followUp({ delayMinutes: -1 })])).toThrow(/whole number/);
  });

  it("requires a name and an AI instruction, and bounds the list", () => {
    expect(() => parseSteps([step({ name: " " })])).toThrow(/name is required/);
    expect(() => parseSteps([step({ aiInstructions: "" })])).toThrow(/AI instruction is required/);
    expect(() => parseSteps([step(), ...Array.from({ length: 30 }, () => followUp())])).toThrow(/at most 30/);
    expect(() => parseSteps([step({ knowledgeTags: ["a", "A"] })])).toThrow(/must not repeat/);
  });
});

describe("publish validation", () => {
  it("needs the immediate reply step", () => {
    expect(() => assertPublishable([])).toThrow(/immediate reply/);
    expect(() => assertPublishable(parseSteps([step()]))).not.toThrow();
  });
});

describe("state machines", () => {
  it("allows only the documented run transitions", () => {
    expect(() => assertRunTransition("active", "paused")).not.toThrow();
    expect(() => assertRunTransition("paused", "active")).not.toThrow();
    expect(() => assertRunTransition("interrupted", "active")).toThrow();
    expect(() => assertRunTransition("completed", "cancelled")).toThrow();
    expect(() => assertRunTransition("cancelled", "active")).toThrow();
  });

  it("keeps sent, skipped and cancelled steps final", () => {
    expect(() => assertStepTransition("scheduled", "drafting")).not.toThrow();
    expect(() => assertStepTransition("drafting", "awaiting_review")).not.toThrow();
    expect(() => assertStepTransition("awaiting_review", "sent")).not.toThrow();
    expect(() => assertStepTransition("failed", "scheduled")).not.toThrow();
    expect(() => assertStepTransition("sent", "scheduled")).toThrow();
    expect(() => assertStepTransition("skipped", "sent")).toThrow();
    expect(() => assertStepTransition("scheduled", "sent")).toThrow();
  });
});

describe("interruptReason", () => {
  const facts = (over: { run?: Partial<InterruptFacts["run"]>; record?: Partial<InterruptFacts["record"]>; doNotContact?: boolean; contact?: boolean; suppression?: InterruptFacts["suppression"]; flowActive?: boolean } = {}): InterruptFacts => ({
    run: { triggerMessageId: "m1", replyTypeId: "s1", ...over.run },
    record: { latestInboundMessageId: "m1", replyTypeId: "s1", groupKey: "interested", replyTypeKey: "demo_request", followUps: "continue", workflowState: "waiting", ...over.record },
    doNotContact: over.doNotContact ?? false,
    contact: over.contact ?? false,
    suppression: over.suppression ?? null,
    flowActive: over.flowActive ?? true,
  });

  it("leaves a healthy run alone", () => expect(interruptReason(facts())).toBeNull());
  it("stops on a newer inbound message", () => expect(interruptReason(facts({ record: { latestInboundMessageId: "m2" } }))).toBe("reply"));
  it("stops on do not contact, unsubscribe and bounce", () => {
    expect(interruptReason(facts({ doNotContact: true }))).toBe("do_not_contact");
    expect(interruptReason(facts({ suppression: "unsubscribed" }))).toBe("unsubscribed");
    expect(interruptReason(facts({ suppression: "complaint" }))).toBe("unsubscribed");
    expect(interruptReason(facts({ suppression: "bounced" }))).toBe("bounce");
  });
  it("stops a contact's run with the converted reason, after do not contact and suppression", () => {
    expect(interruptReason(facts({ contact: true }))).toBe("converted");
    expect(interruptReason(facts({ contact: true, doNotContact: true }))).toBe("do_not_contact");
    expect(interruptReason(facts({ contact: true, suppression: "bounced" }))).toBe("bounce");
  });
  it("stops when the campaign turns After a reply off, after the facts about the lead", () => {
    expect(interruptReason(facts({ flowActive: false }))).toBe("after_reply_off");
    expect(interruptReason(facts({ flowActive: false, doNotContact: true }))).toBe("do_not_contact");
    expect(interruptReason(facts({ flowActive: false, record: { latestInboundMessageId: "m2" } }))).toBe("reply");
  });
  it("stops when the record closes", () => expect(interruptReason(facts({ record: { workflowState: "closed" } }))).toBe("record_closed"));
  it("stops on a move to a type set to stop follow-ups, not on a start there", () => {
    const moved = facts({ record: { replyTypeId: "s2", groupKey: "not_interested", replyTypeKey: "not_required_right_now", followUps: "stop" } });
    expect(interruptReason(moved)).toBe("terminal_stage");
    const startedThere = facts({ run: { replyTypeId: "s2" }, record: { replyTypeId: "s2", groupKey: "not_interested", replyTypeKey: "not_required_right_now", followUps: "stop" } });
    expect(interruptReason(startedThere)).toBeNull();
    expect(interruptReason(facts({ record: { replyTypeId: "s3", replyTypeKey: "meeting_requested" } }))).toBeNull();
  });
  it("reads the type's Follow-ups rule, not its group or key", () => {
    expect(interruptReason(facts({ record: { replyTypeId: "s2", groupKey: "not_interested", replyTypeKey: "not_required_right_now", followUps: "continue" } }))).toBeNull();
    expect(interruptReason(facts({ record: { replyTypeId: "s2", groupKey: "other", replyTypeKey: "out_of_office", followUps: "stop" } }))).toBe("terminal_stage");
    expect(interruptReason(facts({ record: { replyTypeId: "s2", groupKey: "interested", replyTypeKey: "pricing_question", followUps: "stop" } }))).toBe("terminal_stage");
  });
});

describe("followUpsContinue", () => {
  it("lets follow-ups run only for a type set to continue", () => {
    expect(followUpsContinue("continue")).toBe(true);
    expect(followUpsContinue("stop")).toBe(false);
    expect(followUpsContinue(null)).toBe(false);
  });
});

describe("start position", () => {
  it("starts at the reply, or at the first follow-up when a person already answered", () => {
    expect(startPosition({ stepCount: 3, answered: false })).toBe(1);
    expect(startPosition({ stepCount: 3, answered: true })).toBe(2);
    expect(startPosition({ stepCount: 1, answered: true })).toBeNull();
    expect(startPosition({ stepCount: 0, answered: false })).toBeNull();
    expect(startPosition({ stepCount: 2, answered: false, skipReply: true })).toBe(2);
  });
});

describe("scheduling in the organization time zone", () => {
  it("adds exact minutes for delays that are not whole days", () => {
    expect(dueAfter(new Date("2026-03-01T10:00:00Z"), 90, "America/New_York").toISOString()).toBe("2026-03-01T11:30:00.000Z");
  });

  it("keeps the local wall-clock time across a spring-forward change", () => {
    // 09:00 New York on Sat 7 Mar 2026 is 14:00Z (EST). Two days later DST has started: 09:00 EDT is 13:00Z.
    expect(dueAfter(new Date("2026-03-07T14:00:00Z"), 2 * 1440, "America/New_York").toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("keeps the local wall-clock time across a fall-back change", () => {
    // 09:00 EDT on Sat 31 Oct 2026 is 13:00Z. Two days later, after the change, 09:00 EST is 14:00Z.
    expect(dueAfter(new Date("2026-10-31T13:00:00Z"), 2 * 1440, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("moves a time skipped by a DST jump forward", () => {
    // 02:30 on 8 Mar 2026 does not exist in New York. A 1-day delay from 02:30 EST on the 7th lands at 03:30 EDT.
    expect(dueAfter(new Date("2026-03-07T07:30:00Z"), 1440, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(dueAfter(new Date("2026-01-01T00:00:00Z"), 1440, "Not/AZone").toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("plans due dates cumulatively from the start position", () => {
    const start = new Date("2026-06-01T09:00:00Z");
    const plan = planDueDates(start, [{ position: 1, delayMinutes: 0 }, { position: 2, delayMinutes: 1440 }, { position: 3, delayMinutes: 60 }], 1, "UTC");
    expect([...plan.values()].map((d) => d.toISOString())).toEqual(["2026-06-01T09:00:00.000Z", "2026-06-02T09:00:00.000Z", "2026-06-02T10:00:00.000Z"]);
    const late = planDueDates(start, [{ position: 1, delayMinutes: 0 }, { position: 2, delayMinutes: 60 }], 2, "UTC");
    expect([...late.keys()]).toEqual([2]);
    expect(late.get(2)?.toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });
});

describe("invariants SQL cannot express", () => {
  it("refuses a conversation of another record", () => {
    expect(() => assertConversationBelongsToRecord({ recordId: "r1" }, "r1")).not.toThrow();
    expect(() => assertConversationBelongsToRecord({ recordId: "r2" }, "r1")).toThrow(/not part of this reply handling/);
    expect(() => assertConversationBelongsToRecord(null, "r1")).toThrow();
  });
  it("refuses a step of another version", () => {
    expect(() => assertStepsBelongToVersion([{ sequenceVersionId: "v1" }], "v1")).not.toThrow();
    expect(() => assertStepsBelongToVersion([{ sequenceVersionId: "v1" }, { sequenceVersionId: "v2" }], "v1")).toThrow(/pinned/);
  });
});

describe("drafting helpers", () => {
  it("renders merge fields case-insensitively and blanks unknown ones", () => {
    expect(renderTemplate("Hi {{firstName}} at {{ Company }}{{nope}}", { firstname: "Lena", company: "Acme" })).toBe("Hi Lena at Acme");
  });
  it("tells the model whether the step answers or follows up", () => {
    const reply = stepGuidance({ position: 1, name: "Reply", aiInstructions: "Answer.", bodyTemplate: null }, {});
    const nudge = stepGuidance({ position: 2, name: "Nudge", aiInstructions: "Ask for a time.", bodyTemplate: "Hi {{firstName}}" }, { firstName: "Lena" });
    expect(reply).toContain("answers the lead's latest message");
    expect(nudge).toContain("has not replied");
    expect(nudge).toContain("Hi Lena");
  });
});
