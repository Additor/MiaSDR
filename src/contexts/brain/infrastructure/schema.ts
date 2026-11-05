import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "@/contexts/identity/infrastructure/schema";
import { createdAt, orgId, pk, updatedAt } from "@/platform/db/columns";
import { inList } from "@/platform/db/sql-values";
import type { BrainFields } from "../domain/brain-fields";
import { BRAIN_KINDS } from "../domain/brain-kinds";

/**
 * Brain: what an organization knows about itself and its market. One row of `knowledge_documents` is one item, and
 * `knowledge_document_versions` holds its text, one row per edit. The tables keep their older name ("Code names" in PRODUCT.md).
 */

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: pk(),
    organizationId: orgId(),
    title: text("title").notNull(),
    description: text("description"),
    kind: text("kind").notNull(),
    tags: text("tags").array().default(sql`'{}'::text[]`).notNull(),
    alwaysInclude: boolean("always_include").notNull().default(false),
    active: boolean("active").notNull().default(true),
    latestVersion: integer("latest_version").notNull().default(1),
    /** Who created the item. Null on a document from before the column, or once that user is gone. */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("knowledge_documents_id_org_uq").on(t.id, t.organizationId),
    check("knowledge_documents_kind_ck", inList(t.kind, BRAIN_KINDS)),
    check("knowledge_documents_version_ck", sql`${t.latestVersion} > 0`),
    check("knowledge_documents_description_ck", sql`${t.description} is null or length(${t.description}) <= 1000`),
    index("knowledge_documents_org_active_idx").on(t.organizationId, t.active, t.kind),
    index("knowledge_documents_created_by_idx").on(t.createdBy).where(sql`${t.createdBy} is not null`),
    // One active company profile per organization. No one item can keep this rule, so the database does.
    uniqueIndex("knowledge_company_profile_uq").on(t.organizationId).where(sql`${t.kind} = 'company_profile' and ${t.active}`),
  ],
);

export const knowledgeDocumentVersions = pgTable(
  "knowledge_document_versions",
  {
    id: pk(),
    organizationId: orgId(),
    documentId: uuid("document_id").notNull(),
    version: integer("version").notNull(),
    /** The rendered text a prompt reads. A draft's stored request names this version, so it stays what the AI saw. */
    content: text("content").notNull(),
    /** The item's fields, keyed as Brain in Withmia keys them. Null on a document from before the kinds existed. */
    structuredData: jsonb("structured_data").$type<BrainFields>(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.documentId, t.organizationId], foreignColumns: [knowledgeDocuments.id, knowledgeDocuments.organizationId] }).onDelete("cascade"),
    unique("knowledge_versions_doc_version_uq").on(t.documentId, t.version),
    unique("knowledge_versions_id_org_uq").on(t.id, t.organizationId),
    check("knowledge_versions_ck", sql`${t.version} > 0 and length(btrim(${t.content})) > 0`),
  ],
);
