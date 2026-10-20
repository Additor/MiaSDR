import { campaignEnrollments, companies, people } from "@/platform/db/schema";

/**
 * Every stored field `buildVariables` reads for a person. Sending, the step preview, the lead list
 * and the email preview select this one set, so none of them can drop a field the others use.
 * The join must include `people` and `companies`.
 */
export const personVariableColumns = {
  firstName: people.firstName,
  lastName: people.lastName,
  fullName: people.fullName,
  title: people.title,
  phone: people.phone,
  email: people.email,
  custom: people.custom,
  companyName: companies.name,
  companyDomain: companies.domain,
  linkedinUrl: people.linkedinUrl,
  raw: people.raw,
  companyLinkedinUrl: companies.linkedinUrl,
  companyRaw: companies.raw,
};

/** The set above plus the enrollment's own overrides, which win over every other source. The join must include `campaign_enrollments`. */
export const enrollmentVariableColumns = { ...personVariableColumns, mergeFields: campaignEnrollments.mergeFields };
