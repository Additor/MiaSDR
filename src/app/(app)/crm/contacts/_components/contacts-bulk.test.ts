import { describe, expect, it } from "vitest";
import { bulkDncTitle, contactsBarModel, dncReportText, mergeDncReports, phoneLineParts, selectedText } from "./contacts-bulk";

describe("contactsBarModel", () => {
  it("shows nothing without a selection", () => {
    expect(contactsBarModel({ selectedCount: 0, total: 30 })).toEqual({ visible: [], selectAll: null });
  });

  it("orders Export selected, Mark do not contact, Clear selection, then More actions, four controls at most", () => {
    const model = contactsBarModel({ selectedCount: 2, total: 30 });
    expect(model.visible).toEqual(["export", "doNotContact", "clear", "more"]);
    expect(model.selectAll).toBe("Select all 30 matching");
  });

  it("drops More actions once every matching contact is ticked", () => {
    expect(contactsBarModel({ selectedCount: 30, total: 30 })).toEqual({ visible: ["export", "doNotContact", "clear"], selectAll: null });
  });

  it("offers the first 5,000 above the cap", () => {
    expect(contactsBarModel({ selectedCount: 1, total: 7200 }).selectAll).toBe("Select the first 5,000 of 7,200");
    expect(contactsBarModel({ selectedCount: 5000, total: 7200 }).visible).not.toContain("more");
  });
});

describe("copy", () => {
  it("counts the selection", () => {
    expect(selectedText(3, false)).toBe("3 selected.");
    expect(selectedText(1200, true)).toBe("1,200 selected, across pages.");
  });

  it("names one person or many in the title", () => {
    expect(bulkDncTitle(1)).toBe("Mark 1 person do not contact?");
    expect(bulkDncTitle(12)).toBe("Mark 12 people do not contact?");
  });

  it("drops the missing parts of the phone line", () => {
    expect(phoneLineParts({ companyName: "Acme", stageName: "Meeting" })).toEqual(["Acme", "Meeting"]);
    expect(phoneLineParts({ companyName: null, stageName: "Meeting" })).toEqual(["Meeting"]);
    expect(phoneLineParts({ companyName: null, stageName: null })).toEqual([]);
  });
});

describe("the bulk do not contact report", () => {
  it("adds up the reports of each chunk", () => {
    const merged = mergeDncReports([
      { marked: 2, skipped: [{ personId: "a", reason: "already_marked" }] },
      { marked: 3, skipped: [{ personId: "b", reason: "retryable" }] },
    ]);
    expect(merged.marked).toBe(5);
    expect(merged.skipped).toHaveLength(2);
  });

  it("reads Marked {n}. with nothing skipped", () => {
    expect(dncReportText({ marked: 4, skipped: [] })).toBe("Marked 4.");
  });

  it("names each skip reason and drops the zero parts", () => {
    expect(
      dncReportText({
        marked: 5,
        skipped: [
          { personId: "a", reason: "already_marked" },
          { personId: "b", reason: "already_marked" },
          { personId: "c", reason: "not_found" },
          { personId: "d", reason: "retryable" },
        ],
      }),
    ).toBe("Marked 5. Skipped 4: 2 already marked, 1 no longer exists, 1 changed and can be tried again.");
    expect(dncReportText({ marked: 0, skipped: [{ personId: "a", reason: "already_marked" }] })).toBe("Marked 0. Skipped 1: 1 already marked.");
    expect(
      dncReportText({
        marked: 1,
        skipped: [
          { personId: "c", reason: "not_found" },
          { personId: "e", reason: "not_found" },
        ],
      }),
    ).toBe("Marked 1. Skipped 2: 2 no longer exist.");
  });
});
