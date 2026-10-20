import { DEAL_FALLBACK, dealReturnPath } from "./return-path";

/**
 * A link into a deal page that names where it came from, so the deal page's back link and its landing after a delete
 * return there. An origin outside the deal page's allowlist (`dealReturnPath`), such as a lead page, adds no `from`.
 */
export function dealHref(dealId: string, from?: string | null): string {
  const allowed = from ? dealReturnPath(from) !== DEAL_FALLBACK : false;
  return allowed && from ? `/crm/deals/${dealId}?from=${encodeURIComponent(from)}` : `/crm/deals/${dealId}`;
}
