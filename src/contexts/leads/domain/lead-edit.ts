import { blankToNull, customColumnKey, normalizeDomain, normalizeEmail, normalizePhone } from "./normalize";
import { checkCompanyDomain } from "./company-domain";
import { parseLinkedinRef } from "./linkedin-url";
import { nameFold } from "./custom-columns";

export const MAX_FIELD_LENGTH = 255;
export const MAX_CUSTOM_VALUE_LENGTH = 2000;
export const MAX_CUSTOM_FIELDS = 100;

/** What the edit form sends. `undefined` leaves a field alone, an empty string clears it. */
export interface LeadEditInput {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  /** A profile URL or a bare slug. */
  linkedin?: string | null;
  title?: string | null;
  companyDomain?: string | null;
  /**
   * Names a company that does not exist yet. The repository answers 422 "Rename {Company} on its company page." when the domain
   * belongs to a company with another name ("Contacts and Companies CRUD" in docs/decisions.md).
   */
  companyName?: string | null;
  /** Values of existing custom fields by key. An empty value removes the key from this lead. */
  custom?: Record<string, string>;
  /** Fields the organization has no column for yet; the label becomes the key. */
  newCustom?: Array<{ label: string; value: string }>;
  defaultCountry?: string;
}

export interface LeadCurrent {
  email: string | null;
  linkedinSlug: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  companyDomain: string | null;
}

export interface LeadEditPlan {
  /** Columns to write on `people`. Only keys the edit touched are present. */
  patch: Partial<{
    email: string | null;
    linkedinSlug: string | null;
    linkedinUrl: string | null;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    title: string | null;
    phone: string | null;
  }>;
  /** undefined: leave the company alone. null: detach. Otherwise attach, creating the company when missing. */
  company: { domain: string; name: string | null } | null | undefined;
  customSet: Record<string, string>;
  customRemove: string[];
  /**
   * Labels of fields the organization may have no column for yet, with their values (null when blank).
   * Labels that fold to the same name appear once. The registry decides the stored key of each label.
   */
  newColumns: Array<{ name: string; value: string | null }>;
  issues: string[];
}

const tooLong = (label: string, value: string | null | undefined, max = MAX_FIELD_LENGTH): string | null =>
  value && value.length > max ? `${label} is longer than ${max} characters.` : null;

export interface LeadEditOptions {
  /** `create`: Add contact plans a new contact from an empty person, and the messages say "contact". */
  mode?: "edit" | "create";
}

/** The current state Add contact plans against. */
export const NEW_PERSON: LeadCurrent = { email: null, linkedinSlug: null, firstName: null, lastName: null, fullName: null, companyDomain: null };

/** Applies the import rules (email, LinkedIn, phone, domain) to an explicit edit. */
export function planLeadEdit(current: LeadCurrent, input: LeadEditInput, options: LeadEditOptions = {}): LeadEditPlan {
  const noun = options.mode === "create" ? "contact" : "lead";
  const plan: LeadEditPlan = { patch: {}, company: undefined, customSet: {}, customRemove: [], newColumns: [], issues: [] };
  const issue = (message: string | null) => {
    if (message) plan.issues.push(message);
  };

  issue(tooLong("First name", input.firstName));
  issue(tooLong("Last name", input.lastName));
  issue(tooLong("Full name", input.fullName));
  issue(tooLong("Job title", input.title));
  issue(tooLong("Email", input.email));
  issue(tooLong("Phone", input.phone));
  issue(tooLong("LinkedIn", input.linkedin, 500));
  issue(tooLong("Company domain", input.companyDomain));
  issue(tooLong("Company name", input.companyName));

  if (input.email !== undefined) {
    const raw = blankToNull(input.email);
    const email = normalizeEmail(raw);
    if (raw && !email) issue(`"${raw}" is not a valid email address.`);
    else plan.patch.email = email;
  }
  if (input.linkedin !== undefined) {
    const raw = blankToNull(input.linkedin);
    const ref = parseLinkedinRef(raw);
    if (raw && !ref) issue("LinkedIn must be a linkedin.com URL such as linkedin.com/in/name.");
    else {
      plan.patch.linkedinSlug = ref?.slug ?? null;
      plan.patch.linkedinUrl = ref?.url ?? null;
    }
  }
  if (input.phone !== undefined) {
    const raw = blankToNull(input.phone);
    const phone = normalizePhone(raw, input.defaultCountry);
    if (raw && !phone) issue(`"${raw}" is not a valid phone number. Include the country code, for example +82 10 1234 5678.`);
    else plan.patch.phone = phone;
  }
  if (input.title !== undefined) plan.patch.title = blankToNull(input.title);

  const firstName = input.firstName !== undefined ? blankToNull(input.firstName) : current.firstName;
  const lastName = input.lastName !== undefined ? blankToNull(input.lastName) : current.lastName;
  if (input.firstName !== undefined) plan.patch.firstName = firstName;
  if (input.lastName !== undefined) plan.patch.lastName = lastName;
  if (input.fullName !== undefined || input.firstName !== undefined || input.lastName !== undefined) {
    const explicit = input.fullName !== undefined ? blankToNull(input.fullName) : null;
    // A blank full name falls back to the parts, so clearing it never leaves a named lead nameless.
    const derived = [firstName, lastName].filter(Boolean).join(" ") || null;
    const next = explicit ?? derived;
    if (input.fullName !== undefined || next !== current.fullName) plan.patch.fullName = next;
  }

  const email = "email" in plan.patch ? plan.patch.email : current.email;
  const slug = "linkedinSlug" in plan.patch ? plan.patch.linkedinSlug : current.linkedinSlug;
  if (!email && !slug) issue(`A ${noun} needs an email or a LinkedIn profile.`);

  if (input.companyDomain !== undefined) {
    const raw = blankToNull(input.companyDomain);
    if (raw === null) plan.company = null;
    else if (current.companyDomain !== null && normalizeDomain(raw) === current.companyDomain) {
      // The domain the person already has. A webmail domain stored by an earlier import stays, so a save of other fields never fails on it.
      plan.company = { domain: current.companyDomain, name: blankToNull(input.companyName) };
    } else {
      const checked = checkCompanyDomain(raw);
      if (checked.issue !== null) issue(checked.issue);
      else plan.company = { domain: checked.domain, name: blankToNull(input.companyName) };
    }
  } else if (blankToNull(input.companyName) && !current.companyDomain) {
    issue("Add the company domain to name a new company.");
  }

  for (const [key, value] of Object.entries(input.custom ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      issue(`"${key}" is not a custom field key.`);
      continue;
    }
    const text = blankToNull(value);
    if (text === null) plan.customRemove.push(key);
    else if (text.length > MAX_CUSTOM_VALUE_LENGTH) issue(`The value for ${key} is longer than ${MAX_CUSTOM_VALUE_LENGTH} characters.`);
    else plan.customSet[key] = text;
  }
  for (const entry of input.newCustom ?? []) {
    const label = entry.label.trim();
    const text = blankToNull(entry.value);
    if (label === "" && text === null) continue;
    if (!customColumnKey(label)) {
      issue("Give each new field a name with at least one letter or digit.");
      continue;
    }
    if (label.length > 60) issue(`The field name "${label.slice(0, 20)}..." is longer than 60 characters.`);
    if (text !== null && text.length > MAX_CUSTOM_VALUE_LENGTH) {
      issue(`The value for ${label} is longer than ${MAX_CUSTOM_VALUE_LENGTH} characters.`);
      continue;
    }
    // Two labels that fold to one name are one column; they may repeat a value but not disagree.
    const same = plan.newColumns.find((c) => nameFold(c.name) === nameFold(label));
    if (!same) plan.newColumns.push({ name: label, value: text });
    else if (same.value === null) same.value = text;
    else if (text !== null && text !== same.value) issue(`"${label}" is listed twice with different values.`);
  }
  const withValue = plan.newColumns.filter((c) => c.value !== null).length;
  if (Object.keys(plan.customSet).length + withValue > MAX_CUSTOM_FIELDS) issue(`A ${noun} can have at most ${MAX_CUSTOM_FIELDS} custom fields.`);

  return plan;
}
