import { describe, expect, it } from "vitest";
import { buildCandidates, planImport, remapCustomKeys, suggestMapping, type ExistingPerson, type Mapping } from "./import-plan";
import { SAMPLE_CSV_HEADERS, SOURCE_DATA_HEADER, buildImportSummary, collectExamples, confirmLabel, sampleImportCsv, summaryChangesAnything } from "./import-summary";

const mapping: Mapping = {
  Email: "email",
  "First Name": "first_name",
  Title: "title",
  Phone: "phone",
  LinkedIn: "linkedin",
  Plan: "custom:Plan",
  Notes: "skip",
};
const headers = Object.keys(mapping);

const stored = (over: Partial<ExistingPerson>): ExistingPerson => ({
  id: "p1",
  email: "jane@acme.com",
  linkedinSlug: null,
  linkedinUrl: null,
  firstName: "Jane",
  lastName: null,
  fullName: "Jane",
  title: null,
  phone: null,
  companyId: null,
  companyDomain: null,
  custom: {},
  raw: null,
  ...over,
});

function summarize(rows: Array<Record<string, string>>, existing: ExistingPerson[], keyMap = new Map<string, string>()) {
  const built = buildCandidates(rows, mapping, { headers });
  const plan = planImport(remapCustomKeys(built.candidates, keyMap), existing);
  return buildImportSummary({ totalRows: rows.length, built, plan, existing, mapping, keyMap });
}

describe("buildImportSummary", () => {
  it("counts new, updated and unchanged leads and accounts for every row", () => {
    const s = summarize(
      [
        { Email: "new@acme.com" },
        { Email: "jane@acme.com", Title: "CTO" },
        { Email: "bob@acme.com", "First Name": "Bob" },
        { Email: "" },
        { Email: "nope" },
        { Email: "new@acme.com" },
      ],
      [stored({}), stored({ id: "p2", email: "bob@acme.com", firstName: "Bob", fullName: "Bob" })],
    );
    expect([s.created, s.updated, s.unchanged]).toEqual([1, 1, 1]);
    expect(s.skipped.map((g) => [g.kind, g.count])).toEqual([
      ["invalid_email", 1],
      ["missing_identifier", 1],
    ]);
    expect(s.duplicates.count).toBe(1);
    const skipped = s.skipped.reduce((n, g) => n + g.count, 0);
    expect(s.created + s.updated + s.unchanged + skipped + s.duplicates.count).toBe(s.totalRows);
  });

  it("shows the first three rows of a skip kind and counts the rest", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ Email: `bad${i}` }));
    const s = summarize([...rows, { Email: "ok@acme.com" }], []);
    const group = s.skipped.find((g) => g.kind === "invalid_email")!;
    expect(group.count).toBe(5);
    expect(group.examples.map((e) => e.row)).toEqual([1, 2, 3]);
  });

  it("reports a conflict as a skip kind", () => {
    const s = summarize(
      [{ Email: "a@acme.com", LinkedIn: "https://www.linkedin.com/in/bee" }],
      [stored({ id: "a", email: "a@acme.com" }), stored({ id: "b", email: "b@acme.com", linkedinSlug: "bee" })],
    );
    expect(s.skipped).toEqual([{ kind: "conflict", count: 1, examples: [expect.objectContaining({ row: 1 })] }]);
    expect(s.created + s.updated).toBe(0);
  });

  it("lists an unreadable value of an imported row and skips one of a skipped row", () => {
    const s = summarize(
      [
        { Email: "not-an-email", LinkedIn: "https://www.linkedin.com/in/jane-d" },
        { Email: "bad@", Phone: "123" },
        { Email: "ok@acme.com", Phone: "123" },
      ],
      [],
    );
    expect(s.created).toBe(2);
    expect(s.ignored.count).toBe(2);
    expect(s.ignored.examples.map((e) => e.row)).toEqual([1, 3]);
  });

  it("counts a replaced value per column and ignores a filled gap", () => {
    const s = summarize(
      [
        { Email: "jane@acme.com", Title: "CTO", Phone: "+14155550100", Plan: "Pro" },
        { Email: "bob@acme.com", Title: "VP" },
      ],
      [
        stored({ title: "Engineer", custom: { x_plan: "Free" } }),
        stored({ id: "p2", email: "bob@acme.com", title: null }),
      ],
    );
    expect(s.updated).toBe(2);
    // Jane's title and plan replace values. Her phone fills an empty field. Bob's title fills one too.
    expect(s.overwrites).toEqual([
      { header: "Plan", leads: 1 },
      { header: "Title", leads: 1 },
    ]);
  });

  it("follows a custom column to the key it is stored under", () => {
    const s = summarize([{ Email: "jane@acme.com", Plan: "Pro" }], [stored({ custom: { x_account_plan: "Free" } })], new Map([["x_plan", "x_account_plan"]]));
    expect(s.overwrites).toEqual([{ header: "Plan", leads: 1 }]);
  });

  it("counts a stored lead once per column when two rows of the file reach it", () => {
    const s = summarize(
      [
        { Email: "jane@acme.com", Title: "CTO" },
        { Email: "other@acme.com", LinkedIn: "https://www.linkedin.com/in/jane-d", Title: "VP" },
      ],
      [stored({ title: "Engineer", linkedinSlug: "jane-d" })],
    );
    expect(s.updated).toBe(2);
    expect(s.overwrites).toEqual([{ header: "Title", leads: 1 }]);
  });

  it("counts source data replaced under one heading", () => {
    const built = buildCandidates([{ Email: "jane@acme.com", Notes: "new note" }], mapping, { headers });
    const existing = [stored({ raw: { Notes: "old note" } })];
    const plan = planImport(built.candidates, existing);
    const s = buildImportSummary({ totalRows: 1, built, plan, existing, mapping, keyMap: new Map() });
    expect(s.overwrites).toEqual([{ header: SOURCE_DATA_HEADER, leads: 1 }]);
  });
});

describe("confirm label", () => {
  it("names the numbers on the button", () => {
    expect(confirmLabel({ created: 100, updated: 18 })).toBe("Import 118 leads: 100 new, 18 updated");
    expect(confirmLabel({ created: 1, updated: 0 })).toBe("Import 1 lead: 1 new");
    expect(confirmLabel({ created: 0, updated: 2 })).toBe("Import 2 leads: 2 updated");
    expect(confirmLabel({ created: 1200, updated: 0 })).toBe("Import 1,200 leads: 1,200 new");
  });

  it("is off when nothing would change", () => {
    expect(summaryChangesAnything({ created: 0, updated: 0 })).toBe(false);
    expect(confirmLabel({ created: 0, updated: 0 })).toBe("Nothing to import");
    expect(summaryChangesAnything({ created: 0, updated: 1 })).toBe(true);
  });
});

describe("collectExamples", () => {
  it("keeps up to three distinct non-empty values per column, in file order", () => {
    const rows = [{ A: "", B: "x" }, { A: "one", B: "x" }, { A: "one", B: "y" }, { A: " two ", B: "z" }, { A: "three", B: "w" }, { A: "four", B: "v" }];
    expect(collectExamples(["A", "B"], rows)).toEqual({ A: ["one", "two", "three"], B: ["x", "y", "z"] });
  });

  it("returns an empty list for a column with no values and cuts long values", () => {
    const out = collectExamples(["A", "B"], [{ A: "a".repeat(200), B: "" }], 3, 10);
    expect(out.B).toEqual([]);
    expect(out.A[0]).toHaveLength(10);
    expect(out.A[0].endsWith("…")).toBe(true);
  });
});

describe("sample CSV", () => {
  const [header, ...rows] = sampleImportCsv().trim().split("\r\n");

  it("uses headers the importer maps without help", () => {
    expect(header.split(",")).toEqual([...SAMPLE_CSV_HEADERS]);
    const guessed = suggestMapping([...SAMPLE_CSV_HEADERS]);
    expect(Object.values(guessed)).toEqual(["email", "first_name", "last_name", "title", "phone", "linkedin", "company_name", "company_domain"]);
  });

  it("holds two example rows that import as two new leads", () => {
    expect(rows).toHaveLength(2);
    const parsed = rows.map((line) => Object.fromEntries(line.split(",").map((v, i) => [SAMPLE_CSV_HEADERS[i], v])));
    const built = buildCandidates(parsed, suggestMapping([...SAMPLE_CSV_HEADERS]), { headers: [...SAMPLE_CSV_HEADERS], defaultCountry: "US" });
    expect(built.invalid).toEqual([]);
    expect(built.warnings).toEqual([]);
    expect(built.candidates).toHaveLength(2);
  });
});
