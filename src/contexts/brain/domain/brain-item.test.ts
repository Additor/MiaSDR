import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors";
import { BRAIN_FIELDS, brainFieldRows, parseBrainFields, renderBrainContent } from "./brain-fields";
import { createBrainItem, isLegacyBrainItem, reviseBrainItem, type BrainItemState } from "./brain-item";
import { BRAIN_GROUPS, BRAIN_ITEM_KINDS, BRAIN_KINDS } from "./brain-kinds";

const product = (over: Partial<BrainItemState> = {}): BrainItemState => ({ kind: "product", title: "Mia", structuredData: { productName: "Mia", overview: "An AI SDR" }, ...over });
const legacy = (over: Partial<BrainItemState> = {}): BrainItemState => ({ kind: "unsorted", title: "Old FAQ", structuredData: null, ...over });

describe("the kinds", () => {
  it("defines fields and a group for every kind a person can create", () => {
    for (const kind of BRAIN_ITEM_KINDS) expect(BRAIN_FIELDS[kind].fields.length).toBeGreaterThan(0);
    expect(Object.values(BRAIN_GROUPS).flat().sort()).toEqual([...BRAIN_ITEM_KINDS].sort());
  });
  it("keeps product first, since the route matrix seeds the first literal and a company profile is single", () => {
    expect(BRAIN_KINDS[0]).toBe("product");
  });
});

describe("parseBrainFields", () => {
  it("trims, drops empty values and keeps the list's order", () => {
    expect(JSON.stringify(parseBrainFields("product", { overview: " An AI SDR ", useCases: "  ", productName: " Mia " }))).toBe(JSON.stringify({ productName: "Mia", overview: "An AI SDR" }));
  });
  it("refuses an unknown field, also a nested one", () => {
    expect(() => parseBrainFields("product", { productName: "Mia", pricing: "1" })).toThrow(/Unknown field: pricing/);
    expect(() => parseBrainFields("price_book", { entryName: "Pro", pricing: { model: "seat" } })).toThrow(/Unknown field: pricing.model/);
  });
  it("names a missing required field", () => {
    expect(() => parseBrainFields("case_study", { customerName: "Acme", challenge: "a", solution: "b" })).toThrow("Results is required.");
    expect(() => parseBrainFields("product", {})).toThrow(ValidationError);
  });
  it("enforces the limits Brain in Withmia has", () => {
    expect(() => parseBrainFields("company_profile", { companyName: "x".repeat(101) })).toThrow(/at most 100/);
    expect(() => parseBrainFields("product", { productName: "Mia", overview: "x".repeat(5001) })).toThrow(/at most 5,000/);
    expect(parseBrainFields("product", { productName: "Mia", overview: "x".repeat(5000) })).toBeTruthy();
  });
  it("accepts only an http or https website with a real host", () => {
    expect(() => parseBrainFields("company_profile", { companyName: "A", website: "ftp://a.io" })).toThrow(/http or https/);
    expect(() => parseBrainFields("company_profile", { companyName: "A", website: "http://?x" })).toThrow(/http or https/);
    expect(parseBrainFields("company_profile", { companyName: "A", website: "https://a.io" })).toMatchObject({ website: "https://a.io" });
  });
  it("accepts only the objection categories", () => {
    const base = { objection: "Too dear", responseStrategy: "Show the return" };
    expect(() => parseBrainFields("objection_handling", { ...base, category: "weather" })).toThrow(/choices/);
    expect(parseBrainFields("objection_handling", { ...base, category: "price" })).toMatchObject({ category: "price" });
  });
  it("needs a currency once a plan has a price, and stores it nested as Brain does", () => {
    expect(() => parseBrainFields("price_book", { entryName: "Pro", monthlyPrice: 99 })).toThrow(/Currency is required/);
    expect(parseBrainFields("price_book", { entryName: "Pro", monthlyPrice: 99, pricing: { currency: "usd" } })).toEqual({ entryName: "Pro", monthlyPrice: 99, pricing: { currency: "USD" } });
    expect(parseBrainFields("price_book", { entryName: "Pro" })).toEqual({ entryName: "Pro" });
  });
  it("refuses a negative or non-numeric price and accepts zero", () => {
    expect(() => parseBrainFields("price_book", { entryName: "P", monthlyPrice: -1, pricing: { currency: "USD" } })).toThrow(/0 or more/);
    expect(() => parseBrainFields("price_book", { entryName: "P", monthlyPrice: "9", pricing: { currency: "USD" } })).toThrow(/0 or more/);
    expect(parseBrainFields("price_book", { entryName: "P", monthlyPrice: 0, pricing: { currency: "USD" } })).toMatchObject({ monthlyPrice: 0 });
  });
  it("cleans a list and limits it", () => {
    expect(parseBrainFields("icp", { icpName: "SaaS", decisionMakerTitles: [" CEO ", "", "CTO"] })).toMatchObject({ decisionMakerTitles: ["CEO", "CTO"] });
    expect(parseBrainFields("icp", { icpName: "SaaS", decisionMakerTitles: [" "] })).toEqual({ icpName: "SaaS" });
    expect(() => parseBrainFields("icp", { icpName: "SaaS", decisionMakerTitles: "CEO" })).toThrow(/must be a list/);
    expect(() => parseBrainFields("icp", { icpName: "SaaS", decisionMakerTitles: Array.from({ length: 51 }, (_, i) => `t${i}`) })).toThrow(/at most 50/);
  });
  it("needs a qualification to say who to contact or who to leave out", () => {
    expect(() => parseBrainFields("qualification", { framework: "BANT" })).toThrow(/who to contact/);
    expect(parseBrainFields("qualification", { disqualificationSignals: "Under 10 people" })).toBeTruthy();
  });
});

describe("renderBrainContent", () => {
  it("writes one line per field with a value, a price with its currency", () => {
    const data = { entryName: "Pro", pricing: { currency: "USD" }, monthlyPrice: 99, features: ["SSO", "Audit log"] };
    expect(renderBrainContent("price_book", data)).toBe("Plan name: Pro\nMonthly price: USD 99\nFeatures: SSO, Audit log");
  });
  it("keeps a currency on a plan without a price", () => {
    expect(brainFieldRows("price_book", { entryName: "Pro", pricing: { currency: "USD" } }).map((r) => r.label)).toEqual(["Plan name", "Currency"]);
  });
  it("shows a category by its label", () => {
    expect(renderBrainContent("objection_handling", { category: "status_quo", objection: "No", responseStrategy: "Ask" })).toContain("Topic: Status quo");
  });
});

describe("createBrainItem", () => {
  it("takes the title from the name field and builds the text", () => {
    expect(createBrainItem({ kind: "product", fields: { productName: "Mia", overview: "An AI SDR" } })).toEqual({
      kind: "product",
      title: "Mia",
      description: null,
      tags: [],
      alwaysInclude: false,
      structuredData: { productName: "Mia", overview: "An AI SDR" },
      content: "Product name: Mia\nOverview: An AI SDR",
    });
  });
  it("refuses a written title on a kind with a name field, and needs one on a kind without", () => {
    expect(() => createBrainItem({ kind: "product", fields: { productName: "Mia" }, title: "Other" })).toThrow(/name field/);
    const objection = { objection: "Too dear", responseStrategy: "Show the return" };
    expect(() => createBrainItem({ kind: "objection_handling", fields: objection })).toThrow(/title/);
    expect(createBrainItem({ kind: "objection_handling", fields: objection, title: " Price " }).title).toBe("Price");
  });
  it("refuses a kind no one can create", () => {
    expect(() => createBrainItem({ kind: "unsorted" as never, fields: {} })).toThrow(/Unknown item kind/);
  });
  it("cleans the tags and limits the description", () => {
    expect(createBrainItem({ kind: "product", fields: { productName: "M" }, tags: [" A ", "a"], description: "  " })).toMatchObject({ tags: ["a"], description: null });
    expect(() => createBrainItem({ kind: "product", fields: { productName: "M" }, description: "x".repeat(1001) })).toThrow(/1000/);
  });
  it("stores the flag for any kind: which kinds reach a prompt is the prompt's rule", () => {
    expect(createBrainItem({ kind: "icp", fields: { icpName: "SaaS" }, alwaysInclude: true }).alwaysInclude).toBe(true);
  });
});

describe("reviseBrainItem", () => {
  it("replaces all the fields and adds a version when they change", () => {
    const change = reviseBrainItem(product(), { fields: { productName: "Mia 2" } });
    expect(change).toEqual({ title: "Mia 2", version: { structuredData: { productName: "Mia 2" }, content: "Product name: Mia 2" } });
  });
  it("adds no version when the fields only come back in another key order", () => {
    expect(reviseBrainItem(product(), { fields: { overview: "An AI SDR", productName: "Mia" } }).version).toBeUndefined();
    const stored = product({ kind: "price_book", title: "Pro", structuredData: { monthlyPrice: 1, pricing: { currency: "USD" }, entryName: "Pro" } });
    expect(reviseBrainItem(stored, { fields: { entryName: "Pro", pricing: { currency: "USD" }, monthlyPrice: 1 } }).version).toBeUndefined();
  });
  it("changes only what the patch names", () => {
    expect(reviseBrainItem(product(), { active: false })).toEqual({ active: false });
    expect(reviseBrainItem(product(), { tags: ["A"], alwaysInclude: true, description: "d" })).toEqual({ tags: ["a"], alwaysInclude: true, description: "d" });
  });
  it("refuses a title on a kind with a name field, alone or with fields", () => {
    expect(() => reviseBrainItem(product(), { title: "Other" })).toThrow(/name field/);
    expect(() => reviseBrainItem(product(), { title: "Other", fields: { productName: "Mia" } })).toThrow(/name field/);
  });
  it("lets a person rename a kind without a name field", () => {
    const state = product({ kind: "qualification", title: "Rules", structuredData: { disqualificationSignals: "x" } });
    expect(reviseBrainItem(state, { title: "New" })).toEqual({ title: "New" });
    expect(reviseBrainItem(state, { title: "New", fields: { disqualificationSignals: "x" } })).toEqual({ title: "New" });
  });
  it("refuses a new kind on an item that has fields", () => {
    expect(() => reviseBrainItem(product(), { kind: "icp", fields: { icpName: "x" } })).toThrow(/keeps its kind/);
  });
  it("sorts a legacy document into a kind, with a new version even when nothing else differs", () => {
    expect(isLegacyBrainItem(legacy())).toBe(true);
    const change = reviseBrainItem(legacy(), { kind: "product", fields: { productName: "Mia" } });
    expect(change).toMatchObject({ kind: "product", title: "Mia", version: { structuredData: { productName: "Mia" } } });
    expect(reviseBrainItem(legacy({ kind: "product", title: "Mia" }), { fields: { productName: "Mia" } }).version).toBeTruthy();
  });
  it("keeps a legacy title when the new kind has no name field and none was written", () => {
    expect(reviseBrainItem(legacy(), { kind: "qualification", fields: { disqualificationSignals: "x" } })).toMatchObject({ kind: "qualification", title: "Old FAQ" });
  });
  it("refuses sorting into unsorted, fields on an unsorted document without a kind, and a kind without fields", () => {
    expect(() => reviseBrainItem(legacy(), { kind: "unsorted", fields: {} })).toThrow(/Choose a kind/);
    expect(() => reviseBrainItem(legacy(), { fields: { productName: "Mia" } })).toThrow(/Choose a kind/);
    expect(() => reviseBrainItem(legacy(), { kind: "product" })).toThrow(/Fill in the fields/);
  });
  it("lets a person archive, tag and rename an unsorted document without sorting it", () => {
    expect(reviseBrainItem(legacy(), { active: false, tags: ["x"], title: "FAQ" })).toEqual({ active: false, tags: ["x"], title: "FAQ" });
  });
});
