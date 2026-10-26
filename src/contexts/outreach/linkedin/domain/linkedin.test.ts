import { describe, expect, it } from "vitest";
import {
  accountBlock,
  dailyInviteLimit,
  describeLinkedInProgress,
  DEFAULT_LINKEDIN_RULES,
  eventKey,
  eventRetrySeconds,
  INVITE_NOTE_MAX,
  inviteBlock,
  inviteNoteLength,
  inviteNoteProblem,
  linkedinRules,
  linkedinSlug,
  renderLinkedInText,
  resolveRetryMinutes,
  validateLinkedInSteps,
  type LinkedInStep,
} from "./linkedin";
import { defaultWorkingHours } from "../../domain/working-hours";

const steps = (...s: Array<Partial<LinkedInStep>>): LinkedInStep[] =>
  s.map((x, i) => ({ stepNumber: i + 1, kind: i === 0 ? "invitation" : "message", body: "Hi", waitDays: i === 0 ? 0 : 1, ...x }));

describe("validateLinkedInSteps", () => {
  it("accepts an invitation with no note followed by messages", () => {
    expect(validateLinkedInSteps(steps({ body: "" }, { waitDays: 0 }, { waitDays: 2 }))).toEqual([]);
  });
  it("requires the first step to be the invitation and later steps to be messages", () => {
    expect(validateLinkedInSteps(steps({ kind: "message" }))).toHaveLength(1);
    expect(validateLinkedInSteps(steps({}, { kind: "invitation" }))).toHaveLength(1);
  });
  it("needs at least one day between follow-ups, but allows the first message right at acceptance", () => {
    expect(validateLinkedInSteps(steps({}, { waitDays: 0 }, { waitDays: 0 })).map((i) => i.step)).toEqual([3]);
  });
  it("rejects empty messages, bad numbering and unbalanced braces", () => {
    expect(validateLinkedInSteps(steps({}, { body: " " }))[0].step).toBe(2);
    expect(validateLinkedInSteps([{ ...steps({})[0], stepNumber: 2 }])).toHaveLength(1);
    expect(validateLinkedInSteps(steps({ body: "Hi {{firstName" }))).toHaveLength(1);
  });
  it("limits the number of steps", () => {
    expect(validateLinkedInSteps(steps(...Array.from({ length: 7 }, () => ({}))))[0].step).toBeNull();
    expect(validateLinkedInSteps([])).toHaveLength(1);
  });
});

describe("notes and rendering", () => {
  it("measures the note after merge fields are filled", () => {
    const note = renderLinkedInText("Hi {{firstName}} at {{company}}", { firstName: "Ada", company: "Acme" }, () => 0);
    expect(note).toBe("Hi Ada at Acme");
    expect(inviteNoteProblem(note)).toBeNull();
    expect(inviteNoteProblem("x".repeat(301))).toContain("301");
    expect(inviteNoteProblem("x".repeat(300))).toBeNull();
  });
  it("picks a spin option and drops the signature placeholder", () => {
    expect(renderLinkedInText("{Hello|Hey} {{firstName}}\n%signature%", { firstName: "Ada" }, () => 0.99)).toBe("Hey Ada");
  });
});

describe("inviteNoteLength", () => {
  it("counts the note after merge fields, not the template", () => {
    expect(inviteNoteLength("Hi {{firstName}}, I work with {{company}}.", { firstName: "Ada", company: "Analytical Engines" })).toBe("Hi Ada, I work with Analytical Engines.".length);
  });
  it("treats an empty or missing field as nothing and closes the gap", () => {
    expect(inviteNoteLength("Hi {{firstName}} there", { firstName: "" })).toBe("Hi there".length);
    expect(inviteNoteLength("Hi {{firstName}} there", { firstName: null })).toBe("Hi there".length);
    expect(inviteNoteLength("Hi {{company}}", {})).toBe("Hi".length);
    expect(inviteNoteLength("{{firstName}}", { firstName: null })).toBe(0);
  });
  it("counts Korean text per character and an emoji as two units, like the send-time check", () => {
    expect(inviteNoteLength("{{firstName}}님, 안녕하세요", { firstName: "지수" })).toBe("지수님, 안녕하세요".length);
    expect(inviteNoteLength("{{firstName}}님, 안녕하세요", { firstName: "지수" })).toBe(10);
    expect(inviteNoteLength("Hi {{firstName}}", { firstName: "😀" })).toBe(5);
    expect(inviteNoteLength("{{x}}", { x: "ab".repeat(150) })).toBe(300);
    expect(inviteNoteLength("{{x}}", { x: "ab".repeat(150) + "c" })).toBe(301);
  });
  it("takes the longest spin option, ignores the signature placeholder and agrees with inviteNoteProblem", () => {
    const template = "{Hi|Hello there} {{firstName}} %signature%";
    const length = inviteNoteLength(template, { firstName: "Ada" });
    expect(length).toBe("Hello there Ada".length);
    const long = inviteNoteLength("{{x}}", { x: "z".repeat(301) });
    expect(inviteNoteProblem("z".repeat(301))).not.toBeNull();
    expect(long > INVITE_NOTE_MAX).toBe(true);
    expect(inviteNoteProblem("z".repeat(300))).toBeNull();
  });
});

describe("limits and pacing", () => {
  it("prefers the account's own limit, then the plan default", () => {
    expect(dailyInviteLimit({ dailyInviteLimit: 12, isPremium: false }, DEFAULT_LINKEDIN_RULES)).toBe(12);
    expect(dailyInviteLimit({ dailyInviteLimit: null, isPremium: true }, DEFAULT_LINKEDIN_RULES)).toBe(30);
    expect(dailyInviteLimit({ dailyInviteLimit: null, isPremium: false }, DEFAULT_LINKEDIN_RULES)).toBe(5);
  });
  it("blocks on the daily limit first, then the weekly cap", () => {
    expect(inviteBlock({ today: 5, week: 5 }, 5, 100)).toBe("daily_limit");
    expect(inviteBlock({ today: 1, week: 100 }, 5, 100)).toBe("weekly_limit");
    expect(inviteBlock({ today: 1, week: 99 }, 5, 100)).toBeNull();
  });
  it("falls back to defaults for out-of-range organization rules", () => {
    expect(linkedinRules({ invitesPerWeek: 5000, inviteGapMinutes: [9, 3] })).toEqual(DEFAULT_LINKEDIN_RULES);
    expect(linkedinRules({ invitesPerWeek: 40, inviteGapMinutes: [5, 7] })).toMatchObject({ invitesPerWeek: 40, inviteGapMinutes: [5, 7] });
  });
  it("explains why an account cannot act", () => {
    const base = { status: "connected", limitReachedUntil: null, nextAllowedRunAt: null, workingHours: { timeZone: "UTC", days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]])) } };
    const now = new Date("2026-10-14T10:00:00Z");
    expect(accountBlock(now, base)).toBeNull();
    expect(accountBlock(now, { ...base, status: "disconnected" })).toBe("not_connected");
    expect(accountBlock(now, { ...base, limitReachedUntil: new Date("2026-10-15T00:00:00Z") })).toBe("limit_reached");
    expect(accountBlock(now, { ...base, nextAllowedRunAt: new Date("2026-10-14T10:01:00Z") })).toBe("throttled");
    expect(accountBlock(new Date("2026-10-14T20:00:00Z"), { ...base, workingHours: defaultWorkingHours("UTC") })).toBe("outside_hours");
  });
  it("retries lookups after 60 then 120 minutes", () => {
    expect([1, 2, 3].map(resolveRetryMinutes)).toEqual([60, 120, 240]);
  });
  it("backs off webhook retries from 5 seconds up to 15 minutes", () => {
    expect([1, 2, 3, 8].map(eventRetrySeconds)).toEqual([5, 10, 20, 640]);
    expect(eventRetrySeconds(12)).toBe(900);
  });
});

describe("linkedinSlug", () => {
  it("reads slugs from URLs and bare slugs", () => {
    expect(linkedinSlug("https://www.linkedin.com/in/Jane-Doe-123/")).toBe("jane-doe-123");
    expect(linkedinSlug("linkedin.com/in/jane?trk=x")).toBe("jane");
    expect(linkedinSlug("jane-doe")).toBe("jane-doe");
  });
  it("keeps a slug in any script, bare or percent-encoded in a URL", () => {
    // People store the decoded slug, and a resolve sends it back bare.
    expect(linkedinSlug("김철수-a1b2")).toBe("김철수-a1b2");
    expect(linkedinSlug("jöhn-doe")).toBe("jöhn-doe");
    expect(linkedinSlug("https://www.linkedin.com/in/%EA%B9%80%EC%B2%A0%EC%88%98-a1b2/")).toBe("김철수-a1b2");
  });
  it("rejects other hosts and Sales Navigator URLs", () => {
    expect(linkedinSlug("https://example.com/in/jane")).toBeNull();
    expect(linkedinSlug("https://www.linkedin.com/sales/lead/ACwAAA")).toBeNull();
    expect(linkedinSlug("")).toBeNull();
  });
});

describe("eventKey", () => {
  it("keys messages by id and acceptances by member", () => {
    expect(eventKey({ type: "message_received", account: "a", chat: null, messageId: "m1", text: "", fromAccountOwner: false, counterparty: "x" }, "org1")).toBe("unipile:message_received:v2:org1:a:m1");
    expect(eventKey({ type: "message_received", account: "a", chat: null, messageId: "m1", text: "", fromAccountOwner: false, counterparty: "x" }, "org2")).not.toBe("unipile:message_received:v2:org1:a:m1");
    expect(eventKey({ type: "message_received", account: "a", chat: null, messageId: null, text: "", fromAccountOwner: false, counterparty: "x" }, "org1")).toBeNull();
    expect(eventKey({ type: "connection_accepted", account: "a", member: "p", name: null, profileUrl: null }, "org1")).toBe("unipile:new_relation:v2:org1:a:p");
  });
});

describe("describeLinkedInProgress", () => {
  const base = { status: "active", connectionState: "none", currentStep: 0, totalSteps: 3, stopReason: null };
  it("explains a cancelled enrollment of a converted lead", () => {
    expect(describeLinkedInProgress({ ...base, status: "cancelled", stopReason: "converted" })).toMatchObject({ label: "Cancelled", detail: "Became a contact" });
  });
  it("walks the state machine from queued to connected", () => {
    expect(describeLinkedInProgress({ ...base, status: "pending" }).label).toBe("Queued");
    expect(describeLinkedInProgress({ ...base, connectionState: "request_sent", currentStep: 1 }).label).toBe("Invitation sent");
    const connected = describeLinkedInProgress({ ...base, connectionState: "connected", currentStep: 1 });
    expect(connected).toMatchObject({ label: "Connected", tone: "active" });
    expect(connected.detail).toContain("Message 1 of 2");
  });
  it("names the end states", () => {
    expect(describeLinkedInProgress({ ...base, status: "replied", connectionState: "connected" }).label).toBe("Replied");
    expect(describeLinkedInProgress({ ...base, status: "completed", stopReason: "invite_not_accepted" }).label).toBe("Not accepted");
    expect(describeLinkedInProgress({ ...base, status: "completed", connectionState: "connected", currentStep: 3 }).label).toBe("Finished");
    expect(describeLinkedInProgress({ ...base, status: "failed", stopReason: "send_failed: x" })).toMatchObject({ label: "Failed", tone: "bad", detail: "send_failed: x" });
  });
});
