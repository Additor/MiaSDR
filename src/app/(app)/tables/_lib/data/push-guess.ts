import type { CampaignField } from "@/contexts/grid/domain/campaign-rows";
import type { GridColumn } from "./types";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const NAMES: Record<CampaignField, string[]> = {
  email: ["email", "workemail", "emailaddress"],
  linkedin: ["linkedin", "linkedinurl", "linkedinprofile"],
  firstName: ["firstname", "first"],
  lastName: ["lastname", "last", "surname"],
  fullName: ["fullname", "name"],
  title: ["title", "jobtitle", "position"],
  phone: ["phone", "phonenumber", "mobile"],
  companyName: ["company", "companyname", "organization"],
  companyDomain: ["domain", "companydomain", "website"],
};

/**
 * The column a lead field most likely comes from, matched by the name a person sees. The key is ignored:
 * the starter column keeps the key "name" after an import renames it, so a key match would read an Email
 * column as the lead's full name. `taken` holds the columns earlier fields already use.
 */
export function guessField(field: CampaignField, columns: GridColumn[], taken: ReadonlySet<string> = new Set()): string | null {
  const free = columns.filter((c) => !taken.has(c.key));
  const hit = free.find((c) => NAMES[field].includes(norm(c.name)));
  if (hit) return hit.key;
  if (field === "email") return free.find((c) => c.type === "email")?.key ?? null;
  return null;
}

/** One guess per field, in field order, never giving one column to two fields. */
export function guessFields(fields: readonly CampaignField[], columns: GridColumn[]): Partial<Record<CampaignField, string | null>> {
  const taken = new Set<string>();
  const out: Partial<Record<CampaignField, string | null>> = {};
  for (const f of fields) {
    const key = guessField(f, columns, taken);
    out[f] = key;
    if (key) taken.add(key);
  }
  return out;
}
