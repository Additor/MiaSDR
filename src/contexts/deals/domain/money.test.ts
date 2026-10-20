import { describe, expect, it } from "vitest";
import { CURRENCIES, CURRENCY_EXPONENTS, currencyExponent, formatMinor, MAX_AMOUNT_MINOR, parseAmountToMinor, parseCurrency } from "./money";

describe("currency list", () => {
  it("holds the practical ISO 4217 set with their minor-unit exponents", () => {
    for (const code of ["USD", "EUR", "GBP", "CNY", "INR", "AUD", "CAD", "CHF", "SGD", "HKD", "SEK", "NOK", "DKK", "BRL", "MXN"]) expect(currencyExponent(code), code).toBe(2);
    for (const code of ["KRW", "JPY"]) expect(currencyExponent(code), code).toBe(0);
    for (const code of ["KWD", "BHD"]) expect(currencyExponent(code), code).toBe(3);
    expect(CURRENCIES).toEqual(Object.keys(CURRENCY_EXPONENTS).sort());
    expect(CURRENCIES.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
  });

  it("refuses an unknown code and does not read the object prototype", () => {
    expect(currencyExponent("XYZ")).toBeNull();
    expect(currencyExponent("usd")).toBeNull();
    expect(currencyExponent("toString")).toBeNull();
    expect(() => parseCurrency("XYZ")).toThrow("Pick a currency");
    expect(parseCurrency(" usd ")).toBe("USD");
    expect(() => parseCurrency(12)).toThrow();
  });
});

describe("parseAmountToMinor", () => {
  it("converts by the currency's exponent", () => {
    expect(parseAmountToMinor("1250.5", "USD")).toBe(125050);
    expect(parseAmountToMinor("1,250.50", "USD")).toBe(125050);
    expect(parseAmountToMinor("1500", "KRW")).toBe(1500);
    expect(parseAmountToMinor("1.234", "KWD")).toBe(1234);
    expect(parseAmountToMinor(99.99, "EUR")).toBe(9999);
    expect(parseAmountToMinor(0, "USD")).toBe(0);
    expect(parseAmountToMinor("12.500", "USD")).toBe(1250);
    expect(parseAmountToMinor("1500.00", "JPY")).toBe(1500);
  });

  it("refuses negative amounts, too many decimals, junk and values above the stored maximum", () => {
    expect(() => parseAmountToMinor("-1", "USD")).toThrow("negative");
    expect(() => parseAmountToMinor(-5, "USD")).toThrow("negative");
    expect(() => parseAmountToMinor("1.5", "KRW")).toThrow("no decimal places");
    expect(() => parseAmountToMinor("1.001", "USD")).toThrow("at most 2");
    expect(() => parseAmountToMinor("1e3", "USD")).toThrow("as a number");
    expect(() => parseAmountToMinor("", "USD")).toThrow("as a number");
    expect(() => parseAmountToMinor(Number.NaN, "USD")).toThrow("as a number");
    expect(() => parseAmountToMinor("1", "XYZ")).toThrow("currency");
    expect(parseAmountToMinor(String(MAX_AMOUNT_MINOR), "KRW")).toBe(MAX_AMOUNT_MINOR);
    expect(() => parseAmountToMinor(String(MAX_AMOUNT_MINOR + 1), "KRW")).toThrow("too large");
    expect(() => parseAmountToMinor("90071992547409.92", "USD")).toThrow("too large");
  });

  it("formats minor units back", () => {
    expect(formatMinor(125050, "USD")).toBe("1250.50");
    expect(formatMinor(5, "USD")).toBe("0.05");
    expect(formatMinor(1500, "KRW")).toBe("1500");
    expect(formatMinor(1234, "KWD")).toBe("1.234");
  });
});
