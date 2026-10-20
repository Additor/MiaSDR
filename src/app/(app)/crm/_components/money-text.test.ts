import { describe, expect, it } from "vitest";
import { moneyTotalsText } from "./money-text";

describe("moneyTotalsText", () => {
  it("prints one total per currency in code order and keeps every digit past 2^53 - 1", () => {
    expect(moneyTotalsText([])).toBeNull();
    expect(moneyTotalsText([{ currency: "USD", amountMinor: "30000" }, { currency: "EUR", amountMinor: "120000" }])).toBe("€1,200.00 · $300.00");
    expect(moneyTotalsText([{ currency: "KRW", amountMinor: "1500" }])).toBe("₩1,500");
    expect(moneyTotalsText([{ currency: "USD", amountMinor: "18014398509481981" }])).toBe("$180,143,985,094,819.81");
  });
});
