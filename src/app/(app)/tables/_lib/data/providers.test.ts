import { describe, expect, it } from "vitest";
import { catalogGroups, guessColumn, impactText, usageLine } from "./providers";

describe("provider usage line", () => {
  it("names calls, the found rate, errors, reuses, credits and the typical latency", () => {
    expect(usageLine({ days: 30, provider: "hunter", calls: 120, hits: 101, errors: 3, reused: 12, credits: 60.5, p50LatencyMs: 420 })).toBe("Last 30 days: 120 calls, 84% found, 3 errors, 12 reused, 60.5 credits, 420 ms typical");
  });

  it("leaves out what is zero or unknown", () => {
    expect(usageLine({ days: 30, provider: "fake", calls: 0, hits: 0, errors: 0, reused: 2, credits: 0, p50LatencyMs: null })).toBe("Last 30 days: 0 calls, 2 reused");
    expect(usageLine({ days: 7, provider: "apollo", calls: 1, hits: 1, errors: 1, reused: 0, credits: 1, p50LatencyMs: 90 })).toBe("Last 7 days: 1 call, 100% found, 1 error, 1 credit, 90 ms typical");
  });
});

describe("turn off and disconnect confirmation", () => {
  const impact = { columns: [{ tableId: "t", tableName: "Leads", columnName: "Verify", waterfall: false }], pendingCells: 3 };
  it("says what happens to the columns and the waiting cells", () => {
    expect(impactText("off", impact)).toBe("1 column uses it. 3 cells are waiting to run. Their cells wait until you turn it back on, without using an attempt; a waterfall asks its other steps meanwhile.");
    expect(impactText("disconnect", impact)).toBe("The saved key is deleted. 1 column uses it. 3 cells are waiting to run. Their cells fail until you connect it again; a waterfall asks its other steps.");
    expect(impactText("off", { columns: [], pendingCells: 0 })).toBe("No column uses it. You can turn it back on at any time.");
    expect(impactText("disconnect", null)).toMatch(/^MiaSDR could not check which columns use it\./);
  });
});

describe("catalog groups", () => {
  const entry = (key: string, action: string | null, adapter: string | null = key, status: "available" | "catalog_only" = "available") => ({ key, name: key, description: "", status, adapter, credentialFields: [], actions: action ? [{ key: action, name: action, inputs: [], outputs: [], primaryOutput: "", defaultCostCents: 0 }] : [] });
  it("puts verifiers, finders and enrichers first, and Custom HTTP and the fake provider last", () => {
    const groups = catalogGroups([entry("http", null, "http"), entry("fake", "find-email", "fake"), entry("hunter", "verify-email"), entry("prospeo", "find-work-email"), entry("apollo", "enrich-person"), entry("zerobounce", "verify-email")]);
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.key)])).toEqual([
      ["Verify email", ["hunter", "zerobounce"]],
      ["Find work email", ["prospeo"]],
      ["Enrich people and companies", ["apollo"]],
      ["Other", ["http", "fake"]],
    ]);
  });
});

describe("input column guess", () => {
  const col = (key: string, name: string, type = "text") => ({ key, name, type });
  const fullName = { key: "fullName", name: "Full name", type: "text" };

  it("maps the columns people name name, company and domain", () => {
    const cols = [col("name", "name"), col("company", "company"), col("domain", "domain")];
    expect(guessColumn(fullName, cols)).toBe("name");
    expect(guessColumn({ key: "companyName", name: "Company name", type: "text" }, cols)).toBe("company");
    expect(guessColumn({ key: "companyDomain", name: "Company domain", type: "domain" }, cols)).toBe("domain");
  });

  it("does not take an email column renamed from the starter key as the full name", () => {
    expect(guessColumn(fullName, [col("name", "Email", "email")])).toBeNull();
  });
});
