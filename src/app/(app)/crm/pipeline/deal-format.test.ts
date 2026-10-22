import { describe, expect, it } from "vitest";
import { daysInStage, formatAmount, formatTotals, isOverdue, ownerText, shiftTotals } from "./deal-format";

describe("deal display text", () => {
  it("groups the amount and keeps the currency's decimal places", () => {
    expect(formatAmount(1_250_050, "USD")).toBe("USD 12,500.50");
    expect(formatAmount(1500, "KRW")).toBe("KRW 1,500");
    expect(formatAmount(5, "USD")).toBe("USD 0.05");
    expect(formatAmount(-123_456, "EUR")).toBe("EUR -1,234.56");
  });

  it("lists totals per currency and never adds currencies together", () => {
    expect(formatTotals([])).toBeNull();
    expect(formatTotals([{ currency: "USD", amountMinor: "100000" }, { currency: "EUR", amountMinor: "5000" }])).toBe("EUR 50.00, USD 1,000.00");
  });

  it("prints a total above 2^53 - 1 to the last digit", () => {
    // Number("18014398509481983") rounds to 18014398509481984.
    expect(formatTotals([{ currency: "USD", amountMinor: "18014398509481983" }])).toBe("USD 180,143,985,094,819.83");
    expect(formatTotals([{ currency: "KRW", amountMinor: "18014398509481983" }])).toBe("KRW 18,014,398,509,481,983");
    expect(formatAmount(BigInt("-18014398509481983"), "EUR")).toBe("EUR -180,143,985,094,819.83");
  });

  it("counts whole days in the stage", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(daysInStage("2026-10-16T01:00:00Z", now)).toBe("Today");
    expect(daysInStage("2026-10-15T11:00:00Z", now)).toBe("1 day");
    expect(daysInStage(new Date("2026-10-01T12:00:00Z"), now)).toBe("15 days");
    expect(daysInStage("2026-10-17T00:00:00Z", now)).toBe("Today");
  });

  it("names a former member and a missing owner", () => {
    expect(ownerText(null)).toBe("No owner");
    expect(ownerText({ name: null, isMember: false })).toBe("Former member");
    expect(ownerText({ name: "Ada", isMember: true })).toBe("Ada");
  });

  it("marks only an open deal past its close date as overdue", () => {
    expect(isOverdue("2026-10-15", "2026-10-16", "open")).toBe(true);
    expect(isOverdue("2026-10-16", "2026-10-16", "open")).toBe(false);
    expect(isOverdue("2026-10-01", "2026-10-16", "won")).toBe(false);
    expect(isOverdue(null, "2026-10-16", "open")).toBe(false);
  });
});

describe("totals while a move waits for the server", () => {
  it("takes a leaving card out and adds an arriving one, per currency", () => {
    const amounts = [{ currency: "USD", amountMinor: "5000000" }];
    expect(shiftTotals(amounts, [{ amountMinor: 1000000, currency: "USD" }], [{ amountMinor: 300, currency: "EUR" }])).toEqual([
      { currency: "USD", amountMinor: "4000000" },
      { currency: "EUR", amountMinor: "300" },
    ]);
  });

  it("drops a currency that reaches zero and skips cards without an amount", () => {
    expect(shiftTotals([{ currency: "USD", amountMinor: "500" }], [{ amountMinor: 500, currency: "USD" }, { amountMinor: null, currency: null }], [])).toEqual([]);
  });

  it("keeps totals past 2^53 exact", () => {
    expect(shiftTotals([{ currency: "KRW", amountMinor: "9007199254740993" }], [], [{ amountMinor: "2", currency: "KRW" }])).toEqual([{ currency: "KRW", amountMinor: "9007199254740995" }]);
  });
});
