import { CUSTOM_LABEL_MAX, customColumnKey, describeCustomLabels } from "./custom-fields";
import {
  blankToNull,
  inferCompanyDomain,
  normalizeCompanyLinkedinUrl,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  resolvePersonNames,
} from "./normalize";
import { parseLinkedinRef } from "./linkedin-url";
import { capRaw, mergeRaw, rawUnchanged, splitUnmapped, type RawData } from "./raw";

export const CORE_TARGETS = [
  "email",
  "first_name",
  "last_name",
  "full_name",
  "title",
  "phone",
  "linkedin",
  "company_domain",
  "company_name",
  "company_linkedin",
] as const;

export type CoreTarget = (typeof CORE_TARGETS)[number];
export type Target = CoreTarget | `custom:${string}`;
/** CSV header -> where its values go. "skip" drops the column. */
export type Mapping = Record<string, Target | "skip">;

const HEADER_HINTS: Array<[CoreTarget, RegExp]> = [
  ["email", /^(e-?mail( address)?|work e-?mail|이메일|메일)$/i],
  ["first_name", /^(first[ _-]?name|given[ _-]?name|이름)$/i],
  ["last_name", /^(last[ _-]?name|sur[ _-]?name|family[ _-]?name|성)$/i],
  ["full_name", /^(full[ _-]?name|name|contact name|성명)$/i],
  ["title", /^(job[ _-]?title|title|position|role|직책|직함)$/i],
  ["phone", /^(phone( number)?|mobile( phone)?|tel(ephone)?|전화(번호)?|휴대폰(번호)?|연락처)$/i],
  ["linkedin", /^(linkedin( url| profile)?( url)?|linkedin_url|profile url|링크드인( url| 주소| 프로필)?)$/i],
  ["company_domain", /^(company[ _-]?domain|domain|website|company[ _-]?website|url|웹사이트|도메인)$/i],
  ["company_name", /^(company([ _-]?name)?|organi[sz]ation|employer|회사(명)?|기업)$/i],
  ["company_linkedin", /^(company[ _-]?linkedin([ _-]?(url|page|profile))?|linkedin[ _-]?company([ _-]?(url|page))?|회사[ _-]?링크드인( url| 주소)?)$/i],
];

/**
 * Guess a mapping from header names. Each core target is used at most once.
 * Any other header with a name becomes a custom field (a merge field), so
 * `Job Title` renders as `{{jobTitle}}` without a step from the user.
 */
export function suggestMapping(headers: string[]): Mapping {
  const mapping: Mapping = {};
  const taken = new Set<CoreTarget>();
  for (const header of headers) {
    const name = header.trim();
    const hit = HEADER_HINTS.find(([target, pattern]) => !taken.has(target) && pattern.test(name));
    if (hit) {
      mapping[header] = hit[0];
      taken.add(hit[0]);
    } else if (name && customColumnKey(name)) {
      mapping[header] = `custom:${name.slice(0, CUSTOM_LABEL_MAX).trim()}`;
    } else {
      mapping[header] = "skip";
    }
  }
  return mapping;
}

export interface PersonCandidate {
  /** 1-based data row (header excluded). */
  row: number;
  email: string | null;
  linkedinSlug: string | null;
  /** Member id from a Sales Navigator or Recruiter URL or a bare provider id. Stored as `raw.linkedin_member_id`; identifies the lead when there is no email or slug. */
  linkedinMemberId: string | null;
  /** Canonical profile URL, or any other LinkedIn page as given (then linkedinSlug is null). */
  linkedinUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  phone: string | null;
  companyDomain: string | null;
  /** True when the domain came from the email address, not from the file. */
  companyDomainInferred: boolean;
  companyName: string | null;
  /** Canonical company page URL. */
  companyLinkedinUrl: string | null;
  /** Keyed by custom column key. */
  custom: Record<string, string>;
  /** Unmapped columns of the row, capped. */
  raw: RawData;
  /** Unmapped "Company ..." columns, capped. */
  companyRaw: RawData;
}

export interface CustomColumnRequest {
  key: string;
  name: string;
}

export interface RowIssue {
  row: number;
  reason: string;
  /** Why a row was skipped, when the reason has a kind the summary groups by. */
  kind?: "invalid_email" | "missing_identifier" | "file_conflict" | "duplicate" | "conflict";
}

export interface BuildResult {
  candidates: PersonCandidate[];
  customColumns: CustomColumnRequest[];
  invalid: RowIssue[];
  /** Rows merged into an earlier row of the same file. */
  duplicatesInFile: number;
  /** The first rows merged into an earlier row, for the summary. Capped at DUPLICATE_SAMPLE. */
  duplicateRows: RowIssue[];
  /** Non-fatal: a value that could not be read and was dropped. */
  warnings: RowIssue[];
  /** Rows whose raw data lost a key or part of a value to the size caps. */
  rawTruncatedRows: number;
}

export interface BuildOptions {
  /** ISO country for numbers written without a country code. */
  defaultCountry?: string;
  /** The file's headers. Needed to keep unmapped columns as raw data. */
  headers?: string[];
}

const DUPLICATE_SAMPLE = 20;

const PERSON_FIELDS = ["firstName", "lastName", "fullName", "title", "phone", "companyName", "companyLinkedinUrl"] as const;

/** Validates the mapping against the file's headers before any row is read. */
export function validateMapping(headers: string[], mapping: Mapping): string | null {
  const targets = headers.map((h) => mapping[h]).filter((t): t is Target => Boolean(t) && t !== "skip");
  if (!targets.includes("email") && !targets.includes("linkedin")) {
    return "Map a column to Email or LinkedIn. Each lead needs one of them to be identified.";
  }
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target)) return `More than one column maps to "${target}".`;
    seen.add(target);
  }
  const labels = targets.filter((t) => t.startsWith("custom:")).map((t) => t.slice("custom:".length));
  const bad = describeCustomLabels(labels).find((l) => l.problem);
  if (bad) return `Custom field "${bad.label.slice(0, 40)}": ${bad.problem}`;
  return null;
}

export function buildCandidates(rows: Array<Record<string, string>>, mapping: Mapping, options: BuildOptions = {}): BuildResult {
  const customColumns = new Map<string, string>();
  for (const target of Object.values(mapping)) {
    if (target.startsWith("custom:")) {
      const name = target.slice("custom:".length).trim();
      const key = customColumnKey(name);
      if (key) customColumns.set(key, name);
    }
  }

  const byIdentity = new Map<string, PersonCandidate>();
  const result: BuildResult = { candidates: [], customColumns: [], invalid: [], duplicatesInFile: 0, duplicateRows: [], warnings: [], rawTruncatedRows: 0 };

  rows.forEach((raw, index) => {
    const row = index + 1;
    const values: Partial<Record<CoreTarget, string>> = {};
    const custom: Record<string, string> = {};
    for (const [header, target] of Object.entries(mapping)) {
      if (target === "skip") continue;
      const value = blankToNull(raw[header]);
      if (value === null) continue;
      if (target.startsWith("custom:")) {
        const key = customColumnKey(target.slice("custom:".length).trim());
        if (key) custom[key] = value;
      } else {
        values[target as CoreTarget] = value;
      }
    }

    const email = normalizeEmail(values.email);
    const linkedinRef = parseLinkedinRef(values.linkedin);
    const linkedinSlug = linkedinRef?.slug ?? null;
    const linkedinMemberId = linkedinRef?.kind === "member" ? linkedinRef.memberId : null;
    const linkedinUrl = linkedinRef?.url ?? null;
    if (values.email && !email) result.warnings.push({ row, reason: `Email "${values.email}" is not valid and was ignored.` });
    if (values.linkedin && !linkedinRef) result.warnings.push({ row, reason: `LinkedIn value "${values.linkedin}" is not a LinkedIn URL and was ignored.` });
    if (linkedinRef?.kind === "other") result.warnings.push({ row, reason: `LinkedIn URL "${values.linkedin}" is not a person profile. It is stored as given and does not identify the lead.` });
    if (!email && !linkedinSlug && !linkedinMemberId) {
      // An email that was typed but failed validation reads differently from an empty cell.
      result.invalid.push(
        values.email && !email
          ? { row, kind: "invalid_email", reason: `"${values.email}" is not a valid email and the row has no LinkedIn profile.` }
          : { row, kind: "missing_identifier", reason: "No email or LinkedIn profile to identify this lead." },
      );
      return;
    }

    const phone = normalizePhone(values.phone, options.defaultCountry);
    if (values.phone && !phone) result.warnings.push({ row, reason: `Phone "${values.phone}" is not valid and was ignored.` });
    const explicitDomain = normalizeDomain(values.company_domain);
    if (values.company_domain && !explicitDomain) result.warnings.push({ row, reason: `Company domain "${values.company_domain}" could not be read and was ignored.` });
    const companyName = blankToNull(values.company_name);
    // A company name alone is enough to build a company when the email is a work address.
    const inferredDomain = !explicitDomain && companyName ? inferCompanyDomain(email) : null;
    const companyDomain = explicitDomain ?? inferredDomain;
    const companyLinkedinUrl = normalizeCompanyLinkedinUrl(values.company_linkedin);
    if (values.company_linkedin && !companyLinkedinUrl) {
      result.warnings.push({ row, reason: `Company LinkedIn value "${values.company_linkedin}" is not a LinkedIn company page and was ignored.` });
    }

    const first = blankToNull(values.first_name);
    const last = blankToNull(values.last_name);
    const unmapped = options.headers ? splitUnmapped(options.headers, mapping, raw) : { person: [], company: [] };
    // Without a company domain there is no company row to hold "Company ..." columns, so they stay on the person.
    // Without a domain the company name and page have no company row either, so they stay on the person as `company` and `company_linkedin_url`.
    const companyFallback: Array<[string, string]> = companyDomain
      ? []
      : [...(companyName ? ([["company", companyName]] as Array<[string, string]>) : []), ...(companyLinkedinUrl ? ([["company_linkedin_url", companyLinkedinUrl]] as Array<[string, string]>) : [])];
    const personRaw = capRaw(companyDomain ? unmapped.person : [...unmapped.person, ...unmapped.company, ...companyFallback], linkedinMemberId ? { linkedin_member_id: linkedinMemberId } : {});
    const companyRaw = capRaw(companyDomain ? unmapped.company : []);
    if (personRaw.droppedKeys.length + personRaw.truncatedKeys.length + companyRaw.droppedKeys.length + companyRaw.truncatedKeys.length > 0) {
      result.rawTruncatedRows += 1;
    }
    const candidate: PersonCandidate = {
      row,
      email,
      linkedinSlug,
      linkedinMemberId,
      linkedinUrl,
      firstName: first,
      lastName: last,
      // Only an explicit full name. A partial row must not derive one that overwrites a stored name.
      fullName: blankToNull(values.full_name),
      title: blankToNull(values.title),
      phone,
      companyDomain,
      companyDomainInferred: inferredDomain !== null,
      companyName,
      companyLinkedinUrl,
      custom,
      raw: personRaw.raw,
      companyRaw: companyRaw.raw,
    };

    const identity = email ? `e:${email}` : linkedinSlug ? `l:${linkedinSlug}` : `m:${linkedinMemberId}`;
    const alt = linkedinSlug ? `l:${linkedinSlug}` : linkedinMemberId ? `m:${linkedinMemberId}` : null;
    const byEmailOrSlug = byIdentity.get(identity);
    const byAlt = alt ? byIdentity.get(alt) : undefined;
    if (byEmailOrSlug && byAlt && byEmailOrSlug !== byAlt) {
      // The row ties two earlier leads of the file together. Merging either way would give two leads one LinkedIn profile.
      result.invalid.push({ row, kind: "file_conflict", reason: "Its email and LinkedIn profile belong to two different earlier rows of this file." });
      return;
    }
    const earlier = byEmailOrSlug ?? byAlt;
    if (earlier) {
      mergeCandidate(earlier, candidate);
      byIdentity.set(identity, earlier);
      if (alt) byIdentity.set(alt, earlier);
      result.duplicatesInFile += 1;
      if (result.duplicateRows.length < DUPLICATE_SAMPLE) {
        result.duplicateRows.push({ row, kind: "duplicate", reason: `Same lead as row ${earlier.row}. Its values are merged into that row.` });
      }
      return;
    }
    byIdentity.set(identity, candidate);
    if (alt) byIdentity.set(alt, candidate);
    result.candidates.push(candidate);
  });

  result.customColumns = [...customColumns].map(([key, name]) => ({ key, name }));
  return result;
}

function joinName(first: string | null, last: string | null): string | null {
  return [first, last].filter(Boolean).join(" ") || null;
}

/** A later row of the same lead fills gaps and overrides with non-empty values. */
function mergeCandidate(into: PersonCandidate, from: PersonCandidate): void {
  into.email ??= from.email;
  into.linkedinSlug ??= from.linkedinSlug;
  into.linkedinMemberId ??= from.linkedinMemberId;
  // A profile URL replaces a non-person page; a later non-person page never replaces a profile.
  if (from.linkedinUrl && (into.linkedinUrl === null || (from.linkedinSlug && !into.linkedinSlug))) into.linkedinUrl = from.linkedinUrl;
  for (const field of PERSON_FIELDS) {
    if (from[field] !== null) into[field] = from[field];
  }
  // A domain from the file beats one inferred from an email.
  if (from.companyDomain !== null && !(from.companyDomainInferred && into.companyDomain !== null && !into.companyDomainInferred)) {
    into.companyDomain = from.companyDomain;
    into.companyDomainInferred = from.companyDomainInferred;
  }
  Object.assign(into.custom, from.custom);
  into.raw = mergeRaw(into.raw, from.raw).raw;
  into.companyRaw = mergeRaw(into.companyRaw, from.companyRaw).raw;
}

/** Moves each candidate's custom values to the stored key of their column. */
export function remapCustomKeys(candidates: PersonCandidate[], keyMap: ReadonlyMap<string, string>): PersonCandidate[] {
  if ([...keyMap].every(([from, to]) => from === to)) return candidates;
  return candidates.map((c) => ({
    ...c,
    custom: Object.fromEntries(Object.entries(c.custom).map(([key, value]) => [keyMap.get(key) ?? key, value])),
  }));
}

export interface ExistingPerson {
  id: string;
  email: string | null;
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  phone: string | null;
  companyId: string | null;
  /** The domain of companyId, when set. */
  companyDomain: string | null;
  custom: Record<string, unknown>;
  raw: Record<string, unknown> | null;
  /** `lead` or `contact`. The store reads it to keep a company listed when its last contact moves away. */
  lifecycle?: string;
}

export interface PersonInsert {
  row: number;
  email: string | null;
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  phone: string | null;
  companyDomain: string | null;
  custom: Record<string, string>;
  raw: RawData;
}

export interface PersonUpdate {
  id: string;
  row: number;
  patch: Partial<Pick<PersonInsert, "email" | "linkedinSlug" | "linkedinUrl" | "firstName" | "lastName" | "fullName" | "title" | "phone">> & {
    custom?: Record<string, string>;
    /** The merged raw object to store (existing keys plus the file's). */
    raw?: RawData;
    companyDomain?: string;
  };
}

export interface ImportPlan {
  inserts: PersonInsert[];
  updates: PersonUpdate[];
  /** Matched an existing lead and nothing would change. */
  unchanged: number;
  /** Email and LinkedIn point at two different existing leads. */
  conflicts: RowIssue[];
  /** domain -> name seen in the file (null when none). Created if missing, name filled if empty. */
  companies: Map<string, string | null>;
  /** domain -> unmapped company columns seen in the file. Merged into companies.raw. */
  companyRaw: Map<string, RawData>;
  /** domain -> company page URL seen in the file. Fills an empty companies.linkedin_url. */
  companyLinkedin: Map<string, string>;
}

export interface PlanOptions {
  /**
   * Other domains (aliases) of the file's domains, mapped to the domain of the company that holds them. A row with an alias
   * domain lands on that company, and its company columns merge with the company's other rows by the per-domain rules.
   */
  aliases?: ReadonlyMap<string, string>;
}

/**
 * Decides, for each candidate, whether it creates a lead, updates one, or
 * changes nothing. A non-empty value in the file replaces the stored one; an
 * empty cell never erases anything.
 */
export function planImport(candidates: PersonCandidate[], existing: ExistingPerson[], options: PlanOptions = {}): ImportPlan {
  const aliases = options.aliases;
  const byEmail = new Map<string, ExistingPerson>();
  const bySlug = new Map<string, ExistingPerson>();
  const byMember = new Map<string, ExistingPerson>();
  for (const person of existing) {
    if (person.email) byEmail.set(person.email.toLowerCase(), person);
    if (person.linkedinSlug) bySlug.set(person.linkedinSlug, person);
    const memberId = person.raw?.linkedin_member_id;
    if (typeof memberId === "string") byMember.set(memberId, person);
  }

  const plan: ImportPlan = { inserts: [], updates: [], unchanged: 0, conflicts: [], companies: new Map(), companyRaw: new Map(), companyLinkedin: new Map() };

  for (const candidate of candidates) {
    const resolvedDomain = candidate.companyDomain ? (aliases?.get(candidate.companyDomain) ?? candidate.companyDomain) : null;
    const c = resolvedDomain === candidate.companyDomain ? candidate : { ...candidate, companyDomain: resolvedDomain };
    const byMail = c.email ? byEmail.get(c.email) : undefined;
    const byLink = c.linkedinSlug ? bySlug.get(c.linkedinSlug) : undefined;
    const byMemberId = c.linkedinMemberId ? byMember.get(c.linkedinMemberId) : undefined;
    const owners = new Set([byMail?.id, byLink?.id, byMemberId?.id].filter((id): id is string => id !== undefined));
    if (owners.size > 1) {
      plan.conflicts.push({ row: c.row, kind: "conflict", reason: "Email and LinkedIn profile belong to two different existing leads." });
      continue;
    }
    const match = byMail ?? byLink ?? byMemberId;

    // An inferred domain never moves a lead that already has a company, so it creates no company row either.
    const useDomain = c.companyDomain !== null && !(c.companyDomainInferred && match?.companyId);
    if (useDomain && c.companyDomain) {
      const known = plan.companies.get(c.companyDomain) ?? null;
      plan.companies.set(c.companyDomain, known ?? c.companyName);
      if (Object.keys(c.companyRaw).length > 0) {
        plan.companyRaw.set(c.companyDomain, { ...plan.companyRaw.get(c.companyDomain), ...c.companyRaw });
      }
      if (c.companyLinkedinUrl) plan.companyLinkedin.set(c.companyDomain, c.companyLinkedinUrl);
    }

    if (!match) {
      const names = resolvePersonNames({ first: c.firstName, last: c.lastName, full: c.fullName });
      plan.inserts.push({
        row: c.row,
        email: c.email,
        linkedinSlug: c.linkedinSlug,
        linkedinUrl: c.linkedinUrl,
        firstName: names.firstName,
        lastName: names.lastName,
        fullName: names.fullName,
        title: c.title,
        phone: c.phone,
        companyDomain: c.companyDomain,
        custom: c.custom,
        raw: c.raw,
      });
      continue;
    }

    const patch: PersonUpdate["patch"] = {};
    const scalar = ["firstName", "lastName", "fullName", "title", "phone"] as const;
    for (const field of scalar) {
      if (c[field] !== null && c[field] !== match[field]) patch[field] = c[field];
    }
    // A full name fills a missing first or last name. It never replaces a stored part.
    const names = resolvePersonNames({ first: c.firstName, last: c.lastName, full: c.fullName });
    if (c.firstName === null && names.firstName !== null && match.firstName === null) patch.firstName = names.firstName;
    if (c.lastName === null && names.lastName !== null && match.lastName === null) patch.lastName = names.lastName;
    if (c.fullName === null && (patch.firstName !== undefined || patch.lastName !== undefined)) {
      const derived = joinName(patch.firstName ?? match.firstName, patch.lastName ?? match.lastName);
      if (derived !== null && derived !== match.fullName) patch.fullName = derived;
    }
    if (c.email && !match.email) patch.email = c.email;
    if (c.linkedinSlug && !match.linkedinSlug) patch.linkedinSlug = c.linkedinSlug;
    // A profile fills the URL when the stored one is empty, differs from canonical, or is a non-person page.
    // A non-person page only fills an empty URL.
    const nextUrl = c.linkedinSlug && (!match.linkedinSlug || match.linkedinSlug === c.linkedinSlug) ? c.linkedinUrl : match.linkedinUrl ? null : c.linkedinUrl;
    if (nextUrl && nextUrl !== match.linkedinUrl) patch.linkedinUrl = nextUrl;
    if (useDomain && c.companyDomain && c.companyDomain !== match.companyDomain) patch.companyDomain = c.companyDomain;
    const customChanges = Object.fromEntries(Object.entries(c.custom).filter(([k, v]) => match.custom[k] !== v));
    if (Object.keys(customChanges).length > 0) patch.custom = customChanges;
    // A lead keeps the member id it has; a different id in the file never replaces it.
    const heldMemberId = match.raw?.linkedin_member_id;
    const { linkedin_member_id: incomingMemberId, ...otherRaw } = c.raw;
    const incomingRaw: RawData = typeof heldMemberId === "string" && heldMemberId !== incomingMemberId ? otherRaw : c.raw;
    if (Object.keys(incomingRaw).length > 0 && !rawUnchanged(match.raw, incomingRaw)) patch.raw = mergeRaw(match.raw, incomingRaw).raw;

    if (Object.keys(patch).length === 0) {
      plan.unchanged += 1;
    } else {
      plan.updates.push({ id: match.id, row: c.row, patch });
      // Later candidates in this run see the updated identity.
      if (patch.email) byEmail.set(patch.email, { ...match, email: patch.email });
      if (patch.linkedinSlug) bySlug.set(patch.linkedinSlug, { ...match, linkedinSlug: patch.linkedinSlug });
    }
  }
  return plan;
}
