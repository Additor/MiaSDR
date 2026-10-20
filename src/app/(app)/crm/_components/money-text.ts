import { currencyExponent, formatMinor } from "@/contexts/deals/domain/money";

/** A deal amount for the screens: "$12,500.00", "₩1,500". Null when the deal has no amount. */
export function moneyText(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor === null || currency === null) return null;
  const exponent = currencyExponent(currency) ?? 2;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(Number(formatMinor(amountMinor, currency)));
  } catch {
    // A code Intl does not know still prints, as digits and the code.
    return `${formatMinor(amountMinor, currency)} ${currency}`;
  }
}

/**
 * Per-currency totals for the screens: "€1,200.00 · $300.00", one entry per currency in code order. A total arrives as a
 * decimal string that can pass 2^53 - 1, so it reaches Intl as a decimal string and keeps every digit. Null with no amounts.
 */
export function moneyTotalsText(amounts: ReadonlyArray<{ currency: string; amountMinor: string }>): string | null {
  if (amounts.length === 0) return null;
  return [...amounts]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map(({ currency, amountMinor }) => {
      const decimal = formatMinor(BigInt(amountMinor), currency);
      const exponent = currencyExponent(currency) ?? 2;
      try {
        const format = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent });
        return format.format(decimal as `${number}`);
      } catch {
        return `${decimal} ${currency}`;
      }
    })
    .join(" · ");
}
