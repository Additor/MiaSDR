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
  /**
   * The new column's name: it shows the action's main answer, so it is named for that answer, in words no input column
   * of the action uses ("Company name" would read as the imported column next to it).
   */
  column: string;
  /** The action's other outputs that `fills` names, ticked as columns of their own when the dialog opens. */
  outputs: readonly string[];
}

export const OUTCOMES: readonly Outcome[] = [
  { actionKey: "find-work-email", label: "Find work emails", fills: "From a name and a company", column: "Work email", outputs: [] },
  { actionKey: "verify-email", label: "Verify emails", fills: "Valid, invalid or catch-all", column: "Email status", outputs: [] },
  { actionKey: "enrich-person", label: "Enrich people", fills: "Work email, title and LinkedIn", column: "Person's work email", outputs: ["title", "linkedinUrl"] },
  { actionKey: "enrich-company", label: "Enrich companies", fills: "Industry, size and location", column: "Matched company", outputs: ["industry", "employeeCount", "city", "country"] },
];

export const outcomeOf = (actionKey: string | undefined): Outcome | undefined => OUTCOMES.find((o) => o.actionKey === actionKey);
