/**
 * Cents one call to an action costs when the vendor does not report a price: the provider's own price or the action's,
 * whichever is higher. The worker charges it, the estimate caps on it, and the enrichment dialog shows it.
 */
export const lookupCents = (providerCents: number, action: { defaultCostCents: number } | undefined): number => Math.max(providerCents, action?.defaultCostCents ?? 0);
