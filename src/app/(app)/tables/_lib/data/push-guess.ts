import type { CampaignField } from "@/contexts/grid/domain/campaign-rows";
import { verifyColumns } from "@/contexts/grid/domain/verified-push";
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

const FINDS_EMAIL = new Set(["find-work-email", "enrich-person", "find-email"]);

/**
 * The address a push should send to, when the table enriched one: the column a verification checked, else a work
 * email an enrichment found. Null leaves the guess by name, which reads the raw imported column.
 */
export function enrichedEmailColumn(columns: GridColumn[]): string | null {
  const checked = verifyColumns(columns).find((c) => c.emailColumnKey && columns.some((x) => x.key === c.emailColumnKey));
  if (checked) return checked.emailColumnKey;
  const actionOf = (key: unknown) => {
    const source = columns.find((c) => c.key === key);
    const steps = source?.config.steps as Array<{ actionKey?: unknown }> | undefined;
    return source?.type === "waterfall" ? steps?.[0]?.actionKey : source?.config.actionKey;
  };
  const found = columns.find((c) => c.type === "integration_output" && c.config.outputKey === "email" && FINDS_EMAIL.has(String(actionOf(c.config.sourceColumnKey))));
  if (found) return found.key;
  // A finder's own column shows the email it found, when no output column was added for it.
  const runner = columns.find((c) => (c.type === "enrichment" || c.type === "waterfall") && FINDS_EMAIL.has(String(actionOf(c.key))));
  return runner?.key ?? null;
}

/** One guess per field, in field order, never giving one column to two fields. Email prefers an enriched address. */
export function guessFields(fields: readonly CampaignField[], columns: GridColumn[]): Partial<Record<CampaignField, string | null>> {
  const taken = new Set<string>();
  const out: Partial<Record<CampaignField, string | null>> = {};
  for (const f of fields) {
    const key = (f === "email" ? enrichedEmailColumn(columns) : null) ?? guessField(f, columns, taken);
    out[f] = key;
    if (key) taken.add(key);
  }
  return out;
}
