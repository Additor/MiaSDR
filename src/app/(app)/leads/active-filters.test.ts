import { describe, expect, it } from "vitest";
import type { LeadFilter } from "@/contexts/leads/domain/lead-filter";
import { leadFilterParams, parseLeadFilter } from "@/contexts/leads/domain/lead-filter";
import { activeFilterChips, panelFilterCount } from "./active-filters";
import { leadsHref } from "./list-url";

const CAMPAIGN = "0b9c8a3e-1d2f-4a5b-8c7d-9e0f1a2b3c4d";
const options = { campaigns: [{ id: CAMPAIGN, name: "Q4 outreach" }] };

describe("activeFilterChips", () => {
  it("returns no chip for an empty filter", () => {
    expect(activeFilterChips({}, options)).toEqual([]);
  });

  it("names each applied filter and its value", () => {
    const filter: LeadFilter = { query: "acme", campaign: CAMPAIGN, replied: true, lastContactFrom: "2026-09-01", hasEmail: false };
    expect(activeFilterChips(filter, options).map((c) => `${c.name}: ${c.value}`)).toEqual([
      "Search: acme",
      "Campaign: Q4 outreach",
      "Replied: Yes",
      "Last contact from: 2026-09-01",
      "Has email: No",
    ]);
  });

  it("reads any and none as plain words", () => {
    expect(activeFilterChips({ campaign: "any" }, options)[0].value).toBe("In a campaign");
    expect(activeFilterChips({ campaign: "none" }, options)[0].value).toBe("Not in a campaign");
  });

  it("does not make a chip for an explicit id selection", () => {
    expect(activeFilterChips({ ids: [CAMPAIGN] }, options)).toEqual([]);
  });

  it("removes only its own filter", () => {
    const filter: LeadFilter = { query: "acme", replied: false, lastContactTo: "2026-10-01" };
    const chips = activeFilterChips(filter, options);
    const replied = chips.find((c) => c.key === "replied");
    expect(replied?.without).toEqual({ query: "acme", lastContactTo: "2026-10-01" });
    expect(leadFilterParams(replied!.without).toString()).toBe("q=acme&lastTo=2026-10-01");
  });

  it("counts panel filters without the search", () => {
    expect(panelFilterCount(activeFilterChips({ query: "a" }, options))).toBe(0);
    expect(panelFilterCount(activeFilterChips({ query: "a", replied: true, campaign: "none" }, options))).toBe(2);
  });
});

describe("lifecycle chip", () => {
  it("gives the default (leads) no chip, so a plain list shows none", () => {
    expect(activeFilterChips({ lifecycle: "lead" }, options)).toEqual([]);
  });

  it("names Contacts and the mixed list, and counts as a panel filter", () => {
    expect(activeFilterChips({ lifecycle: "contact" }, options).map((c) => `${c.name}: ${c.value}`)).toEqual(["Lifecycle: Contacts"]);
    const chips = activeFilterChips({ query: "acme", lifecycle: "all" }, options);
    expect(chips.map((c) => `${c.name}: ${c.value}`)).toEqual(["Search: acme", "Lifecycle: Leads and contacts"]);
    expect(panelFilterCount(chips)).toBe(1);
  });

  it("removing it goes back to leads with the other filters kept", () => {
    const chip = activeFilterChips({ replied: true, lifecycle: "all" }, options).find((c) => c.key === "lifecycle");
    expect(chip?.without).toEqual({ replied: true, lifecycle: undefined });
    expect(leadsHref({ filter: chip!.without, sort: { key: "created", dir: "desc" } })).toBe("/leads?replied=yes");
  });

  it("round-trips through the URL", () => {
    for (const lifecycle of ["contact", "all"] as const) {
      const href = leadsHref({ filter: { lifecycle, hasConversation: true }, sort: { key: "created", dir: "desc" } });
      expect(href).toBe(`/leads?hasConversation=yes&lifecycle=${lifecycle}`);
      const params = new URL(href, "http://x").searchParams;
      const parsed = parseLeadFilter((key) => params.get(key));
      expect(parsed).toEqual({ lifecycle, hasConversation: true });
      expect(activeFilterChips(parsed, options).map((c) => c.key)).toEqual(["lifecycle", "hasConversation"]);
    }
    // The default posts nothing (the panel's Leads option has an empty value) and reads back as no lifecycle.
    expect(parseLeadFilter((key) => new URLSearchParams("lifecycle=").get(key))).toEqual({});
    expect(parseLeadFilter((key) => new URLSearchParams("lifecycle=lead").get(key))).toEqual({});
  });
});

describe("reply category chip", () => {
  it("reads Reply category, never CRM category", () => {
    expect(activeFilterChips({ category: "interested" }, options).map((c) => `${c.name}: ${c.value}`)).toEqual(["Reply category: Interested"]);
  });
});
