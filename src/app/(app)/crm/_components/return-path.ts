/**
 * Where a page goes back to, read from its `?from=` parameter. Only paths of this app on the allowlist pass,
 * so a crafted link cannot send you to another site after a delete. A list path keeps its query (filter, sort, page).
 */

export interface ReturnPath {
  path: string;
  /** The back link's text. */
  label: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

interface Allowed {
  pattern: RegExp;
  label: string;
  /** A list takes its query along; a single page answers on its path alone. */
  query: boolean;
}

const allowed = (path: string, label: string, query: boolean): Allowed => ({ pattern: new RegExp(`^${path}$`, "i"), label, query });

const PIPELINE = allowed("/crm/pipeline", "Pipeline", true);
const CONTACTS = allowed("/crm/contacts", "Contacts", true);
const CONTACT = allowed(`/crm/contacts/${UUID}`, "Contact", false);
const COMPANIES = allowed("/crm/companies", "Companies", true);
const COMPANY = allowed(`/crm/companies/${UUID}`, "Company", false);
const INBOX_THREAD = allowed(`/inbox/${UUID}`, "Inbox", false);

const DEAL_ORIGINS = [PIPELINE, CONTACTS, CONTACT, COMPANIES, COMPANY, INBOX_THREAD];
const CONTACT_ORIGINS = [CONTACTS, COMPANY];

export const DEAL_FALLBACK: ReturnPath = { path: "/crm/pipeline", label: "Pipeline" };
export const CONTACT_FALLBACK = "/crm/contacts";

function match(from: string | null | undefined, origins: readonly Allowed[]): ReturnPath | null {
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//")) return null;
  // A backslash reads as a slash in some browsers, and a control character can hide one.
  if (/[\\\u0000-\u001f\u007f]/.test(from)) return null;
  const queryAt = from.indexOf("?");
  const path = queryAt === -1 ? from : from.slice(0, queryAt);
  const query = queryAt === -1 ? "" : from.slice(queryAt);
  if (path.includes("#")) return null;
  const origin = origins.find((o) => o.pattern.test(path));
  if (!origin) return null;
  return { path: origin.query && query.length > 1 ? `${path}${query}` : path, label: origin.label };
}

/** The deal page's back link and its landing after a delete: Pipeline, Contacts, Contact, Companies, Company or Inbox. */
export function dealReturnPath(from: string | null | undefined): ReturnPath {
  return match(from, DEAL_ORIGINS) ?? DEAL_FALLBACK;
}

/** The contact page's landing after a delete: the Contacts list with its query, or the company page it came from. */
export function contactReturnPath(from: string | null | undefined): string {
  return match(from, CONTACT_ORIGINS)?.path ?? CONTACT_FALLBACK;
}
