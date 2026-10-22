import { and, eq, ne, sql } from "drizzle-orm";
import { recordAudit } from "@/platform/db/audit";
import { db } from "@/platform/db/client";
import { integrationAccounts, integrationCredentials } from "@/platform/db/schema";
import type { AiConnectionKey } from "../domain/ai-connections";
import type { AiModelStore } from "../application/ai-model";

export const drizzleAiModelStore: AiModelStore = {
  async listAi(organizationId) {
    const rows = await db
      .select({ accountId: integrationAccounts.id, key: integrationAccounts.key, payload: integrationCredentials.encryptedPayload, config: integrationAccounts.config })
      .from(integrationAccounts)
      .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.kind, "ai"), eq(integrationAccounts.enabled, true)))
      .orderBy(integrationAccounts.createdAt);
    return rows.map((row) => ({
      accountId: row.accountId,
      key: row.key as AiConnectionKey,
      encryptedPayload: row.payload,
      model: typeof row.config?.model === "string" && row.config.model ? row.config.model : null,
      primary: row.config?.primary === true,
    }));
  },

  async saveChoice(organizationId, accountId, model, audit) {
    await db.transaction(async (tx) => {
      const chosen = model === null ? sql`(${integrationAccounts.config} - 'model')` : sql`(${integrationAccounts.config} || ${JSON.stringify({ model })}::jsonb)`;
      const updated = await tx
        .update(integrationAccounts)
        .set({ config: sql`${chosen} || '{"primary": true}'::jsonb`, updatedAt: new Date() })
        .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.id, accountId)))
        .returning({ id: integrationAccounts.id });
      if (updated.length === 0) return;
      // One connection runs AI at a time: the others keep their key and model but lose the mark.
      await tx
        .update(integrationAccounts)
        .set({ config: sql`${integrationAccounts.config} - 'primary'` })
        .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.kind, "ai"), ne(integrationAccounts.id, accountId)));
      await recordAudit(tx, {
        organizationId,
        actorUserId: audit.actorUserId,
        action: "integration.ai_model_changed",
        entityType: "integration_account",
        entityId: accountId,
        meta: { providerKey: audit.to.connection, from: audit.from.model, to: audit.to.model, fromProvider: audit.from.connection },
      });
    });
  },
};
