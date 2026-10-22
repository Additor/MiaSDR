import { MAX_CUSTOM_VALUE_LENGTH, MAX_FIELD_LENGTH } from "./lead-edit";
import { blankToNull, normalizeCompanyLinkedinUrl } from "./normalize";

/**
 * What the company form sends. `undefined` leaves a field alone, an empty string clears it. The domain is the
 * company's identity and has no edit: a person moves to another company through their own form.
 */
export interface CompanyEditInput {
  name?: string | null;
  /** A company page URL such as linkedin.com/company/acme. */
  linkedin?: string | null;
  /** Values of the organization's company fields by key. An empty value removes the key from this company. */
  custom?: Record<string, string>;
}

export interface CompanyEditPlan {
  /** Columns to write on `companies`. Only keys the edit touched are present. */
  patch: Partial<{ name: string | null; linkedinUrl: string | null }>;
  customSet: Record<string, string>;
  customRemove: string[];
  issues: string[];
}

/** Checks a company edit against the import rules for names and LinkedIn company pages. */
export function planCompanyEdit(input: CompanyEditInput): CompanyEditPlan {
  const plan: CompanyEditPlan = { patch: {}, customSet: {}, customRemove: [], issues: [] };

  if (input.name !== undefined) {
    const name = blankToNull(input.name);
    if (name && name.length > MAX_FIELD_LENGTH) plan.issues.push(`Company name is longer than ${MAX_FIELD_LENGTH} characters.`);
    else plan.patch.name = name;
  }
  if (input.linkedin !== undefined) {
    const raw = blankToNull(input.linkedin);
    const url = normalizeCompanyLinkedinUrl(raw);
    if (raw && !url) plan.issues.push("LinkedIn must be a company page URL such as linkedin.com/company/name.");
    else plan.patch.linkedinUrl = url;
  }
  for (const [key, value] of Object.entries(input.custom ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      plan.issues.push(`"${key}" is not a custom field key.`);
      continue;
    }
    const text = blankToNull(value);
    if (text === null) plan.customRemove.push(key);
    else if (text.length > MAX_CUSTOM_VALUE_LENGTH) plan.issues.push(`The value for ${key} is longer than ${MAX_CUSTOM_VALUE_LENGTH} characters.`);
    else plan.customSet[key] = text;
  }
  return plan;
}
