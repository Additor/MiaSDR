import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { inTransaction, type DbTx } from "@/platform/db/client";
import { companies, importRuns, people } from "@/platform/db/schema";
import type { ImportKeys, ImportPreviewResult, ImportStats, LeadStore } from "../application/import-leads";
import type { ExistingPerson } from "../domain/import-plan";
import { mergeRaw } from "../domain/raw";
import { aliasTargets, stampCompaniesLeftByContacts } from "./company-domain-store";
import { resolvePeopleColumns } from "./resolve-custom-columns";

const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Thrown inside the dry run's transaction to roll it back; carries the result out. */
class DryRunDone extends Error {
  constructor(readonly result: ImportPreviewResult) {
    super("dry run");
  }
}

export const drizzleLeadStore: LeadStore = {
  async previewImport(input) {
    try {
      await inTransaction(undefined, async (tx) => {
        // The same lock and the same column resolution as the import, so a refused archived column fails here too.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"leads-import:" + input.organizationId}, 0))`);
        const resolved = await resolvePeopleColumns(tx, input.organizationId, input.customColumns, { restoreArchived: input.restoreArchivedColumns });
        const keyMap = new Map([...resolved].map(([requested, column]) => [requested, column.key]));
        const existing = await loadExisting(tx, input.organizationId, input.keys);
        const aliases = await aliasTargets(tx, input.organizationId, input.keys.domains ?? []);
        throw new DryRunDone({ plan: input.plan(existing, keyMap, aliases), existing, keyMap });
      });
    } catch (error) {
      // Column resolution may have restored a column inside the transaction. The throw rolled that back.
      if (error instanceof DryRunDone) return error.result;
      throw error;
    }
    throw new Error("unreachable");
  },

  async applyImport(input) {
    return inTransaction(input.tx, async (tx) => {
      // One import per organization at a time, so two uploads cannot race on the same emails.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"leads-import:" + input.organizationId}, 0))`);

      const [run] = await tx
        .insert(importRuns)
        .values({
          organizationId: input.organizationId,
          filename: input.filename,
          mapping: input.mapping,
          createdBy: input.createdBy,
        })
        .returning({ id: importRuns.id });

      const resolved = await resolvePeopleColumns(tx, input.organizationId, input.customColumns, { restoreArchived: input.restoreArchivedColumns });
      const keyMap = new Map([...resolved].map(([requested, column]) => [requested, column.key]));

      const unique = await loadExisting(tx, input.organizationId, input.keys);
      // Other domains resolve to their company before the plan, under `leads-import`, which a merge also takes first.
      const aliases = await aliasTargets(tx, input.organizationId, input.keys.domains ?? []);
      const plan = input.plan(unique, keyMap, aliases);

      // Companies first, so people can point at them.
      const companyIds = new Map<string, string>();
      let companiesCreated = 0;
      for (const part of chunks([...plan.companies])) {
        // Merge in code so the stored object stays within the raw caps; the org-level lock makes read-then-write safe.
        const withRaw = part.filter(([domain]) => plan.companyRaw.has(domain)).map(([domain]) => domain);
        const stored = withRaw.length
          ? await tx
              .select({ domain: companies.domain, raw: companies.raw })
              .from(companies)
              .where(and(eq(companies.organizationId, input.organizationId), inArray(companies.domain, withRaw)))
          : [];
        const storedRaw = new Map(stored.map((row) => [row.domain, row.raw]));
        const mergedRaw = (domain: string) => {
          const incoming = plan.companyRaw.get(domain);
          return incoming ? mergeRaw(storedRaw.get(domain), incoming).raw : null;
        };
        const rows = await tx
          .insert(companies)
          .values(
            part.map(([domain, name]) => ({
              organizationId: input.organizationId,
              domain,
              name,
              linkedinUrl: plan.companyLinkedin.get(domain) ?? null,
              raw: mergedRaw(domain),
              source: `import:${run.id}`,
            })),
          )
          .onConflictDoUpdate({
            target: [companies.organizationId, companies.domain],
            set: {
              name: sql`coalesce(${companies.name}, excluded.name)`,
              // Companies are shared across leads: a page already stored is not replaced by a later file.
              linkedinUrl: sql`coalesce(${companies.linkedinUrl}, excluded.linkedin_url)`,
              raw: sql`coalesce(excluded.raw, ${companies.raw})`,
              version: sql`${companies.version} + 1`,
            },
          })
          .returning({ id: companies.id, domain: companies.domain, inserted: sql<boolean>`(xmax = 0)` });
        for (const row of rows) {
          companyIds.set(row.domain, row.id);
          if (row.inserted) companiesCreated += 1;
        }
      }

      for (const part of chunks(plan.inserts)) {
        await tx.insert(people).values(
          part.map((p) => ({
            organizationId: input.organizationId,
            email: p.email,
            linkedinSlug: p.linkedinSlug,
            linkedinUrl: p.linkedinUrl,
            raw: Object.keys(p.raw).length > 0 ? p.raw : null,
            firstName: p.firstName,
            lastName: p.lastName,
            fullName: p.fullName,
            title: p.title,
            phone: p.phone,
            companyId: p.companyDomain ? (companyIds.get(p.companyDomain) ?? null) : null,
            custom: p.custom,
            source: `import:${run.id}`,
          })),
        );
      }

      const before = new Map(unique.map((p) => [p.id, p]));
      const leftByContacts: string[] = [];
      for (const update of plan.updates) {
        const { custom, companyDomain, raw, ...scalars } = update.patch;
        const held = before.get(update.id);
        if (companyDomain && held?.lifecycle === "contact" && held.companyId && companyIds.get(companyDomain) !== held.companyId) leftByContacts.push(held.companyId);
        await tx
          .update(people)
          .set({
            ...scalars,
            ...(companyDomain ? { companyId: companyIds.get(companyDomain) ?? null } : {}),
            ...(raw ? { raw } : {}),
            ...(custom ? { custom: sql`${people.custom} || ${JSON.stringify(custom)}::jsonb` } : {}),
          })
          .where(and(eq(people.id, update.id), eq(people.organizationId, input.organizationId)));
      }
      // A company whose last contact this file moved away stays in Companies (M3).
      await stampCompaniesLeftByContacts(tx, input.organizationId, leftByContacts);

      const stats: ImportStats = {
        ...input.baseStats,
        created: plan.inserts.length,
        updated: plan.updates.length,
        unchanged: plan.unchanged,
        conflicts: plan.conflicts.length,
        companiesCreated,
      };
      await tx.update(importRuns).set({ stats }).where(eq(importRuns.id, run.id));
      return { runId: run.id, stats, plan };
    });
  },
};

/** The leads of the organization that the file's emails, LinkedIn slugs and member ids point at. */
async function loadExisting(tx: DbTx, organizationId: string, keys: ImportKeys): Promise<ExistingPerson[]> {
  const existing: ExistingPerson[] = [];
  for (const part of chunks(keys.emails, 5000)) {
    existing.push(...(await loadPeople(tx, organizationId, inArray(sql`lower(${people.email})`, part))));
  }
  for (const part of chunks(keys.slugs, 5000)) {
    existing.push(...(await loadPeople(tx, organizationId, inArray(people.linkedinSlug, part))));
  }
  for (const part of chunks(keys.memberIds ?? [], 5000)) {
    existing.push(...(await loadPeople(tx, organizationId, inArray(sql`${people.raw}->>'linkedin_member_id'`, part))));
  }
  return [...new Map(existing.map((p) => [p.id, p])).values()];
}

async function loadPeople(tx: DbTx, organizationId: string, condition: SQL): Promise<ExistingPerson[]> {
  const rows = await tx
    .select({
      id: people.id,
      email: people.email,
      linkedinSlug: people.linkedinSlug,
      linkedinUrl: people.linkedinUrl,
      firstName: people.firstName,
      lastName: people.lastName,
      fullName: people.fullName,
      title: people.title,
      phone: people.phone,
      companyId: people.companyId,
      companyDomain: companies.domain,
      custom: people.custom,
      raw: people.raw,
      lifecycle: people.lifecycle,
    })
    .from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(and(eq(people.organizationId, organizationId), condition));
  return rows;
}
