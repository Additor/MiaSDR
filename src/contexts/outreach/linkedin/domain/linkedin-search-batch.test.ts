import { describe, expect, it } from "vitest";
import { MAX_BATCH_ROWS, batchTemplateCsv, canManageBatch, parseAddedUrls, parseBatchRows, searchUrlKey } from "./linkedin-search-batch";

const GOOD = "https://www.linkedin.com/search/results/people/?keywords=cto&geoUrn=1";
const row = (url: string, company = "") => ({ search_url: url, company_name: company });
const HEADERS = ["company_name", "search_url"];

describe("parseBatchRows", () => {
  it("accepts people searches and keeps the company name", () => {
    const out = parseBatchRows(HEADERS, [row(GOOD, "Acme"), row("https://www.linkedin.com/sales/search/people?query=x", "")]);
    expect(out).toMatchObject({ ok: true, rejected: [], duplicatesInFile: 0 });
    if (!out.ok) return;
    expect(out.accepted.map((r) => [r.row, r.variant, r.companyName])).toEqual([
      [2, "classic", "Acme"],
      [3, "sales_navigator", null],
    ]);
  });

  it("reports bad rows with their row number and reason, and keeps the good ones", () => {
    const out = parseBatchRows(HEADERS, [row(GOOD), row(""), row("https://example.com/search/results/people/"), row("https://www.linkedin.com/in/someone"), row("not a url at all")]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.accepted).toHaveLength(1);
    expect(out.rejected.map((r) => r.row)).toEqual([3, 4, 5, 6]);
    expect(out.rejected[0].reason).toBe("The search URL is empty.");
    expect(out.rejected[1].reason).toMatch(/linkedin\.com/);
    expect(out.rejected[2].reason).toMatch(/people search/);
  });

  it("refuses a lookalike host", () => {
    const out = parseBatchRows(HEADERS, [row("https://linkedin.com.evil.test/search/results/people/?keywords=a"), row("https://evil.test/?u=linkedin.com/search/results/people/")]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toHaveLength(2);
  });

  it("drops a repeat even when parameters change order or tracking is added", () => {
    const out = parseBatchRows(HEADERS, [row(GOOD, "First"), row("https://www.linkedin.com/search/results/people/?geoUrn=1&keywords=cto&origin=GLOBAL_SEARCH_HEADER", "Second")]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.accepted.map((r) => r.companyName)).toEqual(["First"]);
    expect(out.duplicatesInFile).toBe(1);
  });

  it("finds the URL column under its usual names and fails without one", () => {
    expect(parseBatchRows(["Company", "Search URL"], [{ Company: "A", "Search URL": GOOD }])).toMatchObject({ ok: true });
    expect(parseBatchRows(["LinkedIn URL"], [{ "LinkedIn URL": GOOD }])).toMatchObject({ ok: true });
    expect(parseBatchRows(["name", "email"], [{ name: "a", email: "b" }])).toMatchObject({ ok: false });
  });

  it("caps the row count and refuses an empty file", () => {
    const many = Array.from({ length: MAX_BATCH_ROWS + 1 }, (_, i) => row(`${GOOD}&n=${i}`));
    expect(parseBatchRows(HEADERS, many)).toMatchObject({ ok: false });
    expect(parseBatchRows(HEADERS, many.slice(0, MAX_BATCH_ROWS))).toMatchObject({ ok: true });
    expect(parseBatchRows(HEADERS, [])).toMatchObject({ ok: false });
  });

  it("strips control characters and caps the company name", () => {
    const out = parseBatchRows(HEADERS, [row(GOOD, `Ac\u0000me\nCorp${"x".repeat(300)}`)]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.accepted[0].companyName).toMatch(/^Ac me Corpx+$/);
    expect(out.accepted[0].companyName!.length).toBe(200);
  });

  it("keeps a formula-looking company name as text (export quotes it)", () => {
    const out = parseBatchRows(HEADERS, [row(GOOD, "=HYPERLINK(\"x\")")]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.accepted[0].companyName).toBe('=HYPERLINK("x")');
  });
});

describe("searchUrlKey", () => {
  it("ignores parameter order and case of the host", () => {
    expect(searchUrlKey("https://www.linkedin.com/search/results/people/?b=2&a=1")).toBe(searchUrlKey("https://WWW.linkedin.com/search/results/people/?a=1&b=2"));
  });
});

describe("batchTemplateCsv", () => {
  it("passes its own rules", () => {
    const [header, sample] = batchTemplateCsv().trim().split("\r\n");
    expect(header).toBe("company_name,search_url");
    const url = sample.split(",").slice(1).join(",");
    expect(parseBatchRows(["company_name", "search_url"], [{ company_name: "Acme Corp", search_url: url }])).toMatchObject({ ok: true });
  });
});

describe("parseAddedUrls", () => {
  it("numbers a pasted list from 1 and reports the lines it refused", () => {
    const out = parseAddedUrls([GOOD, "", "https://www.linkedin.com/in/someone", GOOD]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.accepted.map((r) => r.row)).toEqual([1]);
    expect(out.rejected.map((r) => r.row)).toEqual([2, 3]);
    expect(out.duplicatesInFile).toBe(1);
  });
});

describe("canManageBatch", () => {
  it("allows an owner or admin, or the creator", () => {
    expect(canManageBatch({ isOwnerOrAdmin: true, actorUserId: "a", createdBy: "b" })).toBe(true);
    expect(canManageBatch({ isOwnerOrAdmin: false, actorUserId: "a", createdBy: "a" })).toBe(true);
  });
  it("refuses another member, and anyone when the creator is gone", () => {
    expect(canManageBatch({ isOwnerOrAdmin: false, actorUserId: "a", createdBy: "b" })).toBe(false);
    expect(canManageBatch({ isOwnerOrAdmin: false, actorUserId: "a", createdBy: null })).toBe(false);
  });
});
