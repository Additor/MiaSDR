import type { ContractKey } from "@/contexts/grid/enrichment/domain/enrichment-contracts";

/**
 * What a person wants a column to hold, in the order the work usually goes: find an address, check it, then fill in the
 * person or the company. Each outcome is one shared action, so every vendor that offers it can serve it, alone or in a
 * waterfall. The enrichment dialog and the start strip above a fresh table both offer these.
 */
export interface Outcome {
  actionKey: ContractKey;
  label: string;
  /** What the column fills, in a few words. */
  fills: string;
}

export const OUTCOMES: readonly Outcome[] = [
  { actionKey: "find-work-email", label: "Find work emails", fills: "From a name and a company" },
  { actionKey: "verify-email", label: "Verify emails", fills: "Valid, invalid or catch-all" },
  { actionKey: "enrich-person", label: "Enrich people", fills: "Title, company and LinkedIn" },
  { actionKey: "enrich-company", label: "Enrich companies", fills: "Industry, size and location" },
];

export const outcomeOf = (actionKey: string | undefined): Outcome | undefined => OUTCOMES.find((o) => o.actionKey === actionKey);
