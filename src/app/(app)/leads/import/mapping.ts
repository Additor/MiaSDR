import { describeCustomLabels } from "@/contexts/leads/domain/custom-fields";

export interface TargetOption {
  value: string;
  label: string;
}

/** The "Import as" choices, grouped the way the select shows them. */
export const TARGET_GROUPS: Array<{ label: string; options: TargetOption[] }> = [
  {
    label: "Contact",
    options: [
      { value: "email", label: "Email" },
      { value: "first_name", label: "First name" },
      { value: "last_name", label: "Last name" },
      { value: "full_name", label: "Full name" },
      { value: "title", label: "Job title" },
      { value: "phone", label: "Phone" },
      { value: "linkedin", label: "LinkedIn profile" },
    ],
  },
  {
    label: "Company",
    options: [
      { value: "company_name", label: "Company name" },
      { value: "company_domain", label: "Company domain or website" },
      { value: "company_linkedin", label: "Company LinkedIn page" },
    ],
  },
  { label: "Custom", options: [{ value: "custom", label: "Custom field" }] },
  { label: "Skip", options: [{ value: "skip", label: "Keep in source data only" }] },
];

export const TARGETS: TargetOption[] = TARGET_GROUPS.flatMap((g) => g.options);

export type Mapping = Record<string, string>;

/** The select shows "custom" for every `custom:<label>` target. */
export const selectValue = (target: string) => (target.startsWith("custom:") ? "custom" : target);

export const customLabelOf = (target: string) => target.slice("custom:".length);

/** What each custom column produces, keyed by header. Flags a label that is too long, empty or a duplicate. */
export function describeCustom(headers: string[], mapping: Mapping) {
  const custom = headers.filter((h) => mapping[h]?.startsWith("custom:"));
  const described = describeCustomLabels(custom.map((h) => customLabelOf(mapping[h])));
  return new Map(custom.map((h, i) => [h, described[i]]));
}

/** The reason the mapping cannot be imported, or null. The server checks the same rules again. */
export function mappingError(headers: string[], mapping: Mapping): string | null {
  const targets = headers.map((h) => mapping[h]).filter((t) => t && t !== "skip");
  const flagged = [...describeCustom(headers, mapping)].find(([, d]) => d.problem);
  if (flagged) return `Column "${flagged[0]}": ${flagged[1].problem}`;
  if (!targets.includes("email") && !targets.includes("linkedin")) return "Map one column to Email or LinkedIn profile.";
  const core = targets.filter((t) => !t.startsWith("custom:"));
  const duplicate = core.find((t, i) => core.indexOf(t) !== i);
  return duplicate ? `More than one column is mapped to "${TARGETS.find((x) => x.value === duplicate)?.label}".` : null;
}
