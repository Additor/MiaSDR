import { and, eq } from "drizzle-orm";
import { deleteProviderAccount, saveProviderCredentialTx } from "@/contexts/integrations/infrastructure/provider-accounts";
import { ConflictError } from "@/shared/errors";
import { db } from "@/platform/db/client";
import { gridProviders, integrationCredentials } from "@/platform/db/schema";
import type { NewProvider, ProviderPatch, ProviderRecord, ProviderStore } from "../application/enrichment-ports";

type Row = typeof gridProviders.$inferSelect;

const toRecord = (row: Row): ProviderRecord => ({
  id: row.id,
  key: row.key,
  name: row.name,
  baseUrl: row.baseUrl,
  defaultCostCents: Number(row.defaultCostCents),
  rateLimitPerMin: row.rateLimitPerMin,
  config: row.config,
  enabled: row.enabled,
  hasCredential: row.accountId !== null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const isUniqueViolation = (error: unknown) => (error as { code?: string; cause?: { code?: string } })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505";

/** The account a provider's key sits under. A provider key cannot hold a colon, so it never meets another account's key. */
const enrichmentAccount = (key: string) => ({ kind: "enrichment", key: `enrichment:${key}`, name: key });

export const drizzleProviderStore: ProviderStore = {
  async list(organizationId) {
    const rows = await db.select().from(gridProviders).where(eq(gridProviders.organizationId, organizationId)).orderBy(gridProviders.key);
    return rows.map(toRecord);
  },

  async get(organizationId, id) {
    const [row] = await db.select().from(gridProviders).where(and(eq(gridProviders.organizationId, organizationId), eq(gridProviders.id, id)));
    return row ? toRecord(row) : null;
  },

  async getByKey(organizationId, key) {
    const [row] = await db.select().from(gridProviders).where(and(eq(gridProviders.organizationId, organizationId), eq(gridProviders.key, key)));
    return row ? toRecord(row) : null;
  },

  async create(organizationId, provider: NewProvider, encryptedCredential) {
    try {
      return await db.transaction(async (tx) => {
        const account = encryptedCredential ? await saveProviderCredentialTx(tx, organizationId, enrichmentAccount(provider.key), encryptedCredential) : null;
        const [row] = await tx
          .insert(gridProviders)
          .values({
            organizationId,
            key: provider.key,
            name: provider.name,
            baseUrl: provider.baseUrl,
            defaultCostCents: String(provider.defaultCostCents),
            rateLimitPerMin: provider.rateLimitPerMin,
            config: provider.config,
            accountId: account?.id ?? null,
          })
          .returning();
        return toRecord(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`A provider with the key "${provider.key}" already exists.`);
      throw error;
    }
  },

  async update(organizationId, id, patch: ProviderPatch, encryptedCredential) {
    return db.transaction(async (tx) => {
      const set: Partial<typeof gridProviders.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
      if (patch.defaultCostCents !== undefined) set.defaultCostCents = String(patch.defaultCostCents);
      if (patch.rateLimitPerMin !== undefined) set.rateLimitPerMin = patch.rateLimitPerMin;
      if (patch.config !== undefined) set.config = patch.config;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      const [row] = await tx.update(gridProviders).set(set).where(and(eq(gridProviders.organizationId, organizationId), eq(gridProviders.id, id))).returning();
      if (!row) return null;
      if (encryptedCredential === undefined) return toRecord(row);
      const account = await saveProviderCredentialTx(tx, organizationId, enrichmentAccount(row.key), encryptedCredential);
      if (row.accountId === account.id) return toRecord(row);
      const [linked] = await tx.update(gridProviders).set({ accountId: account.id }).where(eq(gridProviders.id, id)).returning();
      return toRecord(linked);
    });
  },

  async delete(organizationId, id) {
    return db.transaction(async (tx) => {
      const [row] = await tx.delete(gridProviders).where(and(eq(gridProviders.organizationId, organizationId), eq(gridProviders.id, id))).returning({ key: gridProviders.key, accountId: gridProviders.accountId });
      if (row?.accountId) await deleteProviderAccount(tx, organizationId, enrichmentAccount(row.key).key);
      return Boolean(row);
    });
  },

  async encryptedCredential(organizationId, providerId) {
    const [row] = await db
      .select({ payload: integrationCredentials.encryptedPayload })
      .from(gridProviders)
      .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, gridProviders.accountId))
      .where(and(eq(gridProviders.organizationId, organizationId), eq(gridProviders.id, providerId)));
    return row?.payload ?? null;
  },
};
