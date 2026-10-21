import type { LeadDetail } from "@/contexts/leads/application/lead-ports";
import { canonicalProfileUrl } from "@/contexts/leads/domain/linkedin-url";

/** A person's own fields, as the Details rows read and save them. */
export interface LeadFormValues {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  linkedin: string;
  title: string;
  companyDomain: string;
  companyName: string;
}

export interface CustomField {
  key: string;
  name: string;
  value: string;
}

/**
 * The form values and custom fields `PersonDetails` takes, for the lead and the contact page. The custom fields list the
 * organization's fields first, then values under keys no field defines any more, named by their key.
 */
export function personDetailsFields({ person, customColumns }: Pick<LeadDetail, "person" | "customColumns">): { values: LeadFormValues; customFields: CustomField[] } {
  const names = new Map(customColumns.map((c) => [c.key, c.name]));
  const customFields = [
    ...customColumns.map((c) => ({ key: c.key, name: c.name, value: String(person.custom[c.key] ?? "") })),
    ...Object.entries(person.custom)
      .filter(([key]) => !names.has(key))
      .map(([key, value]) => ({ key, name: key, value: String(value ?? "") })),
  ];
  const values = {
    firstName: person.firstName ?? "",
    lastName: person.lastName ?? "",
    fullName: person.fullName ?? "",
    email: person.email ?? "",
    phone: person.phone ?? "",
    linkedin: person.linkedinUrl ?? (person.linkedinSlug ? canonicalProfileUrl(person.linkedinSlug) : ""),
    title: person.title ?? "",
    companyDomain: person.companyDomain ?? "",
    companyName: person.companyName ?? "",
  };
  return { values, customFields };
}
