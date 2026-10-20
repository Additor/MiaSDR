import { and, eq, sql } from "drizzle-orm";
import { envelopeVersion } from "@/contexts/integrations/infrastructure/credential-cipher";
import { ConflictError } from "@/shared/errors";
import { db } from "@/platform/db/client";
import { gridProviderCredentials, gridProviders } from "@/platform/db/schema";
import type { NewProvider, ProviderPatch, ProviderRecord, ProviderStore } from "../application/enrichment-ports";

type Row = typeof gridProviders.$inferSelect;

const toRecord = (row: Row, hasCredential: boolean): ProviderRecord => ({
  id: row.id,
  key: row.key,
  name: row.name,
  baseUrl: row.baseUrl,
  defaultCostCents: Number(row.defaultCostCents),
  rateLimitPerMin: row.rateLimitPerMin,
  config: row.config,
  enabled: row.enabled,
  hasCredential,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const isUniqueViolation = (error: unknown) => (error as { code?: string; cause?: { code?: string } })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505";

async function hasCredential(organizationId: string, providerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: gridProviderCredentials.providerId })
    .from(gridProviderCredentials)
    .where(and(eq(gridProviderCredentials.organizationId, organizationId), eq(gridProviderCredentials.providerId, providerId)));
  return Boolean(row);
}

export const drizzleProviderStore: ProviderStore = {
  async list(organizationId) {
    const rows = await db
      .select({ provider: gridProviders, credential: gridProviderCredentials.providerId })
      .from(gridProviders)
      .leftJoin(gridProviderCredentials, and(eq(gridProviderCredentials.providerId, gridProviders.id), eq(gridProviderCredentials.organizationId, gridProviders.organizationId)))
      .where(eq(gridProviders.organizationId, organizationId))
      .orderBy(gridProviders.key);
    return rows.map((r) => toRecord(r.provider, r.credential !== null));
  },

  async get(organizationId, id) {
    const [row] = await db.select().from(gridProviders).where(and(eq(gridProviders.organizationId, organizationId), eq(gridProviders.id, id)));
    return row ? toRecord(row, await hasCredential(organizationId, row.id)) : null;
  },

  async getByKey(organizationId, key) {
    const [row] = await db.select().from(gridProviders).where(and(eq(gridProviders.organizationId, organizationId), eq(gridProviders.key, key)));
    return row ? toRecord(row, await hasCredential(organizationId, row.id)) : null;
  },

  async create(organizationId, provider: NewProvider, encryptedCredential) {
    try {
      return await db.transaction(async (tx) => {
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
          })
          .returning();
        if (encryptedCredential) await tx.insert(gridProviderCredentials).values({ providerId: row.id, organizationId, encryptedPayload: encryptedCredential, encryptionVersion: envelopeVersion(encryptedCredential) });
        return toRecord(row, encryptedCredential !== null);
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
      if (encryptedCredential !== undefined) {
        await tx
          .insert(gridProviderCredentials)
          .values({ providerId: id, organizationId, encryptedPayload: encryptedCredential, encryptionVersion: envelopeVersion(encryptedCredential) })
          .onConflictDoUpdate({ target: gridProviderCredentials.providerId, set: { encryptedPayload: encryptedCredential, encryptionVersion: envelopeVersion(encryptedCredential), updatedAt: new Date() }, setWhere: sql`${gridProviderCredentials.organizationId} = ${organizationId}` });
      }
      const [cred] = await tx.select({ id: gridProviderCredentials.providerId }).from(gridProviderCredentials).where(and(eq(gridProviderCredentials.organizationId, organizationId), eq(gridProviderCredentials.providerId, id)));
      return toRecord(row, Boolean(cred));
    });
  },

  async delete(organizationId, id) {
    const rows = await db.delete(gridProviders).where(and(eq(gridProviders.organizationId, organizationId), eq(gridProviders.id, id))).returning({ id: gridProviders.id });
    return rows.length > 0;
  },

  async encryptedCredential(organizationId, providerId) {
    const [row] = await db
      .select({ payload: gridProviderCredentials.encryptedPayload })
      .from(gridProviderCredentials)
      .where(and(eq(gridProviderCredentials.organizationId, organizationId), eq(gridProviderCredentials.providerId, providerId)));
    return row?.payload ?? null;
  },
};
