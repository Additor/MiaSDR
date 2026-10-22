import { blankToNull, normalizeDomain, WEBMAIL_DOMAINS } from "./normalize";

/*
 * The one check of a company domain that a person types: Add company, Add contact, the person form and the domain lookup
 * call it ("Contacts and Companies CRUD" in docs/decisions.md). The import keeps its own rules: it warns and moves on.
 */

export type CompanyDomainCheck = { domain: string; issue: null } | { domain: null; issue: string };

/** Normalizes a domain or website and refuses a value that is not one, and a webmail domain, which names no employer. */
export function checkCompanyDomain(raw: string): CompanyDomainCheck {
  const text = blankToNull(raw) ?? "";
  const domain = normalizeDomain(text);
  if (!domain) return { domain: null, issue: `"${text}" is not a company domain or website.` };
  if (WEBMAIL_DOMAINS.has(domain)) return { domain: null, issue: `${domain} is an email provider, not a company domain.` };
  return { domain, issue: null };
}

/** The label of a company in copy: its name, else its domain. */
export const companyLabel = (company: { name: string | null; domain: string }): string => company.name ?? company.domain;

/** M8: the person form and Add contact never rename an existing company. */
export const renameOnCompanyPage = (company: { name: string | null; domain: string }): string => `Rename ${companyLabel(company)} on its company page.`;
