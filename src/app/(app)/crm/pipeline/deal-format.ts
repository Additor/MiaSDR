/** Display text of the Pipeline board and the deal page. Pure and locale-free, so the server and the browser print the same. */

/**
 * A column's per-currency totals with some cards taken out and others added, for a move the board shows before the
 * server counts it again. A currency that reaches zero with no card left in it drops out.
 */
export function shiftTotals(
  amounts: ReadonlyArray<{ currency: string; amountMinor: string }>,
  leaving: ReadonlyArray<{ amountMinor: string | number | null; currency: string | null }>,
  arriving: ReadonlyArray<{ amountMinor: string | number | null; currency: string | null }>,
): Array<{ currency: string; amountMinor: string }> {
  if (leaving.length === 0 && arriving.length === 0) return [...amounts];
  const sums = new Map(amounts.map((a) => [a.currency, BigInt(a.amountMinor)]));
  const add = (card: { amountMinor: string | number | null; currency: string | null }, sign: bigint) => {
    if (card.amountMinor === null || !card.currency) return;
    sums.set(card.currency, (sums.get(card.currency) ?? BigInt(0)) + sign * BigInt(card.amountMinor));
  };
  for (const card of leaving) add(card, BigInt(-1));
  for (const card of arriving) add(card, BigInt(1));
  return [...sums].filter(([, sum]) => sum !== BigInt(0)).map(([currency, sum]) => ({ currency, amountMinor: sum.toString() }));
}

const DAY_MS = 86_400_000;

/** "Today", "1 day", "12 days" in the stage, counted from the server's clock. */
export function daysInStage(stageChangedAt: string | Date, nowMs: number): string {
  const days = Math.max(0, Math.floor((nowMs - new Date(stageChangedAt).getTime()) / DAY_MS));
  if (days === 0) return "Today";
  return days === 1 ? "1 day" : `${days} days`;
}

/** The owner line: a member's name, "Former member" for someone who left, or "No owner". */
export function ownerText(owner: { name: string | null; isMember: boolean } | null): string {
  if (!owner) return "No owner";
  return owner.isMember && owner.name ? owner.name : "Former member";
}

/** True when an open deal's expected close date (YYYY-MM-DD) lies before today in the organization's zone. */
export function isOverdue(expectedCloseOn: string | null, today: string, stageKind: string): boolean {
  return stageKind === "open" && expectedCloseOn !== null && expectedCloseOn < today;
}
