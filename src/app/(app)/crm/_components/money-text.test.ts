import { describe, expect, it } from "vitest";
import { moneyText, moneyTotalsText } from "./money-text";

describe("moneyText", () => {
  it("groups the amount and keeps the currency's decimal places", () => {
    expect(moneyText(1_250_050, "USD")).toBe("$12,500.50");
    expect(moneyText(1500, "KRW")).toBe("₩1,500");
    expect(moneyText(5, "USD")).toBe("$0.05");
    expect(moneyText(-123_456, "EUR")).toBe("-€1,234.56");
    expect(moneyText("18014398509481983", "USD")).toBe("$180,143,985,094,819.83");
    expect(moneyText(null, "USD")).toBeNull();
    expect(moneyText(100, null)).toBeNull();
  });
});

describe("moneyTotalsText", () => {
  it("prints one total per currency in code order and keeps every digit past 2^53 - 1", () => {
    expect(moneyTotalsText([])).toBeNull();
    expect(moneyTotalsText([{ currency: "USD", amountMinor: "30000" }, { currency: "EUR", amountMinor: "120000" }])).toBe("€1,200.00 · $300.00");
    expect(moneyTotalsText([{ currency: "KRW", amountMinor: "1500" }])).toBe("₩1,500");
    expect(moneyTotalsText([{ currency: "USD", amountMinor: "18014398509481981" }])).toBe("$180,143,985,094,819.81");
  });
});
