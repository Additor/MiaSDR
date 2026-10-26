import { describe, expect, it } from "vitest";
import {
  blankFollowUp,
  blankReply,
  delayText,
  delayToMinutes,
  earlierVersionNote,
  formChanged,
  lockedNote,
  parseTags,
  splitDelay,
  stepsFromApi,
  stepsPayload,
  validateSteps,
  type EditorStep,
} from "./after-reply-form";

const ready = (over: Partial<EditorStep> = {}): EditorStep => ({ ...blankFollowUp(), aiInstructions: "Ask for a time.", ...over });

describe("delays", () => {
  it("shows the largest unit that keeps a whole number", () => {
    expect(splitDelay(3 * 1440)).toEqual({ amount: 3, unit: "days" });
    expect(splitDelay(120)).toEqual({ amount: 2, unit: "hours" });
    expect(splitDelay(90)).toEqual({ amount: 90, unit: "minutes" });
    expect(splitDelay(0)).toEqual({ amount: 0, unit: "minutes" });
  });
  it("converts a typed amount to minutes", () => {
    expect(delayToMinutes(3, "days")).toBe(4320);
    expect(delayToMinutes(2, "hours")).toBe(120);
    expect(delayToMinutes(1.9, "days")).toBe(1440);
    expect(delayToMinutes(-4, "days")).toBe(0);
    expect(delayToMinutes(Number.NaN, "days")).toBe(0);
  });
  it("writes a delay in words", () => {
    expect(delayText(0)).toBe("No wait");
    expect(delayText(1440)).toBe("1 day");
    expect(delayText(2880)).toBe("2 days");
    expect(delayText(60)).toBe("1 hour");
    expect(delayText(45)).toBe("45 minutes");
  });
});

describe("steps", () => {
  it("starts with one empty reply step when nothing is saved", () => {
    expect(stepsFromApi([])).toEqual([blankReply()]);
    expect(blankReply().delayMinutes).toBe(0);
  });
  it("turns null templates into empty text and back", () => {
    const [step] = stepsFromApi([{ name: "Reply", delayMinutes: 0, subjectTemplate: null, bodyTemplate: null, aiInstructions: "Answer.", knowledgeTags: ["faq"] }]);
    expect(step.subjectTemplate).toBe("");
    expect(stepsPayload([step])[0]).toMatchObject({ subjectTemplate: null, bodyTemplate: null, knowledgeTags: ["faq"] });
  });
  it("parses tags and drops empties and repeats", () => {
    expect(parseTags(" pricing, faq ,, Pricing,")).toEqual(["pricing", "faq"]);
    expect(parseTags("")).toEqual([]);
  });
  it("forces step 1 to no delay and trims text in the payload", () => {
    const payload = stepsPayload([{ ...blankReply(), delayMinutes: 500, aiInstructions: "  Answer.  " }, ready({ name: " ", subjectTemplate: " Re " })]);
    expect(payload[0]).toMatchObject({ delayMinutes: 0, aiInstructions: "Answer." });
    expect(payload[1]).toMatchObject({ name: "Follow-up", subjectTemplate: "Re" });
  });
});

describe("validateSteps", () => {
  it("asks for the reply step", () => {
    expect(validateSteps([])).toEqual([{ step: null, message: "Add the reply step." }]);
  });
  it("needs a goal on every step", () => {
    const issues = validateSteps([{ ...blankReply(), aiInstructions: "Answer." }, blankFollowUp(), ready({ aiInstructions: "  " })]);
    expect(issues).toEqual([
      { step: 2, message: "Step 2 needs a goal." },
      { step: 3, message: "Step 3 needs a goal." },
    ]);
  });
  it("needs a wait of at least a minute after step 1 and ignores the reply step's delay", () => {
    expect(validateSteps([{ ...blankReply(), aiInstructions: "Answer." }, ready({ delayMinutes: 0 })])).toEqual([{ step: 2, message: "Step 2 must wait at least one minute." }]);
    expect(validateSteps([{ ...blankReply(), aiInstructions: "Answer." }, ready()])).toEqual([]);
  });
  it("caps the list at 30 steps", () => {
    const steps = [{ ...blankReply(), aiInstructions: "Answer." }, ...Array.from({ length: 30 }, () => ready())];
    expect(validateSteps(steps)).toEqual([{ step: null, message: "Use at most 30 steps." }]);
  });
  it("rejects a knowledge tag over 80 characters", () => {
    expect(validateSteps([{ ...blankReply(), aiInstructions: "Answer.", knowledgeTags: ["x".repeat(81)] }])).toHaveLength(1);
    expect(validateSteps([{ ...blankReply(), aiInstructions: "Answer.", knowledgeTags: Array.from({ length: 51 }, (_, i) => `t${i}`) }])).toHaveLength(1);
  });
});

describe("formChanged", () => {
  const saved = { mode: "ai_drafts", steps: [{ ...blankReply(), aiInstructions: "Answer." }] };
  it("ignores the steps while the mode is handoff", () => {
    expect(formChanged({ mode: "handoff", steps: [], saved: { mode: "handoff", steps: [] } })).toBe(false);
    expect(formChanged({ mode: "handoff", steps: [blankReply(), blankFollowUp()], saved: { mode: "handoff", steps: [blankReply()] } })).toBe(false);
  });
  it("sees a mode switch and a step edit", () => {
    expect(formChanged({ mode: "handoff", steps: saved.steps, saved })).toBe(true);
    expect(formChanged({ mode: "ai_drafts", steps: saved.steps, saved })).toBe(false);
    expect(formChanged({ mode: "ai_drafts", steps: [{ ...saved.steps[0], aiInstructions: "Answer. " }], saved })).toBe(false);
    expect(formChanged({ mode: "ai_drafts", steps: [{ ...saved.steps[0], aiInstructions: "Answer it." }], saved })).toBe(true);
  });
});

describe("notes", () => {
  it("adds the private reply line for a personal campaign only when missing", () => {
    expect(lockedNote(null, true)).toBeNull();
    expect(lockedNote("AI follow-up drafts are available for email campaigns.", true)).toBe("AI follow-up drafts are available for email campaigns. Replies stay out of the Inbox.");
    expect(lockedNote("AI follow-up drafts are available for email campaigns.", false)).toBe("AI follow-up drafts are available for email campaigns.");
    const own = "Personal campaigns keep replies out of the Inbox, so they cannot draft follow-ups.";
    expect(lockedNote(own, true)).toBe(own);
  });
  it("counts follow-ups on an earlier version", () => {
    expect(earlierVersionNote(0)).toBeNull();
    expect(earlierVersionNote(1)).toBe("1 follow-up uses an earlier version");
    expect(earlierVersionNote(12)).toBe("12 follow-ups use an earlier version");
  });
});
