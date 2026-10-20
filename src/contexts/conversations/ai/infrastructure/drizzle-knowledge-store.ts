import { and, desc, eq } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { knowledgeDocuments, knowledgeDocumentVersions } from "@/platform/db/schema";
import type { KnowledgeStore } from "../application/knowledge";

export const drizzleKnowledgeStore: KnowledgeStore = {
  async list(organizationId) {
    const rows = await db
      .select({
        id: knowledgeDocuments.id,
        title: knowledgeDocuments.title,
        kind: knowledgeDocuments.kind,
        alwaysInclude: knowledgeDocuments.alwaysInclude,
        tags: knowledgeDocuments.tags,
        active: knowledgeDocuments.active,
        version: knowledgeDocuments.latestVersion,
        content: knowledgeDocumentVersions.content,
        updatedAt: knowledgeDocuments.updatedAt,
      })
      .from(knowledgeDocuments)
      .innerJoin(
        knowledgeDocumentVersions,
        and(eq(knowledgeDocumentVersions.documentId, knowledgeDocuments.id), eq(knowledgeDocumentVersions.version, knowledgeDocuments.latestVersion)),
      )
      .where(eq(knowledgeDocuments.organizationId, organizationId))
      .orderBy(desc(knowledgeDocuments.active), knowledgeDocuments.title);
    return rows;
  },

  async create(organizationId, input) {
    return db.transaction(async (tx) => {
      const [doc] = await tx
        .insert(knowledgeDocuments)
        .values({ organizationId, title: input.title, kind: input.kind, alwaysInclude: input.alwaysInclude, tags: input.tags ?? [] })
        .returning({ id: knowledgeDocuments.id });
      await tx.insert(knowledgeDocumentVersions).values({ organizationId, documentId: doc.id, version: 1, content: input.content });
      return doc;
    });
  },

  async update(organizationId, id, input) {
    return db.transaction(async (tx) => {
      const [doc] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.organizationId, organizationId)))
        .for("update");
      if (!doc) return false;
      let version = doc.latestVersion;
      if (input.content !== undefined) {
        const [current] = await tx
          .select({ content: knowledgeDocumentVersions.content })
          .from(knowledgeDocumentVersions)
          .where(and(eq(knowledgeDocumentVersions.documentId, id), eq(knowledgeDocumentVersions.version, doc.latestVersion)));
        if (current?.content !== input.content) {
          version = doc.latestVersion + 1;
          await tx.insert(knowledgeDocumentVersions).values({ organizationId, documentId: id, version, content: input.content });
        }
      }
      await tx
        .update(knowledgeDocuments)
        .set({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.alwaysInclude === undefined ? {} : { alwaysInclude: input.alwaysInclude }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.active === undefined ? {} : { active: input.active }),
          latestVersion: version,
        })
        .where(eq(knowledgeDocuments.id, id));
      return true;
    });
  },
};
