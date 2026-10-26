import { currencyExponent, formatMinor } from "@/contexts/deals/domain/money";

type Minor = number | bigint | string;

/**
 * One amount in minor units: "$12,500.00", "₩1,500", "-€1,234.56". The amount reaches Intl as a decimal string, so a
 * total past 2^53 - 1 keeps every digit. A code Intl does not know still prints, as digits and the code.
 */
function amountText(amountMinor: Minor, currency: string): string {
  const value = BigInt(amountMinor);
  const negative = value < BigInt(0);
  const decimal = `${negative ? "-" : ""}${formatMinor(negative ? -value : value, currency)}`;
  const exponent = currencyExponent(currency) ?? 2;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(decimal as `${number}`);
  } catch {
    return `${decimal} ${currency}`;
  }
}

/** A deal amount for the screens, the same on every page. Null when the deal has no amount. */
export function moneyText(amountMinor: Minor | null, currency: string | null): string | null {
  if (amountMinor === null || currency === null) return null;
  return amountText(amountMinor, currency);
}

/** Per-currency totals for the screens: "€1,200.00 · $300.00", one entry per currency in code order. Null with no amounts. */
export function moneyTotalsText(amounts: ReadonlyArray<{ currency: string; amountMinor: string }>): string | null {
  if (amounts.length === 0) return null;
  return [...amounts]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map(({ currency, amountMinor }) => amountText(amountMinor, currency))
    .join(" · ");
}
