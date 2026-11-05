import { describe, expect, it } from "vitest";
import { checkConfirmed, INPUT_SOURCE, reviewSuggestion, suggestionRows } from "../suggestion";

const PAGE = "https://acme.test/pricing";
const sources = new Map([
  [PAGE, "The Starter plan costs $99 per month, or $1,000 per year.\nSee https://acme.test/terms for terms."],
  [INPUT_SOURCE, "Our customers call us the fastest way to book meetings."],
]);

const plan = [
  { key: "entryName", value: "Starter", quote: "The Starter plan costs $99 per month", source: PAGE },
  { key: "pricing.currency", value: "USD", quote: "The Starter plan costs $99 per month", source: PAGE },
  { key: "monthlyPrice", value: 99, quote: "The Starter plan costs $99 per month", source: PAGE },
];

describe("reviewSuggestion", () => {
  it("takes values whose sentence is in the source, and nests dotted keys", () => {
    const { fields, merged } = reviewSuggestion("price_book", plan, {}, sources);
    expect(merged).toEqual({ entryName: "Starter", pricing: { currency: "USD" }, monthlyPrice: 99 });
    expect(Object.values(fields).every((f) => !f.unverified && f.sourceUrl === PAGE)).toBe(true);
  });

  it("marks a number its sentence does not contain, even when the sentence is real", () => {
    const { fields } = reviewSuggestion("price_book", [plan[0], plan[1], { ...plan[2], value: 89 }], {}, sources);
    expect(fields.monthlyPrice.unverified).toBe(true);
    expect(fields.entryName.unverified).toBe(false);
  });

  it("reads 1,000 and 1000 as one number", () => {
    const { fields } = reviewSuggestion("price_book", [plan[0], plan[1], { key: "annualPrice", value: 1000, quote: "or $1,000 per year", source: PAGE }], {}, sources);
    expect(fields.annualPrice.unverified).toBe(false);
  });

  it("marks a currency the sentence does not show", () => {
    const { fields } = reviewSuggestion("price_book", [plan[0], { ...plan[1], value: "EUR" }, plan[2]], {}, sources);
    expect(fields["pricing.currency"].unverified).toBe(true);
  });

  it("marks an address its sentence does not contain, but accepts the site's own address", () => {
    const made = (value: string, quote: string) => reviewSuggestion("company_profile", [{ key: "companyName", value: "Acme", quote: "The Starter plan", source: PAGE }, { key: "website", value, quote, source: PAGE }], {}, sources);
    expect(made("https://evil.test/x", "The Starter plan").fields.website.unverified).toBe(true);
    expect(made("https://www.acme.test", "The Starter plan").fields.website.unverified).toBe(false);
  });

  it("refuses a sentence no source contains, and a source Mia did not read", () => {
    expect(() => reviewSuggestion("price_book", [{ ...plan[0], quote: "The Starter plan is free" }], {}, sources)).toThrow(/not in the source/);
    expect(() => reviewSuggestion("price_book", [{ ...plan[0], source: "https://acme.test/never-read" }], {}, sources)).toThrow(/not a source you read/);
    expect(() => reviewSuggestion("price_book", [{ ...plan[0], quote: " " }], {}, sources)).toThrow(/needs the sentence/);
  });

  it("matches a sentence across line breaks and case", () => {
    expect(reviewSuggestion("price_book", [{ ...plan[0], quote: "per year.  SEE https://acme.test/terms" }], {}, sources).fields.entryName.unverified).toBe(false);
  });

  it("applies the kind's own rules to the whole item", () => {
    expect(() => reviewSuggestion("price_book", [plan[0], plan[2]], {}, sources)).toThrow(/Currency is required/);
    expect(() => reviewSuggestion("product", [{ key: "overview", value: "Books meetings", quote: "the fastest way to book meetings", source: INPUT_SOURCE }], {}, sources)).toThrow(/Product name is required/);
  });

  it("keeps the fields an item already has when a suggestion names only some", () => {
    const { merged } = reviewSuggestion("product", [{ key: "overview", value: "Books meetings", quote: "the fastest way to book meetings", source: INPUT_SOURCE }], { productName: "Booker", useCases: "Sales" }, sources);
    expect(merged).toEqual({ productName: "Booker", overview: "Books meetings", useCases: "Sales" });
  });

  it("refuses a field the kind does not have", () => {
    expect(() => reviewSuggestion("product", [{ key: "secret", value: "x", quote: "the fastest", source: INPUT_SOURCE }], {}, sources)).toThrow(/Unknown field/);
  });

  it("asks no sentence for a choice between fixed options", () => {
    const made = reviewSuggestion(
      "objection_handling",
      [
        { key: "category", value: "price", quote: "", source: "" },
        { key: "objection", value: "Too slow", quote: "the fastest", source: INPUT_SOURCE },
        { key: "responseStrategy", value: "Speed", quote: "the fastest", source: INPUT_SOURCE },
      ],
      {},
      sources,
    );
    expect(made.fields.category).toEqual({ value: "price", quote: null, sourceUrl: null, unverified: false });
  });
});

describe("suggestionRows", () => {
  it("sets each suggested field beside what the item holds now, and leaves other fields out", () => {
    const { fields } = reviewSuggestion("price_book", [plan[0], plan[1], { ...plan[2], value: 89 }], {}, sources);
    const rows = suggestionRows("price_book", { fields, sorting: false }, { entryName: "Starter", pricing: { currency: "USD" }, monthlyPrice: 79, notes: "Old" });
    expect(rows.map((r) => r.key)).toEqual(["entryName", "pricing.currency", "monthlyPrice"]);
    expect(rows[2]).toMatchObject({ current: "USD 79", proposed: "89", unverified: true });
  });

  it("shows nothing as current on a new item", () => {
    const { fields } = reviewSuggestion("price_book", plan, {}, sources);
    expect(suggestionRows("price_book", { fields, sorting: false }, null).every((r) => r.current === "")).toBe(true);
  });
});

describe("checkConfirmed", () => {
  const { fields } = reviewSuggestion("price_book", [plan[0], plan[1], { ...plan[2], value: 89 }], {}, sources);
  const payload = { fields, sorting: false };
  const saving = { entryName: "Starter", pricing: { currency: "USD" }, monthlyPrice: 89 };

  it("refuses Mia's unchecked number", () => {
    expect(() => checkConfirmed("price_book", payload, saving, [])).toThrow(/Check Monthly price/);
  });

  it("takes it once a person ticked it", () => {
    expect(() => checkConfirmed("price_book", payload, saving, ["monthlyPrice"])).not.toThrow();
  });

  it("takes it once a person changed it, since the value is then theirs", () => {
    expect(() => checkConfirmed("price_book", payload, { ...saving, monthlyPrice: 99 }, [])).not.toThrow();
  });
});
