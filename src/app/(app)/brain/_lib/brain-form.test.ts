import { describe, expect, it } from "vitest";
import { parseBrainFields } from "@/contexts/brain/domain/brain-fields";
import { fieldsOf, formValuesOf, requiredFilled } from "./brain-form";

describe("the Brain form values", () => {
  const stored = { entryName: "Pro", pricing: { currency: "USD" }, monthlyPrice: 99, features: ["SSO", "Audit log"] };

  it("holds a stored item as text, a list as one item per line", () => {
    expect(formValuesOf("price_book", stored)).toMatchObject({ entryName: "Pro", "pricing.currency": "USD", monthlyPrice: "99", features: "SSO\nAudit log", annualPrice: "" });
  });
  it("starts empty for a new item", () => {
    expect(formValuesOf("product", null).productName).toBe("");
  });
  it("comes back from the form to the same stored item", () => {
    expect(parseBrainFields("price_book", fieldsOf("price_book", formValuesOf("price_book", stored)))).toEqual(parseBrainFields("price_book", stored));
  });
  it("sends an emptied optional field as no value", () => {
    const values = { ...formValuesOf("price_book", stored), monthlyPrice: " ", features: "" };
    expect(parseBrainFields("price_book", fieldsOf("price_book", values))).toEqual({ entryName: "Pro", pricing: { currency: "USD" } });
  });
  it("sends text that is no number as it is, so the server names the field", () => {
    const values = { ...formValuesOf("price_book", stored), monthlyPrice: "cheap" };
    expect(() => parseBrainFields("price_book", fieldsOf("price_book", values))).toThrow(/Monthly price/);
  });
  it("is ready once the required fields hold something", () => {
    expect(requiredFilled("testimonial", { customerName: "Acme", quote: " " })).toBe(false);
    expect(requiredFilled("testimonial", { customerName: "Acme", quote: "Great" })).toBe(true);
    expect(requiredFilled("qualification", {})).toBe(true);
  });
});
