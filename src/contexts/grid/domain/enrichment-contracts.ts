import type { ActionInput, ActionOutput, ActionSpec } from "./enrichment-catalog";

/**
 * Shared action contracts. A vendor that offers one of these keys takes these inputs and returns at least these
 * outputs, with the same meaning, so steps of different vendors can share a waterfall. A vendor may add outputs of
 * its own; it never renames or drops a contract output, because column configs map outputs by key.
 */
export type ContractKey = "verify-email" | "find-work-email" | "enrich-person" | "enrich-company";

interface Contract {
  name: string;
  inputs: ActionInput[];
  outputs: ActionOutput[];
  primaryOutput: string;
  /** Input combinations every vendor of the contract can match on; see ActionSpec.accepts. */
  accepts?: string[][];
}

/** A verdict every verification vendor maps onto. The vendor's own word stays in `providerStatus`. */
export type VerificationStatus = "valid" | "invalid" | "catch_all" | "unknown" | "disposable";

/**
 * Verdicts that settle an address, so a verification waterfall stops on them. catch_all and unknown move on to the
 * next vendor; when none settles it, the cell keeps the first of them (see the waterfall's miss verdict).
 */
export const SETTLED_STATUSES: readonly VerificationStatus[] = ["valid", "invalid", "disposable"];

export const isSettled = (status: VerificationStatus): boolean => SETTLED_STATUSES.includes(status);

/** Maps a vendor's word through its table. Case and surrounding space do not matter; an unknown word is "unknown". */
export function verificationStatus(raw: unknown, table: Readonly<Record<string, VerificationStatus>>): VerificationStatus {
  if (typeof raw !== "string") return "unknown";
  return table[raw.trim().toLowerCase()] ?? "unknown";
}

/** A 0 to 100 score as an integer, or null. `scale` is the vendor's top value (1 for 0 to 1, 10 for 1 to 10). */
export function percentScore(raw: unknown, scale = 100): number | null {
  const n = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round((n / scale) * 100)));
}

const email: ActionInput = { key: "email", name: "Email", type: "email", required: true };
const fullName: ActionInput = { key: "fullName", name: "Full name", type: "text", required: true };
const companyDomain: ActionInput = { key: "companyDomain", name: "Company domain", type: "domain", required: true };
const companyName: ActionInput = { key: "companyName", name: "Company name", type: "text", required: false };
const optional = (input: ActionInput): ActionInput => ({ ...input, required: false });

export const CONTRACTS: Readonly<Record<ContractKey, Contract>> = {
  "verify-email": {
    name: "Verify email",
    inputs: [email],
    outputs: [
      { key: "email", name: "Email", type: "email" },
      { key: "status", name: "Status", type: "text" },
      { key: "providerStatus", name: "Provider status", type: "text" },
      { key: "score", name: "Score", type: "number" },
    ],
    primaryOutput: "status",
  },
  // Every finder takes a company name when a row has no domain; the domain matches better and wins when both are there.
  "find-work-email": {
    name: "Find work email",
    inputs: [fullName, optional(companyDomain), companyName],
    accepts: [["companyDomain"], ["companyName"]],
    outputs: [
      { key: "email", name: "Work email", type: "email" },
      { key: "confidence", name: "Confidence", type: "number" },
      { key: "verificationStatus", name: "Verification status", type: "text" },
    ],
    primaryOutput: "email",
  },
  // Inputs are optional because vendors match on any of several identities.
  "enrich-person": {
    name: "Enrich person",
    inputs: [optional(email), optional(fullName), optional(companyDomain), companyName, { key: "linkedinUrl", name: "LinkedIn URL", type: "url", required: false }],
    accepts: [["email"], ["linkedinUrl"], ["fullName", "companyDomain"], ["fullName", "companyName"]],
    outputs: [
      { key: "email", name: "Work email", type: "email" },
      { key: "title", name: "Title", type: "text" },
      { key: "company", name: "Company", type: "text" },
      { key: "linkedinUrl", name: "LinkedIn URL", type: "url" },
    ],
    primaryOutput: "email",
  },
  "enrich-company": {
    name: "Enrich company",
    inputs: [companyDomain],
    outputs: [
      { key: "name", name: "Company name", type: "text" },
      { key: "industry", name: "Industry", type: "text" },
      { key: "employeeCount", name: "Employees", type: "number" },
      { key: "websiteUrl", name: "Website", type: "url" },
      { key: "linkedinUrl", name: "LinkedIn URL", type: "url" },
      { key: "city", name: "City", type: "text" },
      { key: "country", name: "Country", type: "text" },
    ],
    primaryOutput: "name",
  },
};

/** The action a vendor offers for a contract: the contract's inputs and outputs, then the vendor's own outputs. */
export function contractAction(key: ContractKey, options: { extraOutputs?: ActionOutput[]; defaultCostCents?: number } = {}): ActionSpec {
  const contract = CONTRACTS[key];
  return {
    key,
    name: contract.name,
    inputs: contract.inputs,
    outputs: [...contract.outputs, ...(options.extraOutputs ?? [])],
    primaryOutput: contract.primaryOutput,
    defaultCostCents: options.defaultCostCents ?? 0,
    ...(contract.accepts ? { accepts: contract.accepts } : {}),
  };
}
