import { mergeFieldKey } from "@/contexts/people/domain/custom-fields";
import { mergeTokens } from "./render";

export interface PersonForVariables {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  companyName: string | null;
  companyDomain: string | null;
  /** The person's profile URL as stored. */
  linkedinUrl?: string | null;
  /** The company page URL as stored. */
  companyLinkedinUrl?: string | null;
  /** People's custom values by column key. */
  custom: Record<string, unknown> | null;
  /** Unmapped import columns of the person. `company` holds a name that had no domain. */
  raw?: Record<string, unknown> | null;
  /** Unmapped import columns of the company. */
  companyRaw?: Record<string, unknown> | null;
  /** Per-enrollment overrides, applied last. */
  mergeFields?: Record<string, string> | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * The merge fields available to a template, lowest precedence first:
 * source-data keys (company, then person), the standard fields and their aliases,
 * each custom column under its camelCase name and its label (so `{{jobTitle}}`
 * and `{{Job Title}}` both work), then per-enrollment overrides.
 * Preview and send both call this, so what you preview is what goes out.
 * Custom columns without a value for this person stay in the result as null, so a
 * preview can tell an empty field from a typo.
 */
export function buildVariables(person: PersonForVariables, labelByKey: Map<string, string>): Record<string, string | null> {
  const variables: Record<string, string | null> = {};
  const addRaw = (raw: Record<string, unknown> | null | undefined) => {
    for (const [key, value] of Object.entries(raw ?? {})) {
      const v = text(value);
      if (v === null) continue;
      variables[key] = v;
      const camel = mergeFieldKey(key);
      if (camel && !(camel in variables)) variables[camel] = v;
    }
  };
  addRaw(person.companyRaw);
  addRaw(person.raw);

  const joined = [person.firstName, person.lastName].filter(Boolean).join(" ") || null;
  const fullName = person.fullName ?? joined;
  const rawCompany = text(person.raw?.company);
  const companyName = person.companyName ?? rawCompany;
  const linkedinUrl = person.linkedinUrl ?? null;
  Object.assign(variables, {
    firstName: person.firstName,
    lastName: person.lastName,
    fullName,
    name: fullName,
    company: companyName ?? person.companyDomain,
    companyName,
    companyDomain: person.companyDomain,
    companyLinkedinUrl: person.companyLinkedinUrl ?? text(person.raw?.company_linkedin_url),
    email: person.email,
    title: person.title,
    jobTitle: person.title,
    phone: person.phone,
    linkedinUrl,
    linkedin: linkedinUrl,
  });

  const standard = new Set(Object.keys(variables).map((k) => k.toLowerCase()));
  const values = person.custom ?? {};
  for (const [key, label] of labelByKey) {
    const value = text(values[key]);
    const camel = mergeFieldKey(label);
    if (camel && !standard.has(camel.toLowerCase())) variables[camel] = value;
    // A label that collides with a standard field only overrides it with a real value.
    if (value !== null || !standard.has(label.toLowerCase())) variables[label] = value;
  }
  // A value under a key with no column definition stays reachable under the key.
  for (const [key, value] of Object.entries(values)) {
    if (!labelByKey.has(key) && typeof value === "string") variables[key] = value;
  }
  return Object.assign(variables, person.mergeFields ?? {});
}

/** The lead a preview shows when the organization has none. */
export const SAMPLE_PERSON: PersonForVariables = {
  firstName: "Alex",
  lastName: "Kim",
  fullName: "Alex Kim",
  title: "Head of Sales",
  phone: "+1 415 555 0100",
  email: "alex@acme.com",
  companyName: "Acme",
  companyDomain: "acme.com",
  linkedinUrl: "https://www.linkedin.com/in/alex-kim/",
  companyLinkedinUrl: "https://www.linkedin.com/company/acme/",
  custom: null,
};

export const sampleVariables = (): Record<string, string | null> => buildVariables(SAMPLE_PERSON, new Map());

export interface UnresolvedToken {
  token: string;
  /** `empty`: a known field with no value for this lead. `unknown`: no such field, usually a typo. */
  reason: "empty" | "unknown";
}

/** Tokens in the templates that this lead cannot fill. Spin groups count every option. */
export function unresolvedTokens(templates: string[], variables: Record<string, string | null>): UnresolvedToken[] {
  const lookup = new Map(Object.entries(variables).map(([k, v]) => [k.toLowerCase(), v]));
  const out = new Map<string, UnresolvedToken>();
  for (const template of templates) {
    for (const token of mergeTokens(template)) {
      const key = token.toLowerCase();
      if (out.has(key)) continue;
      if (!lookup.has(key)) out.set(key, { token, reason: "unknown" });
      else if ((lookup.get(key) ?? "") === "") out.set(key, { token, reason: "empty" });
    }
  }
  return [...out.values()];
}
