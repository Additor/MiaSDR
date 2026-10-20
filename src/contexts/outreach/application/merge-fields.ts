import { mergeFieldKey } from "@/contexts/leads/domain/custom-fields";
import type { Actor } from "@/shared/errors";

export interface MergeFieldSource {
  /** Person custom fields of the organization. */
  customColumns(organizationId: string): Promise<Array<{ key: string; name: string }>>;
  /** Distinct import column names kept as source data on recent leads and their companies. */
  sourceKeys(organizationId: string): Promise<string[]>;
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
