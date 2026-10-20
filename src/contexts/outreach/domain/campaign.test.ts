import { describe, expect, it } from "vitest";
import { acceptsEnrollments, canArchive, canReadPersonalThread, privateThreadHref, canTransition, parseCampaignType, typeEditable, emptyFirstSubjectMessage, parseArchiveFilter, stepsEditable, stepsWithPlaceholders, validateSteps, type StepInput } from "./campaign";

const step = (over: Partial<StepInput> = {}): StepInput => ({ stepNumber: 1, kind: "email", subject: "Hi", body: "Hello", waitDays: 0, ...over });

describe("validateSteps", () => {
  it("accepts a first step and a follow-up", () => {
    expect(validateSteps([step(), step({ stepNumber: 2, subject: "", waitDays: 3 })])).toEqual([]);
  });
  it("needs at least one step and a bounded number of them", () => {
    expect(validateSteps([])[0].message).toMatch(/at least one/);
    const many = Array.from({ length: 11 }, (_, i) => step({ stepNumber: i + 1, waitDays: i === 0 ? 0 : 1 }));
    expect(validateSteps(many)[0].message).toMatch(/at most 10/);
  });
  it("requires a subject and a body on the first step", () => {
    const messages = validateSteps([step({ subject: " ", body: "" })]).map((i) => i.message);
    expect(messages).toEqual(expect.arrayContaining(["The message is empty.", "The first step needs a subject."]));
  });
  it("lets a follow-up leave the subject blank to reply in the thread", () => {
    expect(validateSteps([step(), step({ stepNumber: 2, subject: undefined, waitDays: 2 })])).toEqual([]);
  });
  it("checks the waits", () => {
    expect(validateSteps([step({ waitDays: 1 })])[0].message).toMatch(/wait 0 days/);
    expect(validateSteps([step(), step({ stepNumber: 2, waitDays: 0 })])[0].message).toMatch(/at least 1 day/);
    expect(validateSteps([step(), step({ stepNumber: 2, waitDays: 61 })])[0].message).toMatch(/0 to 60/);
    expect(validateSteps([step(), step({ stepNumber: 2, waitDays: 1.5 })])[0].message).toMatch(/whole number/);
  });
  it("catches a merge field missing a brace", () => {
    expect(validateSteps([step({ body: "Hi {{firstName}" })])[0].message).toMatch(/missing a brace/);
    expect(validateSteps([step({ subject: "Hi {{firstName" })])[0].message).toMatch(/missing a brace/);
  });
  it("catches numbering that is out of order", () => {
    expect(validateSteps([step({ stepNumber: 2 })])[0].message).toMatch(/numbered/);
  });
});

describe("status", () => {
  it("allows only the legal transitions", () => {
    expect(canTransition("draft", "active")).toBe(true);
    expect(canTransition("draft", "paused")).toBe(false);
    expect(canTransition("active", "paused")).toBe(true);
    expect(canTransition("paused", "active")).toBe(true);
    expect(canTransition("completed", "active")).toBe(false);
  });
  it("lets steps change only while nothing is going out", () => {
    expect(stepsEditable("draft")).toBe(true);
    expect(stepsEditable("paused")).toBe(true);
    expect(stepsEditable("active")).toBe(false);
    expect(stepsEditable("completed")).toBe(false);
  });
});

describe("stepsWithPlaceholders", () => {
  it("finds [[placeholders]] in the body or subject, and ignores ordinary brackets", () => {
    expect(stepsWithPlaceholders([step({ body: "We do [[what you do]]" }), step({ stepNumber: 2, body: "ok [1]" }), step({ stepNumber: 3, subject: "[[subject]]" })])).toEqual([1, 3]);
    expect(stepsWithPlaceholders([step({ body: "Case study [PDF] attached" })])).toEqual([]);
  });
});

describe("archive", () => {
  it("archives only a completed campaign", () => {
    expect(canArchive("completed")).toBe(true);
    for (const status of ["draft", "active", "paused"] as const) expect(canArchive(status)).toBe(false);
  });
  it("adds people to any campaign but a completed or an archived one", () => {
    for (const status of ["draft", "active", "paused"]) expect(acceptsEnrollments({ status, archivedAt: null })).toBe(true);
    expect(acceptsEnrollments({ status: "completed" })).toBe(false);
    expect(acceptsEnrollments({ status: "paused", archivedAt: "2026-10-01T00:00:00Z" })).toBe(false);
  });
  it("hides archived campaigns unless the filter says otherwise", () => {
    expect(parseArchiveFilter(undefined)).toBe("hide");
    expect(parseArchiveFilter("nonsense")).toBe("hide");
    expect(parseArchiveFilter("only")).toBe("only");
    expect(parseArchiveFilter("all")).toBe("all");
  });
});

describe("emptyFirstSubjectMessage", () => {
  const step = (subject: string): StepInput => ({ stepNumber: 1, kind: "email", subject, body: "Hi", waitDays: 0 });
  const vars = { firstName: "Ann", company: "" };
  it("passes a subject that renders text", () => {
    expect(emptyFirstSubjectMessage([step("Hello {{firstName}}")], vars)).toBeNull();
  });
  it("blocks a subject made only of unknown or empty fields", () => {
    expect(emptyFirstSubjectMessage([step("{{firstNme}}")], vars)).toMatch(/renders empty/);
    expect(emptyFirstSubjectMessage([step("{{company}}")], vars)).toMatch(/renders empty/);
  });
  it("blocks a blank subject", () => {
    expect(emptyFirstSubjectMessage([step("  ")], vars)).toMatch(/renders empty/);
  });
  it("ignores an empty sequence", () => {
    expect(emptyFirstSubjectMessage([], vars)).toBeNull();
  });
});

describe("campaign type", () => {
  it("reads personal and treats anything else as regular", () => {
    expect(parseCampaignType("personal")).toBe("personal");
    expect(parseCampaignType("regular")).toBe("regular");
    expect(parseCampaignType(undefined)).toBe("regular");
    expect(parseCampaignType("PERSONAL")).toBe("regular");
  });
  it("lets the type change only before the first send", () => {
    expect(typeEditable(false)).toBe(true);
    expect(typeEditable(true)).toBe(false);
  });
  it("lets an owner, an admin or the creator read private replies", () => {
    expect(canReadPersonalThread({ isOwnerOrAdmin: true, actorUserId: "a", createdBy: "b" })).toBe(true);
    expect(canReadPersonalThread({ isOwnerOrAdmin: false, actorUserId: "a", createdBy: "a" })).toBe(true);
    expect(canReadPersonalThread({ isOwnerOrAdmin: false, actorUserId: "a", createdBy: "b" })).toBe(false);
    expect(canReadPersonalThread({ isOwnerOrAdmin: false, actorUserId: "a", createdBy: null })).toBe(false);
  });
});

describe("privateThreadHref", () => {
  const base = "/campaigns/c1";
  const row = { base, enrollmentId: "e1", canRead: true, hasPrivateThread: true };

  it("links the lead row to its private thread for a reader", () => {
    expect(privateThreadHref(row)).toBe("/campaigns/c1/leads/e1/thread");
  });
  it("gives no link when the enrollment has no private thread", () => {
    expect(privateThreadHref({ ...row, hasPrivateThread: false })).toBeNull();
  });
  it("gives no link to someone who may not read the thread", () => {
    expect(privateThreadHref({ ...row, canRead: false })).toBeNull();
  });
});
