import { and, asc, eq } from "drizzle-orm";
import { recordAudit } from "@/platform/db/audit";
import { db } from "@/platform/db/client";
import { integrationAccounts, integrationCredentials } from "@/platform/db/schema";
import type { IntegrationStore } from "../application/integration-management";
import { envelopeVersion } from "./credential-cipher";

export const drizzleIntegrationStore: IntegrationStore = {
  async list(organizationId) {
    const rows = await db
      .select({
        id: integrationAccounts.id,
        kind: integrationAccounts.kind,
        key: integrationAccounts.key,
        name: integrationAccounts.name,
        enabled: integrationAccounts.enabled,
        updatedAt: integrationAccounts.updatedAt,
        credentialId: integrationCredentials.accountId,
        credentialUpdatedAt: integrationCredentials.updatedAt,
        config: integrationAccounts.config,
      })
      .from(integrationAccounts)
      .leftJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
      .where(eq(integrationAccounts.organizationId, organizationId))
      .orderBy(asc(integrationAccounts.name));
    return rows.map(({ credentialId, config, ...row }) => ({ ...row, hasCredential: credentialId !== null, primary: config?.primary === true, model: typeof config?.model === "string" && config.model ? config.model : null }));
  },

  async get(organizationId, id) {
    const [row] = await db
      .select({ id: integrationAccounts.id, key: integrationAccounts.key })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.id, id)));
    return row ?? null;
  },

  async saveCredential(organizationId, account, encryptedPayload, audit) {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: integrationAccounts.id })
        .from(integrationAccounts)
        .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, account.key)))
        .for("update");
      const now = new Date();
      let id = existing?.id;
      if (id) {
        await tx.update(integrationAccounts).set({ enabled: true, updatedAt: now }).where(eq(integrationAccounts.id, id));
      } else {
        [{ id }] = await tx.insert(integrationAccounts).values({ organizationId, ...account }).returning({ id: integrationAccounts.id });
      }
      await tx
        .insert(integrationCredentials)
        .values({ accountId: id, encryptedPayload, encryptionVersion: envelopeVersion(encryptedPayload) })
        .onConflictDoUpdate({ target: integrationCredentials.accountId, set: { encryptedPayload, encryptionVersion: envelopeVersion(encryptedPayload), updatedAt: now } });
      await recordAudit(tx, {
        organizationId,
        actorUserId: audit.actorUserId,
        action: "integration.saved",
        entityType: "integration_account",
        entityId: id,
        meta: { providerKey: account.key, change: existing ? "rotated" : "created", verified: audit.verified },
      });
      return { id, created: !existing };
    });
  },

  async delete(organizationId, account, audit) {
    await db.transaction(async (tx) => {
      const removed = await tx
        .delete(integrationAccounts)
        .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.id, account.id)))
        .returning({ id: integrationAccounts.id });
      if (removed.length === 0) return;
      await recordAudit(tx, {
        organizationId,
        actorUserId: audit.actorUserId,
        action: "integration.deleted",
        entityType: "integration_account",
        entityId: account.id,
        meta: { providerKey: account.key },
      });
    });
  },
};
