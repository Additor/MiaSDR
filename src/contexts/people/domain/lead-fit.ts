/**
 * A lead's fit: how a person matches the organization's ICP, as Mia last judged it. A person reads it and decides; no
 * automation reads it. "Mia" in docs/decisions.md.
 */

export const FIT_VERDICTS = ["fit", "partial", "not_fit", "unknown"] as const;
export type FitVerdict = (typeof FIT_VERDICTS)[number];

export const FIT_VERDICT_LABELS: Record<FitVerdict, string> = { fit: "Fit", partial: "Partial", not_fit: "Not a fit", unknown: "Unknown" };

/** The list filter's values: a verdict, or no check yet. */
export const FIT_FILTERS = [...FIT_VERDICTS, "none"] as const;
export type FitFilter = (typeof FIT_FILTERS)[number];

export const FIT_FILTER_LABELS: Record<FitFilter, string> = { ...FIT_VERDICT_LABELS, none: "Not checked" };

export const isFitFilter = (value: unknown): value is FitFilter => (FIT_FILTERS as readonly unknown[]).includes(value);

export const FIT_SOURCES = ["profile", "company", "their_reply", "our_message"] as const;
export type FitSource = (typeof FIT_SOURCES)[number];

export const FIT_SOURCE_LABELS: Record<FitSource, string> = { profile: "From the profile", company: "From the company", their_reply: "From their reply", our_message: "From our message" };

export interface FitCriterion {
  criterion: string;
  type: "required" | "disqualifier";
  result: "met" | "not_met" | "unknown";
  source: FitSource | null;
  /** A passage of that source. Null when the source holds none. */
  evidence: string | null;
  /** The model named evidence that its source does not hold, so the result fell to unknown. */
  unsupported?: boolean;
}

/** What a judgment read, so a later look can tell that something changed since. */
export interface FitInputs {
  profileHash: string;
  latestInboundMessageId: string | null;
  /** The ICP and qualification items it read, by id, with their revision. */
  brainRevisions: Record<string, number>;
}

export interface LeadFitProfile {
  fullName: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  custom: Record<string, unknown>;
  companyCustom: Record<string, unknown>;
}

const line = (label: string, value: unknown) => (value === null || value === undefined || value === "" ? [] : [`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`]);

const customLines = (custom: Record<string, unknown>) =>
  Object.keys(custom)
    .sort()
    .flatMap((key) => line(key, custom[key]));

/** The profile as a judgment reads it. Email, phone and the unmapped import columns stay out. */
export function fitProfileText(profile: LeadFitProfile): string {
  return [...line("Name", profile.fullName), ...line("Title", profile.title), ...customLines(profile.custom)].join("\n");
}

export function fitCompanyText(profile: LeadFitProfile): string {
  return [...line("Company", profile.companyName), ...line("Domain", profile.companyDomain), ...customLines(profile.companyCustom)].join("\n");
}

/** Whether what a judgment read has changed since. */
export function fitChanged(stored: FitInputs, now: FitInputs): boolean {
  if (stored.profileHash !== now.profileHash || stored.latestInboundMessageId !== now.latestInboundMessageId) return true;
  const before = Object.entries(stored.brainRevisions);
  const after = Object.entries(now.brainRevisions);
  return before.length !== after.length || before.some(([id, revision]) => now.brainRevisions[id] !== revision);
}
