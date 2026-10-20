import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { HELD_LOCK_TIMEOUT, setLockTimeout } from "@/platform/db/person-locks";
import { auditLog, companies, companyDomainAliases, entityColumns, people } from "@/platform/db/schema";
import type { CompanyLifecycleStore, CompanyRow } from "../application/company-lifecycle";
import { listedSql, lockCompanyDomain } from "./company-domain-store";

/*
 * The leads side of Add company, merge and company delete. The correlated subqueries name `companies` as written: Drizzle prints
 * a select-list column without its table, which would bind it to the subquery's table instead.
 */

const peopleCount = (lifecycle: "contact" | "lead") =>
  sql<number>`(select count(*)::int from people p where p.organization_id = companies.organization_id and p.company_id = companies.id and p.lifecycle = ${lifecycle})`;

const rowColumns = {
  id: companies.id,
  name: companies.name,
  domain: companies.domain,
  linkedinUrl: companies.linkedinUrl,
  custom: companies.custom,
  raw: companies.raw,
  version: companies.version,
  crmListedAt: companies.crmListedAt,
  contacts: peopleCount("contact"),
  leads: peopleCount("lead"),
};

const advisory = (key: string) => sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

export const drizzleCompanyLifecycleStore: CompanyLifecycleStore = {
  async lockImport(tx, organizationId) {
    await tx.execute(advisory(`leads-import:${organizationId}`));
  },

  async lockDomains(tx, organizationId, domains) {
    for (const domain of [...new Set(domains)].sort()) await lockCompanyDomain(tx, organizationId, domain);
  },

  async lockCompanyFields(tx, organizationId) {
    await tx.execute(advisory(`leads-columns:${organizationId}:companies`));
  },

  async holdLockTimeout(tx) {
    await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
  },

  async aliasOwner(tx, organizationId, domain) {
    const [row] = await tx
      .select({ companyId: companyDomainAliases.companyId })
      .from(companyDomainAliases)
      .where(and(eq(companyDomainAliases.organizationId, organizationId), eq(companyDomainAliases.domain, domain)));
    return row?.companyId ?? null;
  },

  async companyByDomainForUpdate(tx, organizationId, domain) {
    const [row] = await tx
      .select({ id: companies.id, name: companies.name, listed: listedSql })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), eq(companies.domain, domain)))
      .for("update");
    return row ?? null;
  },

  async insertListedCompany(tx, organizationId, row) {
    const [inserted] = await tx
      .insert(companies)
      .values({ organizationId, domain: row.domain, name: row.name, linkedinUrl: row.linkedinUrl, source: "manual", crmListedAt: sql`now()` })
      .onConflictDoNothing({ target: [companies.organizationId, companies.domain] })
      .returning({ id: companies.id });
    return inserted?.id ?? null;
  },

  async stampListed(tx, organizationId, companyId) {
    await tx
      .update(companies)
      .set({ crmListedAt: sql`now()`, version: sql`${companies.version} + 1`, updatedAt: new Date() })
      .where(and(eq(companies.organizationId, organizationId), eq(companies.id, companyId)));
  },

  async read(tx, organizationId, companyIds) {
    if (companyIds.length === 0) return [];
    return (await tx
      .select(rowColumns)
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), inArray(companies.id, [...companyIds])))) as CompanyRow[];
  },

  async lockCompanies(tx, organizationId, companyIds) {
    if (companyIds.length === 0) return [];
    return (await tx
      .select(rowColumns)
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), inArray(companies.id, [...companyIds])))
      .orderBy(asc(companies.id))
      .for("update")) as CompanyRow[];
  },

  async otherDomains(tx, organizationId, companyId) {
    const rows = await tx
      .select({ domain: companyDomainAliases.domain })
      .from(companyDomainAliases)
      .where(and(eq(companyDomainAliases.organizationId, organizationId), eq(companyDomainAliases.companyId, companyId)))
      .orderBy(asc(companyDomainAliases.domain));
    return rows.map((row) => row.domain);
  },

  async companyFields(tx, organizationId) {
    return tx
      .select({ key: entityColumns.key, name: entityColumns.name })
      .from(entityColumns)
      .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, "companies"), eq(entityColumns.isCore, false)))
      .orderBy(sql`${entityColumns.archivedAt} is not null`, asc(entityColumns.position), asc(entityColumns.key));
  },

  async lockPeopleOf(tx, organizationId, companyId) {
    await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.organizationId, organizationId), eq(people.companyId, companyId)))
      .orderBy(asc(people.id))
      .for("update");
  },

  async movePeople(tx, organizationId, fromId, toId) {
    const moved = await tx
      .update(people)
      .set({ companyId: toId, updatedAt: new Date() })
      .where(and(eq(people.organizationId, organizationId), eq(people.companyId, fromId)))
      .returning({ id: people.id });
    return moved.length;
  },

  async writeMerged(tx, organizationId, companyId, values) {
    await tx
      .update(companies)
      .set({
        name: values.name,
        linkedinUrl: values.linkedinUrl,
        custom: values.custom,
        raw: values.raw,
        crmListedAt: values.crmListedAt,
        version: sql`${companies.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(companies.organizationId, organizationId), eq(companies.id, companyId)));
  },

  async moveOtherDomains(tx, organizationId, fromId, toId) {
    await tx
      .update(companyDomainAliases)
      .set({ companyId: toId })
      .where(and(eq(companyDomainAliases.organizationId, organizationId), eq(companyDomainAliases.companyId, fromId)));
  },

  async deleteMerged(tx, organizationId, companyId) {
    await tx.delete(companies).where(and(eq(companies.organizationId, organizationId), eq(companies.id, companyId)));
  },

  async addOtherDomain(tx, organizationId, row) {
    await tx.insert(companyDomainAliases).values({ organizationId, ...row });
  },

  async mergeReplay(tx, organizationId, keptId, otherId) {
    const [alias] = await tx
      .select({ id: companyDomainAliases.id })
      .from(companyDomainAliases)
      .where(and(eq(companyDomainAliases.organizationId, organizationId), eq(companyDomainAliases.companyId, keptId), eq(companyDomainAliases.mergedCompanyId, otherId)));
    if (!alias) return null;
    const [entry] = await tx
      .select({ meta: auditLog.meta })
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, organizationId), eq(auditLog.action, "company.merged"), eq(auditLog.entityId, keptId), sql`${auditLog.meta}->>'otherId' = ${otherId}`))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const moved = entry?.meta.movedPeople;
    return typeof moved === "number" ? moved : 0;
  },

  async deleteIfEmpty(tx, organizationId, companyId) {
    const deleted = await tx
      .delete(companies)
      .where(
        and(
          eq(companies.organizationId, organizationId),
          eq(companies.id, companyId),
          sql`not exists (select 1 from people p where p.organization_id = ${organizationId} and p.company_id = ${companyId})`,
        ),
      )
      .returning({ id: companies.id });
    return deleted.length > 0;
  },
};
