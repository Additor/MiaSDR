/**
 * Wording of the company merge and delete dialogs ("Contacts and Companies CRUD" in docs/decisions.md). Pure, so the
 * dialogs and `company-merge-copy.test.ts` read the same lines. A company is named by its name, else its domain.
 */

export interface MergeSide {
  id: string;
  name: string | null;
  domain: string;
  version: number;
  people: number;
}

export interface MergePreview {
  kept: MergeSide;
  other: MergeSide;
  moves: { contacts: number; leads: number; openDeals: number; deals: number; leadsInRunningCampaigns: number };
  fieldConflicts: Array<{ key: string; name: string; kept: string; other: string }>;
  filledFields: Array<{ key: string; name: string; value: string }>;
  aliasDomains: string[];
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const companyLabel = (company: { name: string | null; domain: string }) => company.name?.trim() || company.domain;

/** A radio of step 1: "{name} ({domain}), {n} contacts". */
export const keepOptionLabel = (company: { name: string | null; domain: string; contacts: number }) =>
  `${companyLabel(company)} (${company.domain}), ${count(company.contacts, "contact", "contacts")}`;

export const noMatchText = (q: string) => `No company matches "${q}". Try a domain.`;

/** The preview's lines in the order of 6.1, ending in "This cannot be undone." A line with nothing to say is left out. */
export function mergePreviewLines(preview: MergePreview): string[] {
  const kept = companyLabel(preview.kept);
  const other = companyLabel(preview.other);
  const { contacts, leads, deals, leadsInRunningCampaigns } = preview.moves;
  const lines = [`${other} (${preview.other.domain}) merges into ${kept} (${preview.kept.domain}).`];
  const people = [contacts > 0 ? count(contacts, "contact", "contacts") : null, leads > 0 ? count(leads, "lead", "leads") : null].filter(Boolean);
  const one = contacts + leads === 1;
  if (people.length > 0) lines.push(`${people.join(" and ")} ${one ? "moves" : "move"} to ${kept}.`);
  if (deals > 0) lines.push(`${count(deals, "deal follows", "deals follow")} their contacts.`);
  if (leadsInRunningCampaigns > 0) lines.push(`${count(leadsInRunningCampaigns, "lead", "leads")} in running campaigns ${leadsInRunningCampaigns === 1 ? "gets" : "get"} ${kept}'s name in their next emails.`);
  lines.push(`${preview.other.domain} becomes another domain of ${kept}. Imports and person forms with ${preview.other.domain} attach people to ${kept}.`);
  for (const domain of preview.aliasDomains) lines.push(`${domain} moves to ${kept} too.`);
  for (const field of preview.fieldConflicts) lines.push(`${kept} keeps its ${field.name}: ${field.kept}. MiaSDR drops ${other}'s value (${field.other}).`);
  for (const field of preview.filledFields) lines.push(`${kept} takes ${other}'s ${field.name}: ${field.value}.`);
  lines.push("This cannot be undone.");
  return lines;
}

export const MERGE_TIMEOUT = "The merge may still be running. Reload in a minute to check.";
export const mergedText = (other: string, kept: string) => `Merged ${other} into ${kept}.`;

export const deleteCompanyDescription = (company: string, domain: string) =>
  `${company} has no contacts or leads. Deleting it removes its details, its custom field values and its other domains. Imports with ${domain} or its other domains create a new company. This cannot be undone.`;
export const companyChangedText = (company: string) => `${company} changed while this was open. Check it and delete again.`;
export const deletedCompanyText = (company: string) => `Deleted ${company}.`;
