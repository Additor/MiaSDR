import { and, eq, sql } from "drizzle-orm";
import type { DbHandle, DbTx } from "@/platform/db/client";
import { integrationAccounts, integrationCredentials } from "@/platform/db/schema";
import { envelopeVersion } from "./credential-cipher";

/*
 * The one writer of a provider account and its encrypted credential. Settings, Integrations saves keys through it, and
 * outreach saves the Unipile connection of the LinkedIn page through it, so both get the same upsert, envelope version
 * and config merge.
 */

/**
 * Enables the organization's account for `account.key`, creating it when missing, and stores the encrypted credential.
 * The account row is locked first, so two saves of one provider run one after the other.
 */
export async function saveProviderCredentialTx(
  tx: DbTx,
  organizationId: string,
  account: { kind: string; key: string; name: string },
  encryptedPayload: string,
): Promise<{ id: string; created: boolean }> {
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
  return { id, created: !existing };
}

/** Merges `patch` into the provider account's `config`. Keys the patch does not name stay. */
export async function mergeProviderConfig(handle: DbHandle, organizationId: string, key: string, patch: Record<string, unknown>): Promise<void> {
  await handle
    .update(integrationAccounts)
    .set({ config: sql`${integrationAccounts.config} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, key)));
}

/** Deletes the provider account; its credential goes with it. */
export async function deleteProviderAccount(handle: DbHandle, organizationId: string, key: string): Promise<void> {
  await handle.delete(integrationAccounts).where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, key)));
}
