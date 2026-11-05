import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, orgId, pk, updatedAt } from "@/platform/db/columns";
import { inList } from "@/platform/db/sql-values";
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
    kind: text("kind").notNull(),
    tags: text("tags").array().default(sql`'{}'::text[]`).notNull(),
    alwaysInclude: boolean("always_include").notNull().default(false),
    active: boolean("active").notNull().default(true),
    latestVersion: integer("latest_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("knowledge_documents_id_org_uq").on(t.id, t.organizationId),
    check("knowledge_documents_kind_ck", inList(t.kind, BRAIN_KINDS)),
    check("knowledge_documents_version_ck", sql`${t.latestVersion} > 0`),
    index("knowledge_documents_org_active_idx").on(t.organizationId, t.active, t.kind),
  ],
);

export const knowledgeDocumentVersions = pgTable(
  "knowledge_document_versions",
  {
    id: pk(),
    organizationId: orgId(),
    documentId: uuid("document_id").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.documentId, t.organizationId], foreignColumns: [knowledgeDocuments.id, knowledgeDocuments.organizationId] }).onDelete("cascade"),
    unique("knowledge_versions_doc_version_uq").on(t.documentId, t.version),
    unique("knowledge_versions_id_org_uq").on(t.id, t.organizationId),
    check("knowledge_versions_ck", sql`${t.version} > 0 and length(btrim(${t.content})) > 0`),
  ],
);
