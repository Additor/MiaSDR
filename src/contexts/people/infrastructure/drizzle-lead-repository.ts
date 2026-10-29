import { sqlState, violatedConstraint } from "@/platform/db/errors";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { db, type DbHandle } from "@/platform/db/client";
import {
  campaignEnrollments,
  campaigns,
  companies,
  contactPolicies,
  conversations,
  entityColumns,
  people,
  records,
  sends,
  suppressionList,
} from "@/platform/db/schema";
import { HELD_LOCK_TIMEOUT, lockPeopleOutreachTx, setLockTimeout } from "@/platform/db/person-locks";
import { rowsOf, uuidList } from "@/platform/db/sql-values";
import { TRY_AGAIN } from "@/platform/db/errors";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import { LEAD_DELETE_STATEMENT_TIMEOUT } from "../application/lead-management";
import type { ExportRow, LeadDeleteStore, LeadFilter, LeadForDelete, LeadRepository, SendViewer } from "../application/lead-ports";
import { renameOnCompanyPage } from "../domain/company-domain";
import { customColumnKey } from "../domain/normalize";
import { MAX_CUSTOM_VALUE_LENGTH, type LeadEditPlan } from "../domain/lead-edit";
import { deleteDoNotContactTx, suppressDoNotContactAddressesTx } from "./reachability";
import { DOMAIN_GUARD_CONSTRAINTS, resolveCompanyDomain, stampCompaniesLeftByContacts } from "./company-domain-store";
import { leadFilterWhere, type ActivityCondition } from "./queries";
import { resolvePeopleColumns } from "./resolve-custom-columns";

/*
 * The lead detail reads outreach and conversation tables (campaign_enrollments, sends, records, conversations) through the
 * shared schema barrel. That is a read-only join, kept in this one module so the rest of the people context does not know
 * those tables exist. The lead delete reads and writes only people's tables here; outreach and conversations answer for
 * theirs through the ports `src/composition/person-lifecycle.ts` wires.
 */

const EXPORT_BATCH = 1000;

async function activeColumns(organizationId: string) {
  return db
    .select({ key: entityColumns.key, name: entityColumns.name })
    .from(entityColumns)
    .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, "people"), isNull(entityColumns.archivedAt)))
    .orderBy(asc(entityColumns.position), asc(entityColumns.name));
}

/**
 * A campaign the viewer may read sends of: a regular campaign, their own personal campaign, or any for an owner or admin.
 * Without a viewer, regular campaigns only.
 */
function visibleCampaign(viewer: SendViewer | undefined) {
  if (!viewer) return sql`${campaigns.type} = 'regular'`;
  if (viewer.seesAllPersonal) return sql`true`;
  return sql`(${campaigns.type} = 'regular' or coalesce(${campaigns.createdBy} = ${viewer.userId}, false))`;
}

const displayName = (p: { fullName: string | null; email: string | null }) => p.fullName ?? p.email;

/** The lead repository. The filtered reads (count, matching ids, export) apply `activity` with people's own conditions. */
export const createLeadRepository = (activity: ActivityCondition): LeadRepository => {
  const filterWhere = (organizationId: string, filter: LeadFilter) => leadFilterWhere(organizationId, filter, activity);
  return {
    async get(organizationId, id, viewer) {
      const [person] = await db
        .select({
          id: people.id,
          firstName: people.firstName,
          lastName: people.lastName,
          fullName: people.fullName,
          email: people.email,
          phone: people.phone,
          linkedinSlug: people.linkedinSlug,
          linkedinUrl: people.linkedinUrl,
          title: people.title,
          companyName: companies.name,
          companyDomain: companies.domain,
          custom: people.custom,
          raw: people.raw,
          companyRaw: companies.raw,
          source: people.source,
          lifecycle: people.lifecycle,
          convertedAt: people.convertedAt,
          createdAt: people.createdAt,
          updatedAt: people.updatedAt,
        })
        .from(people)
        .leftJoin(companies, eq(companies.id, people.companyId))
        .where(and(eq(people.organizationId, organizationId), eq(people.id, id)));
      if (!person) return null;

      const [customColumns, [policy], suppression, enrollments, sendRows, [conversation], [hidden]] = await Promise.all([
        activeColumns(organizationId),
        db
          .select({
            doNotContact: contactPolicies.doNotContact,
            reason: contactPolicies.reason,
            source: contactPolicies.source,
            setAt: contactPolicies.setAt,
            clearedAt: contactPolicies.clearedAt,
          })
          .from(contactPolicies)
          .where(and(eq(contactPolicies.organizationId, organizationId), eq(contactPolicies.personId, id))),
        person.email
          ? db
              .select({ reason: suppressionList.reason, note: suppressionList.note, createdAt: suppressionList.createdAt })
              .from(suppressionList)
              .where(and(eq(suppressionList.organizationId, organizationId), eq(suppressionList.email, person.email.toLowerCase())))
          : Promise.resolve([]),
        db
          .select({
            id: campaignEnrollments.id,
            campaignId: campaigns.id,
            campaignName: campaigns.name,
            campaignStatus: campaigns.status,
            channel: campaignEnrollments.channel,
            status: campaignEnrollments.status,
            currentStep: campaignEnrollments.currentStep,
            nextSendAt: campaignEnrollments.nextSendAt,
            lastSentAt: campaignEnrollments.lastSentAt,
            stopReason: campaignEnrollments.stopReason,
          })
          .from(campaignEnrollments)
          .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
          .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.personId, id), eq(campaigns.type, "regular")))
          .orderBy(desc(campaignEnrollments.createdAt)),
        db
          .select({
            id: sends.id,
            campaignId: campaigns.id,
            campaignName: campaigns.name,
            stepNumber: sends.stepNumber,
            channel: sends.channel,
            status: sends.status,
            subject: sends.subject,
            sentAt: sends.sentAt,
            claimedAt: sends.claimedAt,
            error: sends.error,
          })
          .from(sends)
          .innerJoin(campaignEnrollments, and(eq(campaignEnrollments.id, sends.enrollmentId), eq(campaignEnrollments.organizationId, sends.organizationId)))
          .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
          .where(and(eq(sends.organizationId, organizationId), eq(sends.kind, "campaign"), eq(campaignEnrollments.personId, id), visibleCampaign(viewer)))
          .orderBy(desc(sends.claimedAt))
          .limit(100),
        db
          .select({ id: conversations.id })
          .from(conversations)
          .innerJoin(records, and(eq(records.id, conversations.recordId), eq(records.organizationId, conversations.organizationId)))
          .where(and(eq(conversations.organizationId, organizationId), eq(records.personId, id), publicConversation))
          .orderBy(desc(conversations.updatedAt))
          .limit(1),
        db
          .select({ id: sends.id })
          .from(sends)
          .innerJoin(campaignEnrollments, and(eq(campaignEnrollments.id, sends.enrollmentId), eq(campaignEnrollments.organizationId, sends.organizationId)))
          .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
          .where(and(eq(sends.organizationId, organizationId), eq(sends.kind, "campaign"), eq(campaignEnrollments.personId, id), sql`not ${visibleCampaign(viewer)}`))
          .limit(1),
      ]);

      return {
        person,
        customColumns,
        policy: policy ?? null,
        suppression: suppression[0] ?? null,
        enrollments,
        conversationId: conversation?.id ?? null,
        // Campaign sends always carry a step number (sends_kind_shape_ck); test sends are filtered out above.
        sends: sendRows.map((r) => ({ ...r, stepNumber: r.stepNumber as number })),
        hiddenSends: hidden !== undefined,
      };
    },

    async update(organizationId, id, plan, options) {
      const attempted: { email?: string | null; slug?: string | null } = {};
      try {
        await db.transaction(async (tx) => {
          const currentSelect = () =>
            tx
              .select({
                email: people.email,
                linkedinSlug: people.linkedinSlug,
                firstName: people.firstName,
                lastName: people.lastName,
                fullName: people.fullName,
                custom: people.custom,
                companyDomain: companies.domain,
                companyId: people.companyId,
                lifecycle: people.lifecycle,
              })
              .from(people)
              .leftJoin(companies, eq(companies.id, people.companyId))
              .where(and(eq(people.organizationId, organizationId), eq(people.id, id)));

          // Label pass. The labels depend on the input only, so they resolve before the row lock: the registry's
          // advisory lock comes first everywhere (column delete, import), then the people rows.
          const unlocked = await currentSelect();
          if (!unlocked[0]) throw new NotFoundError("Lead not found");
          let early: LeadEditPlan | null = null;
          try {
            early = plan(unlocked[0]);
          } catch {
            // The locked pass below raises the same validation error against the current row.
          }
          const labels = early?.newColumns ?? [];
          const resolved = await resolvePeopleColumns(
            tx,
            organizationId,
            labels.map((c, index) => ({ key: String(index), name: c.name })),
            { restoreArchived: options?.restoreArchived === true },
          );

          // The company, after the registry lock and before the people row lock: the domain lock, then the alias
          // or the company row. An existing company keeps its name; a different name sent with its domain is refused.
          const company = early?.company ? await resolveCompanyDomain(tx, organizationId, early.company.domain, { name: early.company.name }) : null;
          if (company && early?.company && !company.created && early.company.name !== null && early.company.name !== company.name) {
            throw new ValidationError(renameOnCompanyPage({ name: company.name, domain: company.domain }));
          }

          const [current] = await currentSelect().for("update", { of: people });
          if (!current) throw new NotFoundError("Lead not found");

          const edit = plan(current);
          attempted.email = edit.patch.email;
          attempted.slug = edit.patch.linkedinSlug;

          // Value pass. Each new label writes under the stored key it resolved to, next to the explicit `custom` entries.
          const customSet = { ...edit.customSet };
          if (edit.newColumns.length > 0 && edit.newColumns.length !== labels.length) {
            throw new ConflictError("The lead changed while you saved. Try again.");
          }
          // The company resolved before the row lock must be the one this pass names.
          if (edit.company && (!company || edit.company.domain !== early?.company?.domain)) {
            throw new ConflictError("The lead changed while you saved. Try again.");
          }
          edit.newColumns.forEach((column, index) => {
            const stored = resolved.get(String(index));
            if (!stored || column.value === null) return;
            if (stored.key in customSet && customSet[stored.key] !== column.value) {
              throw new ValidationError(`"${column.name}" is the existing field ${stored.name}, which this edit also sets to a different value.`);
            }
            customSet[stored.key] = column.value;
          });

          const companyId: string | null | undefined = edit.company === null ? null : edit.company && company ? company.companyId : undefined;

          const custom = { ...current.custom, ...customSet };
          for (const key of edit.customRemove) delete custom[key];

          await tx
            .update(people)
            .set({ ...edit.patch, ...(companyId !== undefined ? { companyId } : {}), custom, updatedAt: new Date() })
            .where(and(eq(people.organizationId, organizationId), eq(people.id, id)));

          // A contact who leaves a company keeps that company in Companies.
          if (current.lifecycle === "contact" && current.companyId && companyId !== undefined && companyId !== current.companyId) {
            await stampCompaniesLeftByContacts(tx, organizationId, [current.companyId]);
          }
        });
      } catch (error) {
        if (sqlState(error) !== "23505") throw error;
        const constraint = violatedConstraint(error, "23505") ?? undefined;
        if (constraint && DOMAIN_GUARD_CONSTRAINTS.has(constraint)) throw new ConflictError(TRY_AGAIN, { code: "try_again" });
        const field = constraint === "people_org_linkedin_uq" ? "LinkedIn profile" : "email address";
        const patch = await conflictingLead(organizationId, id, constraint, attempted);
        throw new ConflictError(`Another lead${patch ? ` (${patch})` : ""} already uses this ${field}.`);
      }
    },

    async count(organizationId, filter) {
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(people)
        .leftJoin(companies, eq(companies.id, people.companyId))
        .where(filterWhere(organizationId, filter));
      return row.total;
    },

    async matchingIds(organizationId, filter, limit) {
      const rows = await db
        .select({ id: people.id })
        .from(people)
        .leftJoin(companies, eq(companies.id, people.companyId))
        .where(filterWhere(organizationId, filter))
        .orderBy(desc(people.createdAt), desc(people.id))
        .limit(limit);
      return rows.map((r) => r.id);
    },

    customColumns: activeColumns,

    async ensureCustomColumn(organizationId, name, options = {}) {
      const label = name.trim();
      const key = customColumnKey(label);
      if (!key) throw new ValidationError("Give the field a name.");
      const column = await db.transaction(async (tx) => (await resolvePeopleColumns(tx, organizationId, [{ key, name: label }], { restoreArchived: options.restoreArchived === true })).get(key));
      if (!column) throw new ValidationError("Give the field a name.");
      return column;
    },

    async mapRawToCustom(organizationId, { rawKey, customKey, overwrite }) {
      const value = sql`left(btrim(${people.raw} ->> ${rawKey}), ${MAX_CUSTOM_VALUE_LENGTH})`;
      const rows = await db
        .update(people)
        .set({
          custom: sql`${people.custom} || jsonb_build_object(${customKey}::text, ${value})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(people.organizationId, organizationId),
            sql`${people.raw} ? ${rawKey}`,
            sql`${value} <> ''`,
            sql`${people.custom} ->> ${customKey} is distinct from ${value}`,
            overwrite ? undefined : sql`coalesce(btrim(${people.custom} ->> ${customKey}), '') = ''`,
          ),
        )
        .returning({ id: people.id });
      return rows.length;
    },

    async rawKeyStats(organizationId) {
      const result = await db.execute<{ key: string; leads: number }>(sql`
        select k.key as key, count(*)::int as leads
        from ${people}, jsonb_object_keys(${people.raw}) as k(key)
        where ${people.organizationId} = ${organizationId}
        group by k.key
        order by leads desc, k.key asc
        limit 200`);
      return [...result];
    },

    async *exportBatches(organizationId, filter) {
      // Keyset on (created_at, id). The cursor carries created_at as text, because a JS Date drops microseconds.
      let cursor: { createdAt: string; id: string } | null = null;
      for (;;) {
        const after = cursor ? sql`(${people.createdAt}, ${people.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined;
        const rows: Array<ExportRow & { id: string; createdAtText: string }> = await db
          .select({
            id: people.id,
            createdAtText: sql<string>`${people.createdAt}::text`,
            firstName: people.firstName,
            lastName: people.lastName,
            fullName: people.fullName,
            email: people.email,
            phone: people.phone,
            linkedinSlug: people.linkedinSlug,
            linkedinUrl: people.linkedinUrl,
            title: people.title,
            companyName: companies.name,
            companyDomain: companies.domain,
            doNotContact: sql<boolean>`coalesce(${contactPolicies.doNotContact}, false)`,
            lifecycle: people.lifecycle,
            source: people.source,
            createdAt: people.createdAt,
            custom: people.custom,
            raw: people.raw,
          })
          .from(people)
          .leftJoin(companies, eq(companies.id, people.companyId))
          .leftJoin(contactPolicies, and(eq(contactPolicies.personId, people.id), eq(contactPolicies.organizationId, people.organizationId)))
          .where(and(filterWhere(organizationId, filter), after))
          .orderBy(desc(people.createdAt), desc(people.id))
          .limit(EXPORT_BATCH);
        if (rows.length === 0) return;
        yield rows;
        if (rows.length < EXPORT_BATCH) return;
        const last = rows[rows.length - 1];
        cursor = { createdAt: last.createdAtText, id: last.id };
      }
    },
  };
};

/** The people of the organization among `ids`, in id order, `FOR UPDATE` when `lock` is set. */
async function peopleForDelete(tx: DbHandle, organizationId: string, ids: readonly string[], lock: boolean): Promise<LeadForDelete[]> {
  if (ids.length === 0) return [];
  const rows = rowsOf<{ id: string; full_name: string | null; email: string | null; lifecycle: string }>(
    await tx.execute(sql`
      select p.id, p.full_name, p.email, p.lifecycle from people p
      where p.organization_id = ${organizationId} and p.id in ${uuidList(ids)}
      order by p.id ${lock ? sql`for update of p` : sql``}`),
  );
  return rows.map((row) => ({ id: row.id, name: displayName({ fullName: row.full_name, email: row.email }), contact: row.lifecycle === "contact" }));
}

/** The people side of the lead delete ("Delete" in docs/decisions.md). Every statement filters by organization; a delete by filter applies `activity`. */
export const createLeadDeleteStore = (activity: ActivityCondition): LeadDeleteStore => ({
  async idsMatching(organizationId, filter) {
    const rows = await db.select({ id: people.id }).from(people).leftJoin(companies, eq(companies.id, people.companyId)).where(leadFilterWhere(organizationId, filter, activity));
    return rows.map((row) => row.id);
  },
  limitStatements: async (tx) => {
    await tx.execute(sql.raw(`set local statement_timeout = '${LEAD_DELETE_STATEMENT_TIMEOUT}'`));
  },
  read: (tx, organizationId, ids) => peopleForDelete(tx, organizationId, ids, false),
  async lock(tx, organizationId, ids) {
    await lockPeopleOutreachTx(tx, organizationId, ids);
    await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
    return peopleForDelete(tx, organizationId, ids, true);
  },
  keepSuppressed: (tx, organizationId, ids) => suppressDoNotContactAddressesTx(tx, organizationId, ids),
  async deletePeople(tx, organizationId, ids) {
    if (ids.length === 0) return 0;
    await deleteDoNotContactTx(tx, organizationId, ids);
    const removed = await tx.delete(people).where(and(eq(people.organizationId, organizationId), inArray(people.id, [...ids]))).returning({ id: people.id });
    return removed.length;
  },
});

/** Name of the other lead that holds the value this edit tried to take, for the error message. */
async function conflictingLead(organizationId: string, id: string, constraint: string | undefined, attempted: { email?: string | null; slug?: string | null }): Promise<string | null> {
  const byLinkedin = constraint === "people_org_linkedin_uq";
  const match = byLinkedin ? (attempted.slug ? eq(people.linkedinSlug, attempted.slug) : undefined) : attempted.email ? sql`lower(${people.email}) = ${attempted.email.toLowerCase()}` : undefined;
  if (!match) return null;
  const [other] = await db
    .select({ fullName: people.fullName, email: people.email })
    .from(people)
    .where(and(eq(people.organizationId, organizationId), match, sql`${people.id} <> ${id}`));
  return other ? displayName(other) : null;
}
