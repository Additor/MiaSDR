import { ValidationError } from "@/shared/errors";

/**
 * Deal amounts. A deal stores its amount in minor units of its currency (`deals.amount_minor`, a bigint at most 2^53 - 1),
 * so 12.50 USD is 1250 and 1500 KRW is 1500. The exponent of each currency comes from ISO 4217. The board never sums
 * amounts of different currencies.
 */

/** ISO 4217 codes with their minor-unit exponent. A practical list, not every code: add one here when a customer needs it. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  KRW: 0,
  JPY: 0,
  CNY: 2,
  INR: 2,
  AUD: 2,
  CAD: 2,
  NZD: 2,
  CHF: 2,
  SGD: 2,
  HKD: 2,
  TWD: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  ISK: 0,
  PLN: 2,
  CZK: 2,
  HUF: 2,
  RON: 2,
  TRY: 2,
  ILS: 2,
  AED: 2,
  SAR: 2,
  QAR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  ZAR: 2,
  EGP: 2,
  NGN: 2,
  KES: 2,
  BRL: 2,
  MXN: 2,
  ARS: 2,
  CLP: 0,
  COP: 2,
  PEN: 2,
  THB: 2,
  MYR: 2,
  IDR: 2,
  PHP: 2,
  VND: 0,
};

export const CURRENCIES: readonly string[] = Object.keys(CURRENCY_EXPONENTS).sort();

export const DEFAULT_CURRENCY = "USD";

/** The largest amount a deal holds, in minor units (`deals_amount_ck`). */
export const MAX_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

/** The exponent of an ISO 4217 code, or null for a code outside the list. The code is case-sensitive: `USD`, not `usd`. */
export function currencyExponent(code: string): number | null {
  return Object.hasOwn(CURRENCY_EXPONENTS, code) ? CURRENCY_EXPONENTS[code] : null;
}

export function parseCurrency(code: unknown): string {
  const value = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (currencyExponent(value) === null) throw new ValidationError("Pick a currency from the list.");
  return value;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * An amount as a person types it ("1,250.5", "1500", 99.99) to minor units of `currency`. Thousands separators are commas.
 * A negative amount, more decimals than the currency has, or a value above the stored maximum is a 422.
 */
export function parseAmountToMinor(amount: string | number, currency: string): number {
  const exponent = currencyExponent(currency);
  if (exponent === null) throw new ValidationError("Pick a currency from the list.");
  const text = typeof amount === "number" ? numberText(amount) : amount.trim().replace(/,/g, "");
  if (text.startsWith("-")) throw new ValidationError("An amount cannot be negative.");
  const match = DECIMAL.exec(text);
  if (!match) throw new ValidationError("Enter the amount as a number, such as 1250 or 1250.50.");
  const [, whole, fraction = ""] = match;
  const trimmed = fraction.replace(/0+$/, "");
  if (trimmed.length > exponent) {
    throw new ValidationError(exponent === 0 ? `${currency} has no decimal places.` : `${currency} has at most ${exponent} decimal places.`);
  }
  const minor = BigInt(whole + trimmed.padEnd(exponent, "0"));
  if (minor > BigInt(MAX_AMOUNT_MINOR)) throw new ValidationError("That amount is too large.");
  return Number(minor);
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) return "invalid";
  // Plain notation: 1e21 and 1e-7 would print in exponent form.
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

/**
 * Minor units back to a decimal string with the currency's places: 1250 USD is "12.50", 1500 KRW is "1500". A bigint keeps a
 * column total above 2^53 - 1 exact.
 */
export function formatMinor(amountMinor: number | bigint, currency: string): string {
  const exponent = currencyExponent(currency) ?? 2;
  if (exponent === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
