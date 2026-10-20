import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { sqlState, TRY_AGAIN } from "@/platform/db/person-locks";
import { companies, companyDomainAliases } from "@/platform/db/schema";
import { ConflictError, ValidationError } from "@/shared/errors";
import { checkCompanyDomain } from "../domain/company-domain";

/*
 * Company domains and their other domains (`company_domain_aliases`), plan 4.3 and 4.5 of
 * "Contacts and Companies CRUD" in docs/decisions.md. Every writer of one domain takes `leads-company-domain:{org}:{domain}` before
 * it reads the aliases (the import holds `leads-import:{org}` instead, which every alias writer takes first), so a person save
 * and a merge of that domain run one after the other. Two guard triggers of migration 0027 back the rule up.
 */

/** The guard triggers of migration 0027 raise 23505 with these names when a path skipped the domain lock. */
export const DOMAIN_GUARD_CONSTRAINTS: ReadonlySet<string> = new Set(["company_domain_is_alias", "alias_is_company_domain"]);

/** The constraint a 23505 names, also under a wrapping error's `cause`. */
export function uniqueViolation(error: unknown): string | null {
  if (sqlState(error) !== "23505") return null;
  let current = error as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current.constraint_name === "string") return current.constraint_name;
    current = current.cause as typeof current;
  }
  return null;
}

/** Holds the domain until commit, hashed as the other leads locks are. */
export async function lockCompanyDomain(tx: DbHandle, organizationId: string, domain: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`leads-company-domain:${organizationId}:${domain}`}, 0))`);
}

export interface ResolvedCompany {
  companyId: string;
  name: string | null;
  /** The company's own domain, also when `domain` was one of its other domains. */
  domain: string;
  viaAlias: boolean;
  /** True when this call inserted the company. */
  created: boolean;
}

/**
 * The company a typed domain lands on, for the person form and Add contact: the domain lock, then an alias, then the company
 * row `FOR KEY SHARE`, else an insert. The conflict arm covers a company an import inserted under `leads-import` and not the
 * domain lock. `domain` is normalized. The caller compares `name` with what it was sent (M8).
 */
export async function resolveCompanyDomain(tx: DbHandle, organizationId: string, domain: string, input: { name: string | null }): Promise<ResolvedCompany> {
  await lockCompanyDomain(tx, organizationId, domain);
  const [alias] = await tx
    .select({ companyId: companyDomainAliases.companyId })
    .from(companyDomainAliases)
    .where(and(eq(companyDomainAliases.organizationId, organizationId), eq(companyDomainAliases.domain, domain)));
  if (alias) {
    const [target] = await tx
      .select({ id: companies.id, name: companies.name, domain: companies.domain })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), eq(companies.id, alias.companyId)))
      .for("key share");
    // The alias row and its company go together (CASCADE), and the lock keeps a merge from moving it now.
    if (target) return { companyId: target.id, name: target.name, domain: target.domain, viaAlias: true, created: false };
  }
  const [existing] = await tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.organizationId, organizationId), eq(companies.domain, domain)))
    .for("key share");
  if (existing) return { companyId: existing.id, name: existing.name, domain, viaAlias: false, created: false };
  try {
    const [row] = await tx
      .insert(companies)
      .values({ organizationId, domain, name: input.name, source: "manual" })
      .onConflictDoUpdate({
        target: [companies.organizationId, companies.domain],
        set: { name: sql`coalesce(${companies.name}, excluded.name)`, version: sql`${companies.version} + 1`, updatedAt: new Date() },
      })
      .returning({ id: companies.id, name: companies.name, inserted: sql<boolean>`(xmax = 0)` });
    return { companyId: row.id, name: row.name, domain, viaAlias: false, created: row.inserted };
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint && DOMAIN_GUARD_CONSTRAINTS.has(constraint)) throw new ConflictError(TRY_AGAIN, { code: "try_again" });
    throw error;
  }
}

/**
 * M3: a company whose last contact moved away or went stays in Companies. Stamps `crm_listed_at` on each of these companies that
 * has no stamp and no contact left. Run after the people writes, in the same transaction.
 */
export async function stampCompaniesLeftByContacts(tx: DbHandle, organizationId: string, companyIds: readonly string[]): Promise<void> {
  const ids = [...new Set(companyIds)];
  if (ids.length === 0) return;
  await tx
    .update(companies)
    .set({ crmListedAt: sql`now()`, version: sql`${companies.version} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(companies.organizationId, organizationId),
        inArray(companies.id, ids),
        isNull(companies.crmListedAt),
        sql`not exists (select 1 from people p where p.organization_id = ${organizationId} and p.company_id = companies.id and p.lifecycle = 'contact')`,
      ),
    );
}

/** Domain to the kept company's domain, for the import: the aliases among these domains. */
export async function aliasTargets(tx: DbHandle, organizationId: string, domains: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(domains)];
  for (let i = 0; i < unique.length; i += 5000) {
    const rows = await tx
      .select({ alias: companyDomainAliases.domain, domain: companies.domain })
      .from(companyDomainAliases)
      .innerJoin(companies, and(eq(companies.id, companyDomainAliases.companyId), eq(companies.organizationId, companyDomainAliases.organizationId)))
      .where(and(eq(companyDomainAliases.organizationId, organizationId), inArray(companyDomainAliases.domain, unique.slice(i, i + 5000))));
    for (const row of rows) result.set(row.alias, row.domain);
  }
  return result;
}

/*
 * The correlated subqueries below name `companies` and their own aliases as written: Drizzle prints a column of a select list
 * without its table, which would bind it to the subquery's table instead.
 */

/**
 * Companies lists a company with a stamp or a contact (M3). The one copy for the leads context: Add company, the merge picker and
 * the lifecycle store read it here. `deals/infrastructure/crm-read.ts` `companies()` applies the same rule under the alias `c`; a
 * change to the rule goes to both.
 */
export const listedSql = sql<boolean>`(companies.crm_listed_at is not null or exists (select 1 from people p where p.organization_id = companies.organization_id and p.company_id = companies.id and p.lifecycle = 'contact'))`;

export interface CompanyMatch {
  companyId: string;
  name: string | null;
  /** The company's own domain. */
  domain: string;
  viaAlias: boolean;
  listed: boolean;
}

/** The live lookup of a typed domain (Add contact, Add company, the person form). 422 for a value that is no company domain. */
export async function findCompanyByDomain(organizationId: string, raw: string): Promise<CompanyMatch | null> {
  const checked = checkCompanyDomain(raw);
  if (checked.issue !== null) throw new ValidationError(checked.issue);
  const domain = checked.domain;
  const select = { companyId: companies.id, name: companies.name, domain: companies.domain, listed: listedSql };
  const [own] = await db
    .select(select)
    .from(companies)
    .where(and(eq(companies.organizationId, organizationId), eq(companies.domain, domain)));
  if (own) return { ...own, viaAlias: false };
  const [viaAlias] = await db
    .select(select)
    .from(companyDomainAliases)
    .innerJoin(companies, and(eq(companies.id, companyDomainAliases.companyId), eq(companies.organizationId, companyDomainAliases.organizationId)))
    .where(and(eq(companyDomainAliases.organizationId, organizationId), eq(companyDomainAliases.domain, domain)));
  return viaAlias ? { ...viaAlias, viaAlias: true } : null;
}

export const MAX_COMPANY_SEARCH = 20;

export interface CompanySearchRow {
  companyId: string;
  name: string | null;
  domain: string;
  contacts: number;
  listed: boolean;
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Companies whose name, domain or other domain contains `q`, at most 20, by name. `all` includes companies that are not listed
 * in Companies (leads only), for the merge picker.
 */
export async function searchCompanies(organizationId: string, q: string, options: { all?: boolean } = {}): Promise<CompanySearchRow[]> {
  const text = q.trim().toLowerCase().slice(0, 200);
  const pattern = `%${likeEscape(text)}%`;
  const match = text
    ? sql`(lower(coalesce(companies.name, '')) like ${pattern} or companies.domain like ${pattern} or exists (select 1 from company_domain_aliases a where a.organization_id = companies.organization_id and a.company_id = companies.id and a.domain like ${pattern}))`
    : undefined;
  const contacts = sql<number>`(select count(*)::int from people p where p.organization_id = companies.organization_id and p.company_id = companies.id and p.lifecycle = 'contact')`;
  return db
    .select({ companyId: companies.id, name: companies.name, domain: companies.domain, contacts, listed: listedSql })
    .from(companies)
    .where(and(eq(companies.organizationId, organizationId), match, options.all ? undefined : listedSql))
    .orderBy(sql`lower(${companies.name}) asc nulls last`, asc(companies.domain))
    .limit(MAX_COMPANY_SEARCH);
}
