import { mergeFieldKey } from "@/contexts/people/domain/custom-fields";
import type { DbHandle } from "@/platform/db/client";
import { ValidationError, type Actor } from "@/shared/errors";
import { standardFieldNames, unknownFields, unresolvedTokens, type UnknownField, type UnresolvedToken } from "../domain/variables";

export interface MergeFieldSource {
  /** Person custom fields of the organization. */
  customColumns(organizationId: string): Promise<Array<{ key: string; name: string }>>;
  /** Distinct import column names kept as source data on recent leads and companies. */
  sourceKeys(organizationId: string): Promise<string[]>;
  /**
   * Every name a lead of the organization holds a field under: custom columns, archived ones too since a send still
   * fills them, custom values, source data of any
   * person or company, enrollment overrides. Unlike `sourceKeys` it samples nothing, so a name missing here is missing.
   */
  fieldNames(organizationId: string, tx?: DbHandle): Promise<string[]>;
}

export interface MergeFieldItem {
  /** The text to put between the braces. */
  token: string;
  label: string;
  group: "standard" | "custom" | "source";
}

const STANDARD: MergeFieldItem[] = [
  { token: "firstName", label: "First name", group: "standard" },
  { token: "lastName", label: "Last name", group: "standard" },
  { token: "fullName", label: "Full name", group: "standard" },
  { token: "company", label: "Company", group: "standard" },
  { token: "companyDomain", label: "Company domain", group: "standard" },
  { token: "companyLinkedinUrl", label: "Company LinkedIn page", group: "standard" },
  { token: "title", label: "Job title", group: "standard" },
  { token: "email", label: "Email", group: "standard" },
  { token: "phone", label: "Phone", group: "standard" },
  { token: "linkedinUrl", label: "LinkedIn profile", group: "standard" },
];

/** Hidden from the picker: aliases of the fields above, and internal keys. */
const INTERNAL_SOURCE_KEYS = new Set(["company", "company_linkedin_url"]);

/** The fields a template can use, for the step editors' insert picker. */
export async function listMergeFields(deps: { source: MergeFieldSource }, actor: Actor): Promise<MergeFieldItem[]> {
  const [columns, sourceKeys] = await Promise.all([deps.source.customColumns(actor.organizationId), deps.source.sourceKeys(actor.organizationId)]);
  const taken = new Set(["name", "jobtitle", "companyname", "linkedin", ...STANDARD.map((f) => f.token.toLowerCase())]);
  const items = [...STANDARD];
  for (const column of columns) {
    const camel = mergeFieldKey(column.name);
    const token = camel && !taken.has(camel.toLowerCase()) ? camel : column.name;
    if (taken.has(token.toLowerCase()) || token.includes("}")) continue;
    taken.add(token.toLowerCase());
    items.push({ token, label: column.name, group: "custom" });
  }
  for (const key of sourceKeys) {
    const name = key.trim();
    if (!name || name.includes("}") || INTERNAL_SOURCE_KEYS.has(name.toLowerCase()) || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    items.push({ token: name, label: name, group: "source" });
  }
  return items;
}

type StepFields = Parameters<typeof unknownFields>[0];

/** The tokens in these steps that no lead of the organization can fill. Reads the organization's fields only for a token the standard ones miss. */
export async function findUnknownFields(source: MergeFieldSource, organizationId: string, steps: StepFields, tx?: DbHandle): Promise<UnknownField[]> {
  const standard = standardFieldNames();
  if (unknownFields(steps, standard).length === 0) return [];
  return unknownFields(steps, [...standard, ...(await source.fieldNames(organizationId, tx))]);
}

/** A start problem for tokens that would reach every lead as a blank. */
export const unknownFieldsProblem = (unknown: UnknownField[]): ValidationError =>
  new ValidationError("Fix the merge fields before starting.", unknown.map((u) => ({ step: u.step, message: `No lead has a field called {{${u.token}}}. Check the spelling or pick a field the organization has.` })));

/** What a preview says about one lead: a field other leads have counts as empty here, and only a field none has as unknown. */
export async function unresolvedForLead(source: MergeFieldSource, organizationId: string, templates: string[], variables: Record<string, string | null>): Promise<UnresolvedToken[]> {
  const unresolved = unresolvedTokens(templates, variables);
  const missing = unresolved.filter((u) => u.reason === "unknown");
  if (missing.length === 0) return unresolved;
  const steps = [{ stepNumber: 0, body: missing.map((u) => `{{${u.token}}}`).join(" ") }];
  const unknown = new Set((await findUnknownFields(source, organizationId, steps)).map((u) => u.token));
  return unresolved.map((u) => (u.reason === "unknown" && !unknown.has(u.token) ? { ...u, reason: "empty" } : u));
}
