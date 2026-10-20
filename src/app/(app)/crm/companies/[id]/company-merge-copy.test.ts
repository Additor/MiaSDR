import { describe, expect, it } from "vitest";
import { deleteCompanyDescription, keepOptionLabel, mergePreviewLines, type MergePreview } from "./company-merge-copy";

const preview = (over: Partial<MergePreview> = {}): MergePreview => ({
  kept: { id: "k", name: "Acme", domain: "acme.com", version: 1, people: 3 },
  other: { id: "o", name: "Globex", domain: "globex.com", version: 0, people: 2 },
  moves: { contacts: 1, leads: 1, openDeals: 1, deals: 2, leadsInRunningCampaigns: 0 },
  fieldConflicts: [],
  filledFields: [],
  aliasDomains: [],
  ...over,
});

describe("mergePreviewLines", () => {
  it("says what moves, which domain joins, and ends in the permanence line", () => {
    expect(mergePreviewLines(preview())).toEqual([
      "Globex (globex.com) merges into Acme (acme.com).",
      "1 contact and 1 lead move to Acme.",
      "2 deals follow their contacts.",
      "globex.com becomes another domain of Acme. Imports and person forms with globex.com attach people to Acme.",
      "This cannot be undone.",
    ]);
  });

  it("drops zero parts and names conflicts, filled fields, campaigns and earlier other domains", () => {
    const lines = mergePreviewLines(
      preview({
        other: { id: "o", name: null, domain: "globex.com", version: 0, people: 1 },
        moves: { contacts: 0, leads: 1, openDeals: 0, deals: 1, leadsInRunningCampaigns: 1 },
        fieldConflicts: [{ key: "x_tier", name: "Tier", kept: "Gold", other: "Silver" }],
        filledFields: [{ key: "linkedin_url", name: "LinkedIn page", value: "https://www.linkedin.com/company/globex/" }],
        aliasDomains: ["initech.com"],
      }),
    );
    expect(lines).toEqual([
      "globex.com (globex.com) merges into Acme (acme.com).",
      "1 lead moves to Acme.",
      "1 deal follows their contacts.",
      "1 lead in running campaigns gets Acme's name in their next emails.",
      "globex.com becomes another domain of Acme. Imports and person forms with globex.com attach people to Acme.",
      "initech.com moves to Acme too.",
      "Acme keeps its Tier: Gold. MiaSDR drops globex.com's value (Silver).",
      "Acme takes globex.com's LinkedIn page: https://www.linkedin.com/company/globex/.",
      "This cannot be undone.",
    ]);
  });

  it("leaves out the people line when nobody moves", () => {
    expect(mergePreviewLines(preview({ moves: { contacts: 0, leads: 0, openDeals: 0, deals: 0, leadsInRunningCampaigns: 0 } }))).toHaveLength(3);
  });
});

describe("labels", () => {
  it("counts contacts in the keep radio and names the domain in the delete text", () => {
    expect(keepOptionLabel({ name: "Acme", domain: "acme.com", contacts: 1 })).toBe("Acme (acme.com), 1 contact");
    expect(keepOptionLabel({ name: null, domain: "acme.com", contacts: 0 })).toBe("acme.com (acme.com), 0 contacts");
    expect(deleteCompanyDescription("Acme", "acme.com")).toBe(
      "Acme has no contacts or leads. Deleting it removes its details, its custom field values and its other domains. Imports with acme.com or its other domains create a new company. This cannot be undone.",
    );
  });
});
