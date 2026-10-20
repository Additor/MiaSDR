/**
 * Turns grid rows into rows the lead import understands. The grid column the
 * person mapped to "Email" becomes the CSV header "email", and so on, so the
 * leads context validates, normalizes and de-duplicates them with the same
 * rules as a file import.
 */

export const CAMPAIGN_FIELDS = ["email", "linkedin", "firstName", "lastName", "fullName", "title", "phone", "companyName", "companyDomain"] as const;
export type CampaignField = (typeof CAMPAIGN_FIELDS)[number];

/** Field to grid column key. */
export type CampaignFieldMapping = Partial<Record<CampaignField, string>>;

export const MAX_CAMPAIGN_ROWS = 5_000;
export const MAX_CAMPAIGN_CUSTOM_COLUMNS = 20;

const IMPORT_TARGET: Record<CampaignField, string> = {
  email: "email",
  linkedin: "linkedin",
  firstName: "first_name",
  lastName: "last_name",
  fullName: "full_name",
  title: "title",
  phone: "phone",
  companyName: "company_name",
  companyDomain: "company_domain",
};

export interface LeadImportInput {
  headers: string[];
  /** Header to import target ("email", "first_name", "custom:Name"). */
  mapping: Record<string, string>;
  rows: Array<Record<string, string>>;
  /** Grid row id for each entry of `rows`, in the same order. */
  rowIds: string[];
}

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
  return JSON.stringify(value) ?? "";
};

export function buildLeadImport(
  rows: ReadonlyArray<{ id: string; cells: Record<string, unknown> }>,
  columns: ReadonlyArray<{ key: string; name: string }>,
  fields: CampaignFieldMapping,
  customColumnKeys: readonly string[] = [],
): LeadImportInput {
  const mapping: Record<string, string> = {};
  const headerFor = new Map<string, string>();
  const names = new Map(columns.map((c) => [c.key, c.name]));

  for (const field of CAMPAIGN_FIELDS) {
    const key = fields[field];
    if (!key) continue;
    mapping[field] = IMPORT_TARGET[field];
    headerFor.set(field, key);
  }
  const mappedKeys = new Set(Object.values(fields).filter(Boolean));
  const usedNames = new Set<string>();
  for (const key of customColumnKeys) {
    if (mappedKeys.has(key)) continue;
    const name = (names.get(key) ?? key).trim().slice(0, 60);
    if (!name || usedNames.has(name.toLowerCase())) continue;
    usedNames.add(name.toLowerCase());
    const header = `custom__${key}`;
    mapping[header] = `custom:${name}`;
    headerFor.set(header, key);
  }

  const headers = [...headerFor.keys()];
  return {
    headers,
    mapping,
    rowIds: rows.map((r) => r.id),
    rows: rows.map((row) => Object.fromEntries(headers.map((h) => [h, asText(row.cells[headerFor.get(h) as string])]))),
  };
}
