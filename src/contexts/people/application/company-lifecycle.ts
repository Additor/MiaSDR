import type { DbHandle } from "@/platform/db/client";
import { retryOnce } from "@/platform/db/errors";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { checkCompanyDomain, companyLabel } from "../domain/company-domain";
import { planCompanyEdit } from "../domain/company-edit";
import { planCompanyMerge, type CompanyFieldInfo, type FieldConflict, type FilledField } from "../domain/company-merge";
import type { LeadsAudit } from "./leads-audit";

/*
 * Add company, company merge and company delete ("Contacts and Companies CRUD" in docs/decisions.md).
 * Any member can run them (P4). Every writer of a domain holds its domain lock, and merge and delete hold `leads-import:{org}`
 * first, so an import never sees half a merge and no alias appears under a running import. Every company write bumps
 * `companies.version`, which the merge and the delete check against what the dialog showed.
 */

/** A company as the use cases read it, with the people who point at it. */
export interface CompanyRow {
  id: string;
  name: string | null;
  domain: string;
  linkedinUrl: string | null;
  custom: Record<string, unknown>;
  raw: Record<string, unknown> | null;
  version: number;
  crmListedAt: Date | null;
  contacts: number;
  leads: number;
}

export interface MergedValues {
  name: string | null;
  linkedinUrl: string | null;
  custom: Record<string, unknown>;
  raw: Record<string, unknown> | null;
  crmListedAt: Date | null;
}

/** The leads side of these use cases. `drizzle-company-lifecycle-store.ts` implements it; every method runs in the caller's transaction. */
export interface CompanyLifecycleStore {
  /** `leads-import:{org}`: a running import finishes first, and none starts until commit. */
  lockImport(tx: DbHandle, organizationId: string): Promise<void>;
  /** The domain lock of each domain, in sorted order. */
  lockDomains(tx: DbHandle, organizationId: string, domains: readonly string[]): Promise<void>;
  /** `leads-columns:{org}:companies`, the field registry lock `updateCompany` takes. */
  lockCompanyFields(tx: DbHandle, organizationId: string): Promise<void>;
  /** The short lock timeout for every wait once the transaction holds a lock (`HELD_LOCK_TIMEOUT`). */
  holdLockTimeout(tx: DbHandle): Promise<void>;
  /** The company that holds `domain` as another domain. */
  aliasOwner(tx: DbHandle, organizationId: string, domain: string): Promise<string | null>;
  /** The company of `domain` `FOR UPDATE`, and whether Companies lists it. */
  companyByDomainForUpdate(tx: DbHandle, organizationId: string, domain: string): Promise<{ id: string; name: string | null; listed: boolean } | null>;
  /** Inserts a listed company; null when another writer holds the domain already. */
  insertListedCompany(tx: DbHandle, organizationId: string, row: { domain: string; name: string | null; linkedinUrl: string | null }): Promise<string | null>;
  /** Stamps `crm_listed_at` and bumps `version`. */
  stampListed(tx: DbHandle, organizationId: string, companyId: string): Promise<void>;
  /** Companies without a lock. */
  read(tx: DbHandle, organizationId: string, companyIds: readonly string[]): Promise<CompanyRow[]>;
  /** The same rows `FOR UPDATE`, in id order. */
  lockCompanies(tx: DbHandle, organizationId: string, companyIds: readonly string[]): Promise<CompanyRow[]>;
  /** The company's other domains, sorted. */
  otherDomains(tx: DbHandle, organizationId: string, companyId: string): Promise<string[]>;
  /** The organization's company fields, archived ones included, in Settings order. */
  companyFields(tx: DbHandle, organizationId: string): Promise<CompanyFieldInfo[]>;
  /** The people of a company `FOR UPDATE`, in id order. */
  lockPeopleOf(tx: DbHandle, organizationId: string, companyId: string): Promise<void>;
  /** Moves every person of `fromId` to `toId`; the number moved. */
  movePeople(tx: DbHandle, organizationId: string, fromId: string, toId: string): Promise<number>;
  /** Writes the merged values on the kept company and bumps `version`. */
  writeMerged(tx: DbHandle, organizationId: string, companyId: string, values: MergedValues): Promise<void>;
  /** Moves the other domains of `fromId` to `toId`. */
  moveOtherDomains(tx: DbHandle, organizationId: string, fromId: string, toId: string): Promise<void>;
  /** Deletes the merged company. */
  deleteMerged(tx: DbHandle, organizationId: string, companyId: string): Promise<void>;
  addOtherDomain(tx: DbHandle, organizationId: string, row: { companyId: string; domain: string; mergedCompanyId: string; mergedName: string | null; createdBy: string | null }): Promise<void>;
  /** The people an earlier merge of `otherId` into `keptId` moved, or null when no such merge happened. */
  mergeReplay(tx: DbHandle, organizationId: string, keptId: string, otherId: string): Promise<number | null>;
  /** Deletes a company with no people; false when someone still points at it. */
  deleteIfEmpty(tx: DbHandle, organizationId: string, companyId: string): Promise<boolean>;
}

export interface CompanyLifecycleDeps {
  companies: CompanyLifecycleStore;
  audit: LeadsAudit;
  /** One transaction with `lock_timeout` set to `CONVERSION_LOCK_TIMEOUT`. */
  transaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T>;
}

/** Counts of other contexts for the merge preview, wired by the composition root. */
export interface CompanyMergeReads {
  /** Deals of the company's contacts (deals). */
  dealCounts(organizationId: string, companyId: string): Promise<{ openDeals: number; deals: number }>;
  /** Leads of the company with a pending or active enrollment in an active campaign (outreach). */
  leadsInRunningCampaigns(organizationId: string, companyId: string): Promise<number>;
}

export interface CompanyMergePreviewDeps extends CompanyLifecycleDeps {
  mergeReads: CompanyMergeReads;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const GONE = "This company no longer exists. It may have merged into another company.";
const gone = (company?: { name: string | null; domain: string }) =>
  new NotFoundError(company ? `${companyLabel(company)} no longer exists. It may have merged into another company.` : GONE);

/** `company_in_use`: a zero part drops. */
export function companyInUseMessage(company: { name: string | null; domain: string }, people: { contacts: number; leads: number }): string {
  const parts = [people.contacts > 0 ? count(people.contacts, "contact", "contacts") : null, people.leads > 0 ? count(people.leads, "lead", "leads") : null].filter(Boolean);
  return `${companyLabel(company)} still has ${parts.join(" and ")}. Merge it into another company, or move those people first.`;
}

// Add company -----------------------------------------------------------------------------------------------------------------

export interface AddCompanyInput {
  domain: string;
  name?: string | null;
  linkedinUrl?: string | null;
}

export interface AddCompanyResult {
  companyId: string;
  listed: true;
  /** True for a new company (201); false when an unlisted company joined Companies (200). */
  created: boolean;
}

/**
 * Adds a company to Companies. A new domain inserts a listed company; a company with leads only gets listed; a listed company or
 * another domain of a company answers 409 `company_exists { companyId, name, domain, viaAlias }`. 422 for a domain that names no
 * company, a long name or a LinkedIn URL that is not a company page.
 */
export async function addCompany(deps: CompanyLifecycleDeps, actor: Actor, input: AddCompanyInput): Promise<AddCompanyResult> {
  const checked = checkCompanyDomain(input.domain ?? "");
  if (checked.issue !== null) throw new ValidationError(checked.issue);
  const domain = checked.domain;
  const edit = planCompanyEdit({ name: input.name ?? null, linkedin: input.linkedinUrl ?? null });
  if (edit.issues.length > 0) throw new ValidationError(edit.issues[0], edit.issues.map((message) => ({ message })));
  const name = edit.patch.name ?? null;
  const linkedinUrl = edit.patch.linkedinUrl ?? null;
  const organizationId = actor.organizationId;
  const store = deps.companies;

  return deps.transaction(async (tx) => {
    await store.lockDomains(tx, organizationId, [domain]);
    const owner = await store.aliasOwner(tx, organizationId, domain);
    if (owner) {
      const [company] = await store.read(tx, organizationId, [owner]);
      if (company) {
        throw new ConflictError(`${domain} is another domain of ${companyLabel(company)}.`, { code: "company_exists", companyId: company.id, name: company.name, domain, viaAlias: true });
      }
    }
    const existing = async () => {
      const row = await store.companyByDomainForUpdate(tx, organizationId, domain);
      if (!row) return null;
      if (row.listed) {
        throw new ConflictError(`${companyLabel({ name: row.name, domain })} already uses ${domain}.`, { code: "company_exists", companyId: row.id, name: row.name, domain, viaAlias: false });
      }
      await store.stampListed(tx, organizationId, row.id);
      return { companyId: row.id, listed: true as const, created: false };
    };
    const found = await existing();
    if (found) return found;
    const companyId = await store.insertListedCompany(tx, organizationId, { domain, name, linkedinUrl });
    if (!companyId) {
      // An import inserted the domain under `leads-import`, not the domain lock, and committed first.
      const late = await existing();
      if (late) return late;
      throw new NotFoundError(GONE);
    }
    await deps.audit.record(tx, { organizationId, actorUserId: actor.userId, action: "company.created", entityType: "company", entityId: companyId, meta: { domain, name } });
    return { companyId, listed: true, created: true };
  });
}

// Merge -----------------------------------------------------------------------------------------------------------------------

export interface MergeSideSummary {
  id: string;
  name: string | null;
  domain: string;
  version: number;
  /** Contacts and leads. */
  people: number;
}

export interface CompanyMergePreview {
  kept: MergeSideSummary;
  other: MergeSideSummary;
  moves: { contacts: number; leads: number; openDeals: number; deals: number; leadsInRunningCampaigns: number };
  fieldConflicts: FieldConflict[];
  filledFields: FilledField[];
  /** The other company's earlier other domains, which move to the kept company too. */
  aliasDomains: string[];
}

export interface MergeExpected {
  keptVersion: number;
  otherVersion: number;
  keptPeople: number;
  otherPeople: number;
}

export interface MergeResult {
  companyId: string;
  moved: { people: number };
}

const summary = (row: CompanyRow): MergeSideSummary => ({ id: row.id, name: row.name, domain: row.domain, version: row.version, people: row.contacts + row.leads });

function checkPair(keptId: string, otherId: string) {
  if (!UUID.test(keptId) || !UUID.test(otherId)) throw new NotFoundError(GONE);
  if (keptId.toLowerCase() === otherId.toLowerCase()) throw new ConflictError("Pick another company to merge.", { code: "same_company" });
}

/** What a merge of `otherId` into `keptId` would do. 404 for a company outside the organization; 409 `same_company`. */
export async function previewCompanyMerge(deps: CompanyMergePreviewDeps, actor: Actor, keptId: string, otherId: string): Promise<CompanyMergePreview> {
  checkPair(keptId, otherId);
  const organizationId = actor.organizationId;
  const store = deps.companies;
  const read = await deps.transaction(async (tx) => {
    const rows = await store.read(tx, organizationId, [keptId, otherId]);
    const kept = rows.find((row) => row.id === keptId);
    const other = rows.find((row) => row.id === otherId);
    // The row that is missing has no name to give, and the one that is left is not the company that is gone.
    if (!kept || !other) throw gone();
    const fields = await store.companyFields(tx, organizationId);
    const aliasDomains = await store.otherDomains(tx, organizationId, otherId);
    return { kept, other, fields, aliasDomains };
  });
  const plan = planCompanyMerge(read.kept, read.other, read.fields);
  const [deals, leadsInRunningCampaigns] = await Promise.all([deps.mergeReads.dealCounts(organizationId, otherId), deps.mergeReads.leadsInRunningCampaigns(organizationId, otherId)]);
  return {
    kept: summary(read.kept),
    other: summary(read.other),
    moves: { contacts: read.other.contacts, leads: read.other.leads, openDeals: deals.openDeals, deals: deals.deals, leadsInRunningCampaigns },
    fieldConflicts: plan.fieldConflicts,
    filledFields: plan.filledFields,
    aliasDomains: read.aliasDomains,
  };
}

function parseExpected(expected: unknown): MergeExpected {
  const value = (expected ?? {}) as Record<string, unknown>;
  const keys = ["keptVersion", "otherVersion", "keptPeople", "otherPeople"] as const;
  for (const key of keys) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new ValidationError("Send the versions and people counts the merge preview showed.");
  }
  return { keptVersion: value.keptVersion as number, otherVersion: value.otherVersion as number, keptPeople: value.keptPeople as number, otherPeople: value.otherPeople as number };
}

/**
 * Merges `otherId` into `keptId` in one transaction, in the order of plan 4.3: replay, `leads-import`, the domain locks, the
 * field registry lock, the other's people, both company rows, then the writes and the audit row. 404 when a company is gone;
 * 409 `same_company`; 409 `company_changed` when a version or a people count differs from the preview; 409 `try_again`.
 */
export async function mergeCompanies(deps: CompanyLifecycleDeps, actor: Actor, keptId: string, otherId: string, input: { expected: unknown }): Promise<MergeResult> {
  checkPair(keptId, otherId);
  const expected = parseExpected(input.expected);
  const organizationId = actor.organizationId;
  const store = deps.companies;
  const replayed = (people: number): MergeResult => ({ companyId: keptId, moved: { people } });

  return retryOnce(() =>
    deps.transaction(async (tx) => {
      const early = await store.mergeReplay(tx, organizationId, keptId, otherId);
      if (early !== null) return replayed(early);

      await store.lockImport(tx, organizationId);
      await store.holdLockTimeout(tx);
      // Domains never change, so a read without a lock gives the lock order.
      const before = await store.read(tx, organizationId, [keptId, otherId]);
      const keptBefore = before.find((row) => row.id === keptId);
      const otherBefore = before.find((row) => row.id === otherId);
      if (!keptBefore || !otherBefore) {
        const late = await store.mergeReplay(tx, organizationId, keptId, otherId);
        if (late !== null) return replayed(late);
        throw gone();
      }
      // The other's earlier other domains move to the kept company, so their writers wait too.
      const otherAliases = await store.otherDomains(tx, organizationId, otherId);
      await store.lockDomains(tx, organizationId, [keptBefore.domain, otherBefore.domain, ...otherAliases]);
      await store.lockCompanyFields(tx, organizationId);
      await store.lockPeopleOf(tx, organizationId, otherId);
      const locked = await store.lockCompanies(tx, organizationId, [keptId, otherId]);
      const kept = locked.find((row) => row.id === keptId);
      const other = locked.find((row) => row.id === otherId);
      if (!kept || !other) {
        const late = await store.mergeReplay(tx, organizationId, keptId, otherId);
        if (late !== null) return replayed(late);
        throw gone(kept ? otherBefore : keptBefore);
      }
      const changed = kept.version !== expected.keptVersion || kept.contacts + kept.leads !== expected.keptPeople ? kept : other.version !== expected.otherVersion || other.contacts + other.leads !== expected.otherPeople ? other : null;
      if (changed) {
        throw new ConflictError(`${companyLabel(changed)} changed while this was open. Check the preview again.`, { code: "company_changed", companyId: changed.id });
      }

      const movedPeople = await store.movePeople(tx, organizationId, otherId, keptId);
      const plan = planCompanyMerge(kept, other, await store.companyFields(tx, organizationId));
      const stamps = [kept.crmListedAt, other.crmListedAt].filter((at): at is Date => at !== null);
      const crmListedAt = stamps.length > 0 ? new Date(Math.min(...stamps.map((at) => at.getTime()))) : new Date();
      await store.writeMerged(tx, organizationId, keptId, { name: plan.name, linkedinUrl: plan.linkedinUrl, custom: plan.custom, raw: plan.raw, crmListedAt });
      await store.moveOtherDomains(tx, organizationId, otherId, keptId);
      // The row goes before its domain becomes an alias: the guard trigger refuses a domain that is still a company domain.
      await store.deleteMerged(tx, organizationId, otherId);
      await store.addOtherDomain(tx, organizationId, { companyId: keptId, domain: other.domain, mergedCompanyId: otherId, mergedName: other.name, createdBy: actor.userId });
      await deps.audit.record(tx, {
        organizationId,
        actorUserId: actor.userId,
        action: "company.merged",
        entityType: "company",
        entityId: keptId,
        meta: {
          otherId,
          otherDomain: other.domain,
          otherName: other.name,
          movedPeople,
          fieldConflicts: plan.fieldConflicts.map((conflict) => ({ key: conflict.key, droppedValue: conflict.other })),
          rawDropped: plan.rawDropped,
          rawOverwritten: plan.rawOverwritten,
        },
      });
      return { companyId: keptId, moved: { people: movedPeople } };
    }),
  );
}

// Delete ----------------------------------------------------------------------------------------------------------------------

/**
 * Deletes a company that no person points at, with its other domains (P5). 404 when it is gone; 409 `company_changed` on a stale
 * `expectedVersion`; 409 `company_in_use { contacts, leads }` while a contact or a lead points at it.
 */
export async function deleteCompany(deps: CompanyLifecycleDeps, actor: Actor, companyId: string, options: { expectedVersion?: number } = {}): Promise<void> {
  if (!UUID.test(companyId)) throw new NotFoundError(GONE);
  const organizationId = actor.organizationId;
  const store = deps.companies;
  await retryOnce(() =>
    deps.transaction(async (tx) => {
      await store.lockImport(tx, organizationId);
      await store.holdLockTimeout(tx);
      const [before] = await store.read(tx, organizationId, [companyId]);
      if (!before) throw gone();
      await store.lockDomains(tx, organizationId, [before.domain, ...(await store.otherDomains(tx, organizationId, companyId))]);
      const [company] = await store.lockCompanies(tx, organizationId, [companyId]);
      if (!company) throw gone(before);
      if (options.expectedVersion !== undefined && company.version !== options.expectedVersion) {
        throw new ConflictError(`${companyLabel(company)} changed while this was open. Check it and delete again.`, { code: "company_changed", companyId });
      }
      if (!(await store.deleteIfEmpty(tx, organizationId, companyId))) {
        const people = { contacts: company.contacts, leads: company.leads };
        throw new ConflictError(companyInUseMessage(company, people), { code: "company_in_use", ...people });
      }
      await deps.audit.record(tx, { organizationId, actorUserId: actor.userId, action: "company.deleted", entityType: "company", entityId: companyId, meta: { domain: company.domain, name: company.name } });
    }),
  );
}
