import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/platform/db/audit";
import { db } from "@/platform/db/client";
import { integrationAccounts, integrationCredentials } from "@/platform/db/schema";
import type { AiModelStore } from "../application/ai-model";

export const drizzleAiModelStore: AiModelStore = {
  async getAnthropic(organizationId) {
    const [row] = await db
      .select({ accountId: integrationAccounts.id, payload: integrationCredentials.encryptedPayload, config: integrationAccounts.config })
      .from(integrationAccounts)
      .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, "anthropic"), eq(integrationAccounts.enabled, true)));
    if (!row) return null;
    return { accountId: row.accountId, encryptedPayload: row.payload, model: typeof row.config?.model === "string" && row.config.model ? row.config.model : null };
  },

  async saveModel(organizationId, accountId, model, audit) {
    await db.transaction(async (tx) => {
      const config = model === null ? sql`${integrationAccounts.config} - 'model'` : sql`${integrationAccounts.config} || ${JSON.stringify({ model })}::jsonb`;
      const updated = await tx
        .update(integrationAccounts)
        .set({ config, updatedAt: new Date() })
        .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.id, accountId)))
        .returning({ id: integrationAccounts.id });
      if (updated.length === 0) return;
      await recordAudit(tx, {
        organizationId,
        actorUserId: audit.actorUserId,
        action: "integration.ai_model_changed",
        entityType: "integration_account",
        entityId: accountId,
        meta: { providerKey: "anthropic", from: audit.from, to: model },
      });
    });
  },
};
