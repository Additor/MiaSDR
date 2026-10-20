import { describe, expect, it } from "vitest";
import { DEFAULT_LIFECYCLE, isFilterActive, leadFilterParams, lifecycleOf, MAX_FILTER_IDS, MAX_MATCHING_IDS, matchingSelection, parseLeadFilter, parseLeadSort, selectionExport } from "./lead-filter";

const read = (params: Record<string, string>) => (key: string) => params[key];
const UUID = "0b9c8a3e-1d2f-4a5b-8c7d-9e0f1a2b3c4d";

describe("parseLeadFilter", () => {
  it("reads every param", () => {
    const filter = parseLeadFilter(
      read({ q: " acme ", campaign: UUID, notCampaign: UUID, email: "yes", linkedin: "no", dnc: "yes", source: "import", from: "2024-01-02", to: "2024-02-03", category: "interested", ids: `${UUID},${UUID}` }),
    );
    expect(filter).toEqual({
      query: "acme", campaign: UUID, notInCampaign: UUID, hasEmail: true, hasLinkedin: false, doNotContact: true,
      source: "import", createdFrom: "2024-01-02", createdTo: "2024-02-03", category: "interested", ids: [UUID],
    });
  });

  it("drops values that do not parse", () => {
    const filter = parseLeadFilter(read({ q: "  ", campaign: "x'; drop", notCampaign: "nope", email: "maybe", source: "a b", from: "2024-13-40", to: "yesterday", category: "Bad Value", ids: "1,2" }));
    expect(filter).toEqual({});
    expect(isFilterActive(filter)).toBe(false);
  });

  it("accepts any and none for the campaign", () => {
    expect(parseLeadFilter(read({ campaign: "any" })).campaign).toBe("any");
    expect(parseLeadFilter(read({ campaign: "none" })).campaign).toBe("none");
  });

  it("round-trips through the URL params", () => {
    const filter = parseLeadFilter(read({ q: "a b", campaign: "none", email: "no", dnc: "no", source: "grid", from: "2024-01-01", category: "customer" }));
    const params = leadFilterParams(filter);
    expect(parseLeadFilter((key) => params.get(key))).toEqual(filter);
  });
});

describe("lifecycle and hasConversation", () => {
  it("reads lifecycle=contact and lifecycle=all, and leaves the default out", () => {
    expect(parseLeadFilter(read({ lifecycle: "contact" }))).toEqual({ lifecycle: "contact" });
    expect(parseLeadFilter(read({ lifecycle: "all" }))).toEqual({ lifecycle: "all" });
    expect(parseLeadFilter(read({ lifecycle: "lead" }))).toEqual({});
  });

  it("falls back to the default for an unknown lifecycle value", () => {
    for (const value of ["", "customer", "ALL", "contact,lead", "1"]) {
      const filter = parseLeadFilter(read({ lifecycle: value }));
      expect(filter, value).toEqual({});
      expect(lifecycleOf(filter), value).toBe(DEFAULT_LIFECYCLE);
    }
  });

  it("applies the default through lifecycleOf, also for a filter that never set it", () => {
    expect(DEFAULT_LIFECYCLE).toBe("lead");
    expect(lifecycleOf({})).toBe("lead");
    expect(lifecycleOf({ lifecycle: "all" })).toBe("all");
  });

  it("does not count the default as an active filter, and counts contact, all and hasConversation", () => {
    expect(isFilterActive({ lifecycle: "lead" })).toBe(false);
    expect(isFilterActive({ lifecycle: "contact" })).toBe(true);
    expect(isFilterActive({ lifecycle: "all" })).toBe(true);
    expect(isFilterActive({ hasConversation: true })).toBe(true);
    expect(isFilterActive({ hasConversation: false })).toBe(true);
  });

  it("writes lifecycle to the URL only when it is not the default, and round-trips", () => {
    expect(leadFilterParams({ lifecycle: "lead" }).toString()).toBe("");
    expect(leadFilterParams({ lifecycle: "all", hasConversation: true }).toString()).toBe("hasConversation=yes&lifecycle=all");
    for (const filter of [{ lifecycle: "contact" as const }, { lifecycle: "all" as const, hasConversation: false, replied: true }, { hasConversation: true }]) {
      const params = leadFilterParams(filter);
      expect(parseLeadFilter((key) => params.get(key))).toEqual(filter);
    }
  });
});

describe("isFilterActive", () => {
  it("is false for an empty or blank filter and true for each field", () => {
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ query: "  " })).toBe(false);
    expect(isFilterActive({ ids: [] })).toBe(false);
    for (const filter of [{ query: "a" }, { campaign: "any" }, { notInCampaign: UUID }, { hasEmail: false }, { hasLinkedin: false }, { doNotContact: false }, { source: "x" }, { createdFrom: "2024-01-01" }, { createdTo: "2024-01-01" }, { category: "customer" }, { ids: [UUID] }]) {
      expect(isFilterActive(filter), JSON.stringify(filter)).toBe(true);
    }
  });
});

describe("sort parsing", () => {
  it("defaults to newest first and picks natural directions", () => {
    expect(parseLeadSort(undefined, undefined)).toEqual({ key: "created", dir: "desc" });
    expect(parseLeadSort("bogus", "asc")).toEqual({ key: "created", dir: "desc" });
    expect(parseLeadSort("name", undefined)).toEqual({ key: "name", dir: "asc" });
    // People have no Updated column, so an old bookmark with sort=updated gets the default sort.
    expect(parseLeadSort("updated", undefined)).toEqual({ key: "created", dir: "desc" });
    expect(parseLeadSort("updated", "asc")).toEqual({ key: "created", dir: "desc" });
    expect(parseLeadSort("email", "desc")).toEqual({ key: "email", dir: "desc" });
  });
});

describe("selectionExport", () => {
  it("exports the whole selection up to the cap", () => {
    const ids = Array.from({ length: MAX_FILTER_IDS }, (_, i) => `id${i}`);
    expect(selectionExport(ids)).toEqual({ ids, capped: false, label: "Export selected" });
  });

  it("caps a larger selection and says so in the label", () => {
    const ids = Array.from({ length: MAX_FILTER_IDS + 25 }, (_, i) => `id${i}`);
    const out = selectionExport(ids);
    expect(out.ids).toHaveLength(MAX_FILTER_IDS);
    expect(out.ids[0]).toBe("id0");
    expect(out.capped).toBe(true);
    expect(out.label).toBe(`Export first ${MAX_FILTER_IDS} of ${MAX_FILTER_IDS + 25}`);
  });
});

describe("matchingSelection", () => {
  it("offers to select every match while some are not ticked", () => {
    expect(matchingSelection(50, 1200)).toEqual({ canSelectAll: true, capped: false, reach: 1200 });
  });

  it("stops offering once every match is ticked", () => {
    expect(matchingSelection(1200, 1200)).toEqual({ canSelectAll: false, capped: false, reach: 1200 });
  });

  it("reaches only the cap for a larger filter and reports it once the cap is ticked", () => {
    expect(matchingSelection(50, MAX_MATCHING_IDS + 10)).toEqual({ canSelectAll: true, capped: false, reach: MAX_MATCHING_IDS });
    expect(matchingSelection(MAX_MATCHING_IDS, MAX_MATCHING_IDS + 10)).toEqual({ canSelectAll: false, capped: true, reach: MAX_MATCHING_IDS });
  });
});

describe("import source filter", () => {
  it("keeps the source of one import run, so the result screen can link to its new leads", () => {
    expect(parseLeadFilter(read({ source: `import:${UUID}` })).source).toBe(`import:${UUID}`);
  });
});

describe("replied and last contact filters", () => {
  it("reads and writes replied, lastFrom and lastTo", () => {
    const filter = parseLeadFilter(read({ replied: "yes", lastFrom: "2026-09-01", lastTo: "2026-10-01" }));
    expect(filter).toEqual({ replied: true, lastContactFrom: "2026-09-01", lastContactTo: "2026-10-01" });
    expect(isFilterActive(filter)).toBe(true);
    const params = leadFilterParams(filter);
    expect(parseLeadFilter((key) => params.get(key))).toEqual(filter);
  });

  it("keeps replied=no as a filter and drops bad dates", () => {
    expect(parseLeadFilter(read({ replied: "no", lastFrom: "2026-02-31", lastTo: "soon" }))).toEqual({ replied: false });
    expect(isFilterActive({ replied: false })).toBe(true);
  });
});
