import { and, asc, count, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { violatedConstraint } from "@/platform/db/errors";
import { knowledgeDocuments, knowledgeDocumentVersions } from "@/platform/db/schema";
import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import { ConflictError } from "@/shared/errors";
import type { BrainItemDetail, BrainItemRow, BrainListFilter, BrainStore } from "../application/brain-items";
import type { BrainItemChange } from "../domain/brain-item";
import type { BrainKind } from "../domain/brain-kinds";
import { SINGLE_ITEM_KIND } from "../domain/brain-kinds";

const COMPANY_PROFILE_INDEX = "knowledge_company_profile_uq";

const rowColumns = {
  id: knowledgeDocuments.id,
  title: knowledgeDocuments.title,
  description: knowledgeDocuments.description,
  kind: sql<BrainKind>`${knowledgeDocuments.kind}`,
  tags: knowledgeDocuments.tags,
  alwaysInclude: knowledgeDocuments.alwaysInclude,
  active: knowledgeDocuments.active,
  version: knowledgeDocuments.latestVersion,
  revision: knowledgeDocuments.revision,
  legacy: sql<boolean>`${knowledgeDocumentVersions.structuredData} is null`,
  updatedAt: knowledgeDocuments.updatedAt,
};

const latestVersion = and(eq(knowledgeDocumentVersions.documentId, knowledgeDocuments.id), eq(knowledgeDocumentVersions.version, knowledgeDocuments.latestVersion));

/** A pattern that matches `q` literally: `%` and `_` in what a person typed mean themselves. */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

/** The one active company profile a unique index allows, said as the conflict a person can act on. */
function asConflict(error: unknown): unknown {
  return violatedConstraint(error, "23505") === COMPANY_PROFILE_INDEX ? new ConflictError("This organization already has a company profile. Edit that one, or archive it first.") : error;
}

/**
 * What an audit row says about an edit: which parts changed, the title's old and new value, and the flag that decides what
 * every prompt reads. The field values stay in the versions.
 */
function changeFacts(change: BrainItemChange, oldTitle: string): Record<string, unknown> {
  const { version, ...onItem } = change;
  const changed = [...Object.keys(onItem), ...(version ? ["fields"] : [])];
  return {
    changed: changed.join(", "),
    ...(change.title === undefined ? {} : { from: oldTitle, to: change.title }),
    ...(change.alwaysInclude === undefined ? {} : { alwaysInclude: change.alwaysInclude }),
  };
}

function filterOf(organizationId: string, filter: BrainListFilter) {
  return and(
    eq(knowledgeDocuments.organizationId, organizationId),
    eq(knowledgeDocuments.active, filter.active),
    filter.kinds ? inArray(knowledgeDocuments.kind, [...filter.kinds]) : undefined,
    filter.legacyOnly ? isNull(knowledgeDocumentVersions.structuredData) : undefined,
    filter.q ? ilike(knowledgeDocuments.title, contains(filter.q)) : undefined,
  );
}

/** The store, writing through `handle`: the shared client, or a caller's transaction so a save and its own row commit together. */
export const brainStoreIn = (handle: DbHandle): BrainStore => ({
  async list(organizationId, filter) {
    const where = filterOf(organizationId, filter);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select(rowColumns)
        .from(knowledgeDocuments)
        .innerJoin(knowledgeDocumentVersions, latestVersion)
        .where(where)
        .orderBy(asc(knowledgeDocuments.title), asc(knowledgeDocuments.id))
        .limit(filter.limit)
        .offset(filter.offset) as Promise<BrainItemRow[]>,
      db.select({ total: count() }).from(knowledgeDocuments).innerJoin(knowledgeDocumentVersions, latestVersion).where(where),
    ]);
    return { rows, total };
  },

  async countLegacy(organizationId, active) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(knowledgeDocuments)
      .innerJoin(knowledgeDocumentVersions, latestVersion)
      .where(and(eq(knowledgeDocuments.organizationId, organizationId), eq(knowledgeDocuments.active, active), isNull(knowledgeDocumentVersions.structuredData)));
    return total;
  },

  async hasActiveCompanyProfile(organizationId) {
    const [row] = await db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.organizationId, organizationId), eq(knowledgeDocuments.kind, SINGLE_ITEM_KIND), eq(knowledgeDocuments.active, true)))
      .limit(1);
    return row !== undefined;
  },

  async findActive(organizationId, kind, title) {
    const sameItem = kind === SINGLE_ITEM_KIND ? undefined : sql`lower(${knowledgeDocuments.title}) = lower(${title})`;
    const [row] = await db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.organizationId, organizationId), eq(knowledgeDocuments.kind, kind), eq(knowledgeDocuments.active, true), sameItem))
      .limit(1);
    return row ?? null;
  },

  async get(organizationId, id) {
    const [row] = await db
      .select({ ...rowColumns, content: knowledgeDocumentVersions.content, structuredData: knowledgeDocumentVersions.structuredData })
      .from(knowledgeDocuments)
      .innerJoin(knowledgeDocumentVersions, latestVersion)
      .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.organizationId, organizationId)));
    return (row as BrainItemDetail | undefined) ?? null;
  },

  async create(organizationId, actorUserId, item) {
    try {
      return await handle.transaction(async (tx) => {
        const [doc] = await tx
          .insert(knowledgeDocuments)
          .values({ organizationId, title: item.title, description: item.description, kind: item.kind, alwaysInclude: item.alwaysInclude, tags: item.tags, createdBy: actorUserId })
          .returning({ id: knowledgeDocuments.id });
        await tx.insert(knowledgeDocumentVersions).values({ organizationId, documentId: doc.id, version: 1, content: item.content, structuredData: item.structuredData });
        await recordAudit(tx, { organizationId, actorUserId, action: "brain.item_created", entityType: "brain_item", entityId: doc.id, meta: { kind: item.kind, title: item.title } });
        return doc;
      });
    } catch (error) {
      throw asConflict(error);
    }
  },

  async update(organizationId, actorUserId, id, decide) {
    try {
      return await handle.transaction(async (tx) => {
        const [doc] = await tx
          .select()
          .from(knowledgeDocuments)
          .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.organizationId, organizationId)))
          .for("update");
        if (!doc) return false;
        const [current] = await tx
          .select({ structuredData: knowledgeDocumentVersions.structuredData })
          .from(knowledgeDocumentVersions)
          .where(and(eq(knowledgeDocumentVersions.documentId, id), eq(knowledgeDocumentVersions.version, doc.latestVersion)));

        const change = decide({
          kind: doc.kind as BrainKind,
          title: doc.title,
          description: doc.description,
          tags: doc.tags,
          alwaysInclude: doc.alwaysInclude,
          active: doc.active,
          revision: doc.revision,
          structuredData: current?.structuredData ?? null,
        });
        if (Object.keys(change).length === 0) return true;
        const version = change.version ? doc.latestVersion + 1 : doc.latestVersion;
        if (change.version) {
          await tx.insert(knowledgeDocumentVersions).values({ organizationId, documentId: id, version, content: change.version.content, structuredData: change.version.structuredData });
        }
        await tx
          .update(knowledgeDocuments)
          .set({
            ...(change.title === undefined ? {} : { title: change.title }),
            ...(change.description === undefined ? {} : { description: change.description }),
            ...(change.kind === undefined ? {} : { kind: change.kind }),
            ...(change.alwaysInclude === undefined ? {} : { alwaysInclude: change.alwaysInclude }),
            ...(change.tags === undefined ? {} : { tags: change.tags }),
            ...(change.active === undefined ? {} : { active: change.active }),
            latestVersion: version,
            revision: doc.revision + 1,
          })
          .where(eq(knowledgeDocuments.id, id));

        const archivedNow = change.active === false && doc.active;
        const restoredNow = change.active === true && !doc.active;
        const action = archivedNow ? "brain.item_archived" : restoredNow ? "brain.item_restored" : "brain.item_updated";
        await recordAudit(tx, { organizationId, actorUserId, action, entityType: "brain_item", entityId: id, meta: { kind: change.kind ?? doc.kind, title: change.title ?? doc.title, version, ...changeFacts(change, doc.title) } });
        return true;
      });
    } catch (error) {
      throw asConflict(error);
    }
  },
});

export const drizzleBrainStore: BrainStore = brainStoreIn(db);
