import { describe, expect, it } from "vitest";
import { planFoundPeople, splitName, toFoundCandidates } from "./found-people";

describe("splitName", () => {
  it("splits first and rest, and drops credentials after a comma", () => {
    expect(splitName("Jane van Doe, MBA")).toEqual({ firstName: "Jane", lastName: "van Doe", fullName: "Jane van Doe" });
    expect(splitName("Cher")).toEqual({ firstName: "Cher", lastName: null, fullName: "Cher" });
  });
  it("returns nothing for blanks and placeholders", () => {
    expect(splitName(null).fullName).toBeNull();
    expect(splitName("  ").fullName).toBeNull();
    expect(splitName("LinkedIn Member").fullName).toBeNull();
  });
});

describe("toFoundCandidates", () => {
  it("reads slugs from URLs and bare slugs, dedupes, and skips what has none", () => {
    const { candidates, skipped } = toFoundCandidates([
      { key: "a", profile: "https://www.linkedin.com/in/Jane-Doe/?x=1", name: "Jane Doe", headline: "CTO at Acme" },
      { key: "b", profile: "jane-doe", name: "Jane D", headline: null },
      { key: "c", profile: "https://www.linkedin.com/sales/lead/ACwAAA", name: "Sam", headline: null },
      { key: "d", profile: "https://www.linkedin.com/company/acme", name: null, headline: null },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ key: "a", slug: "jane-doe", firstName: "Jane", lastName: "Doe", title: "CTO at Acme" });
    expect(skipped).toEqual(["c", "d"]);
  });
});

describe("toFoundCandidates with member ids", () => {
  it("keeps a result with only a member id, once, and still skips one with neither", () => {
    const { candidates, skipped } = toFoundCandidates([
      { key: "a", profile: "", memberId: "ACwAAAbCdEfGhIj", url: "https://www.linkedin.com/sales/lead/ACwAAAbCdEfGhIj", name: "Sam Lee", headline: null },
      { key: "b", profile: "", memberId: "ACwAAAbCdEfGhIj", name: null, headline: null },
      { key: "c", profile: "", name: "Nobody", headline: null },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ key: "a", slug: null, memberId: "ACwAAAbCdEfGhIj", url: "https://www.linkedin.com/sales/lead/ACwAAAbCdEfGhIj", firstName: "Sam" });
    expect(skipped).toEqual(["c"]);
  });
  it("matches a stored lead by member id", () => {
    const candidate = { key: "k", slug: null, memberId: "ACwAAAbCdEfGhIj", url: null, firstName: "Sam", lastName: null, fullName: "Sam", title: null };
    const existing = { id: "p1", linkedinSlug: null, memberId: "ACwAAAbCdEfGhIj", firstName: null, lastName: null, fullName: null, title: null };
    expect(planFoundPeople([candidate], [existing])).toEqual({ inserts: [], fills: [{ id: "p1", patch: { firstName: "Sam", fullName: "Sam" } }] });
  });
});

describe("planFoundPeople", () => {
  const candidate = { key: "k", slug: "jane", firstName: "Jane", lastName: "Doe", fullName: "Jane Doe", title: "CTO" };

  it("inserts people with no matching slug", () => {
    expect(planFoundPeople([candidate], [])).toEqual({ inserts: [candidate], fills: [] });
  });

  it("fills only empty fields and never replaces a stored value", () => {
    const existing = { id: "p1", linkedinSlug: "jane", firstName: "Janet", lastName: null, fullName: " ", title: "Founder" };
    const plan = planFoundPeople([candidate], [existing]);
    expect(plan.inserts).toEqual([]);
    expect(plan.fills).toEqual([{ id: "p1", patch: { lastName: "Doe", fullName: "Jane Doe" } }]);
  });

  it("does nothing when the lead is complete", () => {
    const existing = { id: "p1", linkedinSlug: "jane", firstName: "J", lastName: "D", fullName: "J D", title: "T" };
    expect(planFoundPeople([candidate], [existing])).toEqual({ inserts: [], fills: [] });
  });
});
