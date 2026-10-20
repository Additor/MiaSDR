import { describe, expect, it } from "vitest";
import {
  EMPTY_PREVIEW,
  SECOND_CONFIRM_ABOVE,
  applyRetry,
  bulkEffectsText,
  bulkPermanenceText,
  bulkReportText,
  contactDealText,
  defaultTitle,
  mergeReports,
  needsSecondConfirm,
  permanenceText,
  retryableIds,
  secondConfirmText,
  singleEffectsText,
  sumPreviews,
} from "./deal-effects";

describe("Create deal effects text", () => {
  it("names each effect and leaves out a zero count", () => {
    expect(singleEffectsText("Ada Lovelace", { ...EMPTY_PREVIEW, people: 1, enrollments: 2, runs: 1, followUpDraftsToRetire: 1 })).toBe(
      "Moves Ada Lovelace to Contacts. Stops 2 campaign enrollments. Ends 1 follow-up in progress. Discards 1 follow-up draft that waits for approval.",
    );
    expect(singleEffectsText("Ada Lovelace", { ...EMPTY_PREVIEW, people: 1 })).toBe("Moves Ada Lovelace to Contacts.");
    expect(singleEffectsText("Ada", { ...EMPTY_PREVIEW, people: 1, followUpDraftsToRetire: 3 })).toBe("Moves Ada to Contacts. Discards 3 follow-up drafts that wait for approval.");
  });

  it("sums bulk previews and says what it skips", () => {
    const sum = sumPreviews([
      { ...EMPTY_PREVIEW, people: 400, enrollments: 10 },
      { ...EMPTY_PREVIEW, people: 30, alreadyContacts: 20, skippedPersonalCampaign: 1, runs: 2 },
    ]);
    expect(sum).toEqual({ people: 430, alreadyContacts: 20, enrollments: 10, runs: 2, followUpDraftsToRetire: 0, skippedPersonalCampaign: 1 });
    expect(bulkEffectsText(sum)).toBe(
      "Moves 430 leads to Contacts. Stops 10 campaign enrollments. Ends 2 follow-ups in progress. Skips 20 people who are already contacts. Skips 1 lead in another member's personal campaign. These 430 people cannot go back to Leads or join a campaign again, even if you delete their deals.",
    );
    expect(bulkEffectsText({ ...EMPTY_PREVIEW, alreadyContacts: 1 })).toBe("No lead here can get a deal. Skips 1 person who is already a contact.");
  });

  it("states the permanence of each conversion", () => {
    expect(permanenceText("Ada Lovelace", { withDeal: true })).toBe("Ada Lovelace cannot go back to Leads or join a campaign again, even if you delete the deal.");
    expect(permanenceText("Ada Lovelace", { withDeal: false })).toBe("Ada Lovelace cannot go back to Leads or join a campaign again.");
    expect(bulkPermanenceText(2)).toBe("These 2 people cannot go back to Leads or join a campaign again, even if you delete their deals.");
    expect(bulkPermanenceText(1)).toBe("This person cannot go back to Leads or join a campaign again, even if you delete their deal.");
    // A bulk preview that converts nobody has no permanence line.
    expect(bulkEffectsText({ ...EMPTY_PREVIEW, alreadyContacts: 3 })).not.toContain("cannot go back");
  });

  it("names the open deals of a contact in contact mode and says nothing of outreach", () => {
    expect(contactDealText("Ada Lovelace", 0)).toBe("Adds a deal for Ada Lovelace.");
    expect(contactDealText("Ada Lovelace", 1)).toBe("Adds a deal for Ada Lovelace. Ada Lovelace already has 1 open deal.");
    expect(contactDealText("Ada Lovelace", 3)).toBe("Adds a deal for Ada Lovelace. Ada Lovelace already has 3 open deals.");
  });

  it("asks a second time above 50 converted leads and counts preview.people", () => {
    expect(SECOND_CONFIRM_ABOVE).toBe(50);
    expect(needsSecondConfirm({ ...EMPTY_PREVIEW, people: 50, alreadyContacts: 40 })).toBe(false);
    expect(needsSecondConfirm({ ...EMPTY_PREVIEW, people: 51 })).toBe(true);
    expect(secondConfirmText(430)).toEqual({
      question: "Make 430 leads contacts for good?",
      lines: ["These 430 leads cannot go back to Leads or join a campaign again. Deleting their deals later does not bring them back.", "This cannot be undone."],
      confirm: "Create 430 deals",
    });
  });

  it("merges reports that add up", () => {
    const merged = mergeReports([
      { created: [{ personId: "a", dealId: "d1" }], skipped: [{ personId: "b", reason: "already_converted" }] },
      { created: [{ personId: "c", dealId: "d2" }], skipped: [{ personId: "e", reason: "already_converted" }, { personId: "f", reason: "personal_campaign" }] },
    ]);
    expect(merged.created).toHaveLength(2);
    expect(bulkReportText(merged)).toBe("Created 2 deals. Skipped 3: 2 were already contacts, 1 is in another member's personal campaign.");
    expect(bulkReportText({ created: [{ personId: "a", dealId: "d" }], skipped: [] })).toBe("Created 1 deal.");
  });

  it("sends the retryable ids once more and replaces their entries with the second answer", () => {
    const first = {
      created: [{ personId: "a", dealId: "d1" }],
      skipped: [
        { personId: "b", reason: "retryable" as const },
        { personId: "c", reason: "already_converted" as const },
        { personId: "e", reason: "retryable" as const },
      ],
    };
    expect(retryableIds(first)).toEqual(["b", "e"]);
    const merged = applyRetry(first, { created: [{ personId: "b", dealId: "d2" }], skipped: [{ personId: "e", reason: "retryable" }] });
    expect(merged).toEqual({
      created: [
        { personId: "a", dealId: "d1" },
        { personId: "b", dealId: "d2" },
      ],
      skipped: [
        { personId: "c", reason: "already_converted" },
        { personId: "e", reason: "retryable" },
      ],
    });
    expect(bulkReportText(merged)).toBe("Created 2 deals. Skipped 2: 1 was already a contact, 1 met another change and can be tried again.");
  });

  it("defaults the title to company and name", () => {
    expect(defaultTitle("Ada Lovelace", "Analytical")).toBe("Analytical, Ada Lovelace");
    expect(defaultTitle("Ada Lovelace", null)).toBe("Ada Lovelace");
    expect(defaultTitle(null, " ")).toBe("New deal");
  });
});
