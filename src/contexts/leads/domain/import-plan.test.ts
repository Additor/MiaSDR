import { describe, expect, it } from "vitest";
import { buildCandidates, planImport, suggestMapping, validateMapping, type ExistingPerson, type Mapping } from "./import-plan";

const mapping: Mapping = {
  Email: "email",
  "First Name": "first_name",
  "Last Name": "last_name",
  Title: "title",
  Phone: "phone",
  LinkedIn: "linkedin",
  Website: "company_domain",
  Company: "company_name",
  Notes: "skip",
};

const existing = (over: Partial<ExistingPerson> = {}): ExistingPerson => ({
  id: "p1",
  email: "jane@acme.com",
  linkedinSlug: null,
  linkedinUrl: null,
  firstName: "Jane",
  lastName: "Doe",
  fullName: "Jane Doe",
  title: null,
  phone: null,
  companyId: null,
  companyDomain: null,
  custom: {},
  raw: null,
  ...over,
});

describe("suggestMapping", () => {
  it("maps common English and Korean headers once each", () => {
    const m = suggestMapping(["Email", "First Name", "Last Name", "Job Title", "회사명", "Website", "Random"]);
    expect(m).toMatchObject({
      Email: "email",
      "First Name": "first_name",
      "Last Name": "last_name",
      "Job Title": "title",
      회사명: "company_name",
      Website: "company_domain",
      Random: "custom:Random",
    });
  });
  it("maps company_name and company-name like first_name", () => {
    expect(suggestMapping(["company_name"])).toEqual({ company_name: "company_name" });
    expect(suggestMapping(["Company-Name"])).toEqual({ "Company-Name": "company_name" });
  });
  it("recognizes the Korean LinkedIn and phone headers", () => {
    expect(suggestMapping(["링크드인", "연락처"])).toEqual({ 링크드인: "linkedin", 연락처: "phone" });
  });
  it("does not map two columns to one target", () => {
    const m = suggestMapping(["Email", "E-mail"]);
    expect(Object.values(m).filter((t) => t === "email")).toHaveLength(1);
  });
});

describe("validateMapping", () => {
  it("requires an identifying column", () => {
    expect(validateMapping(["Name"], { Name: "full_name" })).toMatch(/Email or LinkedIn/);
    expect(validateMapping(["Email"], { Email: "email" })).toBeNull();
  });
  it("rejects two columns for one target", () => {
    expect(validateMapping(["A", "B"], { A: "email", B: "email" })).toMatch(/More than one/);
  });
});

describe("buildCandidates", () => {
  it("normalizes values and leaves the full name to the plan", () => {
    const { candidates } = buildCandidates(
      [{ Email: " Jane@Acme.COM ", "First Name": "Jane", "Last Name": "Doe", Website: "https://www.acme.com/x", LinkedIn: "https://linkedin.com/in/jane-d/" }],
      mapping,
    );
    expect(candidates[0]).toMatchObject({
      row: 1,
      email: "jane@acme.com",
      fullName: null,
      companyDomain: "acme.com",
      linkedinSlug: "jane-d",
    });
  });

  it("rejects rows with no identity and reports why", () => {
    const r = buildCandidates([{ Email: "nope", "First Name": "X" }, { Email: "ok@acme.com" }], mapping);
    expect(r.candidates).toHaveLength(1);
    expect(r.invalid).toEqual([{ row: 1, kind: "invalid_email", reason: expect.stringMatching(/"nope" is not a valid email/) }]);
    expect(r.warnings.some((w) => w.row === 1 && /not valid/.test(w.reason))).toBe(true);
  });

  it("tells an empty identifier from a typed one that failed", () => {
    const r = buildCandidates([{ Email: "", "First Name": "X" }, { Email: "not-an-email" }], mapping);
    expect(r.invalid.map((i) => [i.row, i.kind])).toEqual([
      [1, "missing_identifier"],
      [2, "invalid_email"],
    ]);
  });

  it("skips a row that ties two earlier rows to one LinkedIn profile", () => {
    const r = buildCandidates(
      [
        { Email: "a@b.co", LinkedIn: "https://www.linkedin.com/in/jane-d" },
        { Email: "c@d.co" },
        { Email: "c@d.co", LinkedIn: "https://www.linkedin.com/in/jane-d" },
      ],
      mapping,
    );
    expect(r.invalid).toEqual([{ row: 3, kind: "file_conflict", reason: expect.stringMatching(/two different earlier rows/) }]);
    const slugs = r.candidates.map((c) => c.linkedinSlug).filter(Boolean);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps a row whose email is invalid when a LinkedIn profile identifies it, and warns", () => {
    const r = buildCandidates([{ Email: "not-an-email", LinkedIn: "https://www.linkedin.com/in/jane-d" }], mapping);
    expect(r.invalid).toHaveLength(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.warnings).toEqual([{ row: 1, reason: expect.stringMatching(/"not-an-email" is not valid/) }]);
  });

  it("keeps a row whose phone is invalid and warns", () => {
    const r = buildCandidates([{ Email: "a@b.co", Phone: "123" }], mapping);
    expect(r.candidates[0].phone).toBeNull();
    expect(r.warnings).toHaveLength(1);
  });

  it("merges duplicate rows in one file, later non-empty values winning", () => {
    const r = buildCandidates(
      [
        { Email: "a@b.co", Title: "Engineer", Company: "Acme" },
        { Email: "A@B.co", Title: "", Company: "Acme Inc" },
        { Email: "a@b.co", Title: "CTO" },
      ],
      mapping,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.duplicatesInFile).toBe(2);
    expect(r.duplicateRows).toEqual([
      { row: 2, kind: "duplicate", reason: "Same lead as row 1. Its values are merged into that row." },
      { row: 3, kind: "duplicate", reason: "Same lead as row 1. Its values are merged into that row." },
    ]);
    expect(r.candidates[0]).toMatchObject({ title: "CTO", companyName: "Acme Inc" });
  });

  it("treats a row that shares only the LinkedIn profile as the same lead", () => {
    const r = buildCandidates(
      [
        { Email: "a@b.co", LinkedIn: "jane-d" },
        { LinkedIn: "https://linkedin.com/in/jane-d", Title: "CTO" },
      ],
      mapping,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].title).toBe("CTO");
  });

  it("collects custom columns, including non-Latin labels", () => {
    const m: Mapping = { Email: "email", 규모: "custom:회사 규모", Src: "custom:Lead Source" };
    const r = buildCandidates([{ Email: "a@b.co", 규모: "50", Src: "event" }], m);
    expect(r.customColumns.map((c) => c.name).sort()).toEqual(["Lead Source", "회사 규모"]);
    expect(Object.values(r.candidates[0].custom).sort()).toEqual(["50", "event"]);
  });
});

describe("planImport", () => {
  const build = (rows: Array<Record<string, string>>) => buildCandidates(rows, mapping).candidates;

  it("inserts unknown leads and collects companies", () => {
    const plan = planImport(build([{ Email: "new@acme.com", Website: "acme.com", Company: "Acme" }]), []);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.companies.get("acme.com")).toBe("Acme");
  });

  it("updates only what changed and never erases with an empty cell", () => {
    const plan = planImport(build([{ Email: "jane@acme.com", "First Name": "Jane", Title: "CTO", Phone: "" }]), [existing({ title: "Engineer" })]);
    expect(plan.updates).toEqual([{ id: "p1", row: 1, patch: { title: "CTO" } }]);
  });

  it("recomputes the full name from merged first and last names", () => {
    const plan = planImport(build([{ Email: "jane@acme.com", "Last Name": "Smith" }]), [existing()]);
    expect(plan.updates[0].patch).toEqual({ lastName: "Smith", fullName: "Jane Smith" });
  });

  it("derives a full name for new leads from first and last", () => {
    const plan = planImport(build([{ Email: "n@acme.com", "First Name": "Ann", "Last Name": "Lee" }]), []);
    expect(plan.inserts[0].fullName).toBe("Ann Lee");
  });

  it("counts a matching lead with no differences as unchanged", () => {
    const plan = planImport(build([{ Email: "jane@acme.com", "First Name": "Jane", "Last Name": "Doe" }]), [existing()]);
    expect(plan.unchanged).toBe(1);
    expect(plan.updates).toHaveLength(0);
  });

  it("adds a missing LinkedIn profile to an email match", () => {
    const plan = planImport(build([{ Email: "jane@acme.com", LinkedIn: "jane-d" }]), [existing()]);
    expect(plan.updates[0].patch).toEqual({ linkedinSlug: "jane-d", linkedinUrl: "https://www.linkedin.com/in/jane-d/" });
  });

  it("matches on LinkedIn alone and fills the email", () => {
    const plan = planImport(build([{ LinkedIn: "jane-d", Email: "jane@acme.com" }]), [existing({ email: null, linkedinSlug: "jane-d", linkedinUrl: "https://www.linkedin.com/in/jane-d/" })]);
    expect(plan.updates[0].patch).toEqual({ email: "jane@acme.com" });
  });

  it("reports a conflict when email and LinkedIn name two different leads", () => {
    const plan = planImport(build([{ Email: "jane@acme.com", LinkedIn: "bob-b" }]), [
      existing(),
      existing({ id: "p2", email: "bob@acme.com", linkedinSlug: "bob-b" }),
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });

  it("updates a changed company domain", () => {
    const plan = planImport(build([{ Email: "jane@acme.com", Website: "newco.com" }]), [existing({ companyDomain: "acme.com" })]);
    expect(plan.updates[0].patch.companyDomain).toBe("newco.com");
  });

  it("merges only changed custom values", () => {
    const m: Mapping = { Email: "email", A: "custom:Alpha", B: "custom:Beta" };
    const { candidates } = buildCandidates([{ Email: "jane@acme.com", A: "1", B: "2" }], m);
    const plan = planImport(candidates, [existing({ custom: { x_alpha: "1" } })]);
    expect(plan.updates[0].patch.custom).toEqual({ x_beta: "2" });
  });
});

describe("LinkedIn URL handling in imports", () => {
  const build = (rows: Array<Record<string, string>>) => buildCandidates(rows, mapping).candidates;

  it("stores the canonical URL next to the slug", () => {
    const [c] = build([{ Email: "a@b.co", LinkedIn: "linkedin.com/in/Jane-D/?x=1" }]);
    expect(c).toMatchObject({ linkedinSlug: "jane-d", linkedinUrl: "https://www.linkedin.com/in/jane-d/" });
  });

  it("keeps a company page as given with no slug and warns", () => {
    const r = buildCandidates([{ Email: "a@b.co", LinkedIn: "https://www.linkedin.com/company/acme/" }], mapping);
    expect(r.candidates[0]).toMatchObject({ linkedinSlug: null, linkedinUrl: "https://www.linkedin.com/company/acme/" });
    expect(r.warnings).toHaveLength(1);
  });

  it("rejects a row identified only by a non-person URL", () => {
    const r = buildCandidates([{ LinkedIn: "https://www.linkedin.com/sales/lead/ABC" }], mapping);
    expect(r.candidates).toHaveLength(0);
    expect(r.invalid).toHaveLength(1);
  });

  it("identifies a row by the member id of a Sales Navigator URL and keeps the URL as typed", () => {
    const url = "https://www.linkedin.com/sales/lead/ACwAAAbCdEfGhIj,NAME_SEARCH,x";
    const r = buildCandidates([{ LinkedIn: url }], mapping);
    expect(r.invalid).toHaveLength(0);
    expect(r.candidates[0]).toMatchObject({ linkedinSlug: null, linkedinMemberId: "ACwAAAbCdEfGhIj", linkedinUrl: url, raw: { linkedin_member_id: "ACwAAAbCdEfGhIj" } });
  });

  it("matches a stored lead by member id and creates none twice", () => {
    const c = build([{ LinkedIn: "https://www.linkedin.com/sales/lead/ACwAAAbCdEfGhIjKlMnOpQ" }, { LinkedIn: "ACwAAAbCdEfGhIjKlMnOpQ" }]);
    expect(c).toHaveLength(1);
    expect(planImport(c, []).inserts).toHaveLength(1);
    const plan = planImport(c, [existing({ id: "p9", email: null, raw: { linkedin_member_id: "ACwAAAbCdEfGhIjKlMnOpQ" } })]);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.unchanged + plan.updates.length).toBe(1);
  });

  it("reports a conflict when the email matches one lead and the member id another", () => {
    const row = { Email: "jane@acme.com", LinkedIn: "https://www.linkedin.com/sales/lead/ACwAAAbCdEfGhIjKlMnOpQ,NAME" };
    const plan = planImport(build([row]), [existing(), existing({ id: "p2", email: null, raw: { linkedin_member_id: "ACwAAAbCdEfGhIjKlMnOpQ" } })]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });

  it("never overwrites a different member id stored on the matched lead", () => {
    const row = { Email: "jane@acme.com", Title: "CTO", LinkedIn: "https://www.linkedin.com/sales/lead/ACwAAAzzzzzzzzzzzzzzzz" };
    const plan = planImport(build([row]), [existing({ raw: { linkedin_member_id: "ACwAAAbCdEfGhIjKlMnOpQ" } })]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].patch.raw?.linkedin_member_id ?? "ACwAAAbCdEfGhIjKlMnOpQ").toBe("ACwAAAbCdEfGhIjKlMnOpQ");
  });

  it("does not report a different member id as a change when nothing else differs", () => {
    const row = { Email: "jane@acme.com", LinkedIn: "https://www.linkedin.com/sales/lead/ACwAAAzzzzzzzzzzzzzzzz" };
    const plan = planImport(build([row]), [existing({ linkedinUrl: "https://www.linkedin.com/sales/lead/ACwAAAzzzzzzzzzzzzzzzz", raw: { linkedin_member_id: "ACwAAAbCdEfGhIjKlMnOpQ" } })]);
    expect(plan.updates.filter((u) => u.patch.raw)).toHaveLength(0);
  });

  it("ignores a URL on another host", () => {
    const [c] = build([{ Email: "a@b.co", LinkedIn: "https://example.com/in/jane" }]);
    expect(c.linkedinUrl).toBeNull();
  });

  it("fills a missing URL for a lead that only had the slug (backfill through import)", () => {
    const plan = planImport(build([{ Email: "jane@acme.com", LinkedIn: "jane-d" }]), [existing({ linkedinSlug: "jane-d" })]);
    expect(plan.updates[0].patch).toEqual({ linkedinUrl: "https://www.linkedin.com/in/jane-d/" });
  });

  it("does not let a non-person URL replace a stored URL", () => {
    const plan = planImport(
      build([{ Email: "jane@acme.com", LinkedIn: "https://www.linkedin.com/company/acme/" }]),
      [existing({ linkedinSlug: "jane-d", linkedinUrl: "https://www.linkedin.com/in/jane-d/" })],
    );
    expect(plan.unchanged).toBe(1);
  });

  it("lets a profile replace a stored non-person URL", () => {
    const plan = planImport(
      build([{ Email: "jane@acme.com", LinkedIn: "jane-d" }]),
      [existing({ linkedinUrl: "https://www.linkedin.com/pub/jane/1/2/3" })],
    );
    expect(plan.updates[0].patch).toMatchObject({ linkedinSlug: "jane-d", linkedinUrl: "https://www.linkedin.com/in/jane-d/" });
  });

  it("keeps the profile when a later duplicate row carries a company page", () => {
    const r = buildCandidates(
      [
        { Email: "a@b.co", LinkedIn: "jane-d" },
        { Email: "a@b.co", LinkedIn: "https://www.linkedin.com/company/acme/" },
      ],
      mapping,
    );
    expect(r.candidates[0].linkedinUrl).toBe("https://www.linkedin.com/in/jane-d/");
  });
});

describe("raw preservation in imports", () => {
  const headers = ["Email", "Notes", "Region", "Company Size", "Website"];
  const rawMapping: Mapping = { Email: "email", Notes: "skip", Website: "company_domain" };
  const options = { headers };

  it("keeps skipped and unlisted columns, sending Company-prefixed ones to the company", () => {
    const r = buildCandidates([{ Email: "a@b.co", Notes: "vip", Region: "EMEA", "Company Size": "50", Website: "acme.com" }], rawMapping, options);
    expect(r.candidates[0].raw).toEqual({ Notes: "vip", Region: "EMEA" });
    expect(r.candidates[0].companyRaw).toEqual({ "Company Size": "50" });
  });

  it("keeps nothing when headers are not supplied", () => {
    const r = buildCandidates([{ Email: "a@b.co", Region: "EMEA" }], rawMapping);
    expect(r.candidates[0].raw).toEqual({});
  });

  it("counts rows that hit the size cap", () => {
    const r = buildCandidates([{ Email: "a@b.co", Region: "x".repeat(5000) }], rawMapping, options);
    expect(r.rawTruncatedRows).toBe(1);
    expect(r.candidates[0].raw.Region).toHaveLength(2000);
  });

  it("merges raw of duplicate rows, later values winning", () => {
    const r = buildCandidates([{ Email: "a@b.co", Region: "EMEA", Notes: "a" }, { Email: "a@b.co", Region: "APAC" }], rawMapping, options);
    expect(r.candidates[0].raw).toEqual({ Notes: "a", Region: "APAC" });
  });

  it("plans the merged raw for an update and nothing when raw is unchanged", () => {
    const [c] = buildCandidates([{ Email: "jane@acme.com", Region: "EMEA" }], rawMapping, options).candidates;
    const changed = planImport([c], [existing({ raw: { Other: "1" } })]);
    expect(changed.updates[0].patch.raw).toEqual({ Other: "1", Region: "EMEA" });
    const same = planImport([c], [existing({ raw: { Region: "EMEA" } })]);
    expect(same.unchanged).toBe(1);
  });

  it("carries raw on inserts and company raw per domain", () => {
    const cs = buildCandidates([{ Email: "a@b.co", Region: "EMEA", "Company Size": "50", Website: "acme.com" }], rawMapping, options).candidates;
    const plan = planImport(cs, []);
    expect(plan.inserts[0].raw).toEqual({ Region: "EMEA" });
    expect(plan.companyRaw.get("acme.com")).toEqual({ "Company Size": "50" });
  });

  it("keeps Company columns on the person when the row has no company domain", () => {
    const r = buildCandidates([{ Email: "a@b.co", "Company Size": "50" }], rawMapping, options);
    expect(r.candidates[0].raw).toEqual({ "Company Size": "50" });
    expect(r.candidates[0].companyRaw).toEqual({});
  });
});

describe("planImport with other domains (aliases)", () => {
  const build = (rows: Array<Record<string, string>>, map: Mapping = mapping, headers?: string[]) => buildCandidates(rows, map, headers ? { headers } : {}).candidates;
  const aliases = new Map([["globex.com", "acme.com"]]);

  it("lands a row with an alias domain on the kept company and merges duplicates by domain", () => {
    const plan = planImport(build([{ Email: "a@acme.com", Website: "acme.com" }, { Email: "g@globex.com", Website: "globex.com", Company: "Globex" }]), [], { aliases });
    expect([...plan.companies.keys()]).toEqual(["acme.com"]);
    expect(plan.companies.get("acme.com")).toBe("Globex");
    expect(plan.inserts.map((p) => p.companyDomain)).toEqual(["acme.com", "acme.com"]);
  });

  it("carries company columns and the company page to the kept domain", () => {
    const rawMapping: Mapping = { Email: "email", Website: "company_domain", "Company LinkedIn": "company_linkedin", "Company Size": "skip" };
    const headers = ["Email", "Website", "Company LinkedIn", "Company Size"];
    const plan = planImport(
      build([{ Email: "g@globex.com", Website: "globex.com", "Company LinkedIn": "linkedin.com/company/globex", "Company Size": "50" }], rawMapping, headers),
      [],
      { aliases },
    );
    expect(plan.companyRaw.get("acme.com")).toEqual({ "Company Size": "50" });
    expect(plan.companyLinkedin.get("acme.com")).toBe("https://www.linkedin.com/company/globex/");
    expect(plan.companyRaw.has("globex.com")).toBe(false);
  });

  it("does not move a person who already sits at the kept company", () => {
    const plan = planImport(build([{ Email: "jane@acme.com", Website: "globex.com" }]), [existing({ companyId: "c1", companyDomain: "acme.com" })], { aliases });
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it("leaves domains without an alias as they are", () => {
    const plan = planImport(build([{ Email: "n@initech.com", Website: "initech.com" }]), [], { aliases });
    expect([...plan.companies.keys()]).toEqual(["initech.com"]);
  });
});
