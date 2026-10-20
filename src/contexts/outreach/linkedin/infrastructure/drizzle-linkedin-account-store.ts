import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { credentialCipher, envelopeVersion } from "@/contexts/integrations/infrastructure/credential-cipher";
import { db } from "@/platform/db/client";
import { channelSettings, drafts, integrationAccounts, integrationCredentials, linkedinAccounts, sendAttempts, sends } from "@/platform/db/schema";
import type { AccountStatusChange, LinkedInAccountStore, LinkedInCredentials, SyncStatus, WebhookStatus } from "../application/linkedin-management";
import { defaultWorkingHours, startOfLocalDay, type WorkingHours } from "../../domain/working-hours";

const PROVIDER_KEY = "unipile";

/** Messages one account sent since the start of the UTC day: sequence messages (step 2 and later) and replies. */
export async function countMessagesToday(account: { id: string; providerAccountId: string }, now: Date, runner: Pick<typeof db, "select"> = db): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const [{ n }] = await runner
    .select({ n: sql<number>`count(*)::int` })
    .from(sends)
    .where(
      and(
        eq(sends.linkedinAccountId, account.id),
        eq(sends.channel, "linkedin"),
        sql`${sends.stepNumber} > 1`,
        inArray(sends.status, ["sending", "sent", "unknown"]),
        sql`${sends.claimedAt} >= ${dayStart}::timestamptz`,
      ),
    );
  const [{ r }] = await runner
    .select({ r: sql<number>`count(*)::int` })
    .from(sendAttempts)
    .innerJoin(drafts, and(eq(drafts.id, sendAttempts.draftId), eq(drafts.organizationId, sendAttempts.organizationId)))
    .where(
      and(
        eq(drafts.channel, "linkedin"),
        inArray(sendAttempts.accountRef, [account.providerAccountId, account.id]),
        inArray(sendAttempts.status, ["sending", "sent", "delivery_uncertain", "reconciled"]),
        sql`${sendAttempts.createdAt} >= ${dayStart}::timestamptz`,
      ),
    );
  return n + r;
}

function parseCredentials(plaintext: string): LinkedInCredentials | null {
  try {
    const value = JSON.parse(plaintext) as Partial<LinkedInCredentials>;
    return typeof value.dsn === "string" && typeof value.apiKey === "string" && typeof value.notifySecret === "string"
      ? { dsn: value.dsn, apiKey: value.apiKey, notifySecret: value.notifySecret }
      : null;
  } catch {
    return null;
  }
}

/** The Unipile connection lives in the shared integration tables, one row per organization, encrypted with INTEGRATION_CREDENTIALS_KEY. */
export const drizzleLinkedInAccountStore: LinkedInAccountStore = {
  async getCredentials(organizationId) {
    const [row] = await db
      .select({ payload: integrationCredentials.encryptedPayload, enabled: integrationAccounts.enabled })
      .from(integrationAccounts)
      .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, PROVIDER_KEY)));
    if (!row || !row.enabled) return null;
    try {
      return parseCredentials(credentialCipher.decrypt(row.payload));
    } catch {
      // A rotated key or damaged blob reads as "not connected" so the page offers a reconnect.
      return null;
    }
  },

  async saveCredentials(organizationId, credentials) {
    const encrypted = credentialCipher.encrypt(JSON.stringify(credentials));
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: integrationAccounts.id })
        .from(integrationAccounts)
        .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, PROVIDER_KEY)))
        .for("update");
      let id = existing?.id;
      if (id) await tx.update(integrationAccounts).set({ enabled: true }).where(eq(integrationAccounts.id, id));
      else [{ id }] = await tx.insert(integrationAccounts).values({ organizationId, kind: "platform", key: PROVIDER_KEY, name: "Unipile (LinkedIn)" }).returning({ id: integrationAccounts.id });
      await tx
        .insert(integrationCredentials)
        .values({ accountId: id, encryptedPayload: encrypted, encryptionVersion: envelopeVersion(encrypted) })
        .onConflictDoUpdate({ target: integrationCredentials.accountId, set: { encryptedPayload: encrypted, encryptionVersion: envelopeVersion(encrypted), updatedAt: new Date() } });
    });
  },

  async getWebhookStatus(organizationId) {
    const [row] = await db
      .select({ config: integrationAccounts.config })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, PROVIDER_KEY)));
    const value = (row?.config as { webhooks?: unknown } | undefined)?.webhooks as Partial<WebhookStatus> | undefined;
    return value && typeof value.at === "string" && Array.isArray(value.hooks) ? { at: value.at, hooks: value.hooks } : null;
  },

  async saveWebhookStatus(organizationId, status) {
    await db
      .update(integrationAccounts)
      .set({ config: sql`${integrationAccounts.config} || jsonb_build_object('webhooks', ${JSON.stringify(status)}::jsonb)` })
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, PROVIDER_KEY)));
  },

  async listCredentialedOrganizations() {
    const rows = await db
      .selectDistinct({ organizationId: integrationAccounts.organizationId })
      .from(integrationAccounts)
      .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
      .where(and(eq(integrationAccounts.key, PROVIDER_KEY), eq(integrationAccounts.enabled, true)));
    return rows.map((row) => row.organizationId);
  },

  async getSyncStatus(organizationId) {
    const [row] = await db
      .select({ config: integrationAccounts.config })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, PROVIDER_KEY)));
    const config = (row?.config ?? {}) as Partial<SyncStatus>;
    return {
      lastSyncAt: typeof config.lastSyncAt === "string" ? config.lastSyncAt : null,
      lastSyncError: typeof config.lastSyncError === "string" ? config.lastSyncError : null,
    };
  },

  async saveSyncStatus(organizationId, patch) {
    if (patch.lastSyncAt === undefined && patch.lastSyncError === undefined) return;
    await db
      .update(integrationAccounts)
      .set({ config: sql`${integrationAccounts.config} || ${JSON.stringify(patch)}::jsonb` })
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, PROVIDER_KEY)));
  },

  async clearCredentials(organizationId) {
    await db.transaction(async (tx) => {
      await tx.delete(integrationAccounts).where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, PROVIDER_KEY)));
      await tx.update(linkedinAccounts).set({ status: "disconnected" }).where(eq(linkedinAccounts.organizationId, organizationId));
    });
  },

  async upsertAccounts(organizationId, accounts) {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const skippedReasons: string[] = [];
    const changes: AccountStatusChange[] = [];
    const skip = (reason: string) => {
      skipped += 1;
      skippedReasons.push(reason);
    };
    for (const account of accounts) {
      const linkedinId = account.linkedinId ?? account.ref;
      const status = account.status;
      try {
        await db.transaction(async (tx) => {
          const [byId] = await tx.select().from(linkedinAccounts).where(eq(linkedinAccounts.linkedinId, linkedinId));
          const [byName] = account.username
            ? await tx.select().from(linkedinAccounts).where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.username, account.username)))
            : [];
          const existing = byId ?? byName;
          if (existing && existing.organizationId !== organizationId) {
            skip(`Account ${account.ref} belongs to another organization.`);
            return;
          }
          // provider_account_id is unique across all organizations, so a clash is settled before the write.
          const [byProvider] = await tx.select({ id: linkedinAccounts.id }).from(linkedinAccounts).where(eq(linkedinAccounts.providerAccountId, account.ref));
          if (byProvider && byProvider.id !== existing?.id) {
            skip(`Account id ${account.ref} is already used by another LinkedIn account.`);
            return;
          }
          const fields = {
            providerAccountId: account.ref,
            linkedinId,
            username: account.username,
            name: account.name,
            status,
            ...(account.headline ? { headline: account.headline } : {}),
            ...(account.isPremium !== null ? { isPremium: account.isPremium } : {}),
          };
          if (existing) {
            await tx.update(linkedinAccounts).set(fields).where(eq(linkedinAccounts.id, existing.id));
            updated += 1;
            // The status was read in this transaction, so the change list matches what the write replaced.
            if (existing.status !== status) changes.push({ ref: account.ref, from: existing.status === "connected" ? "connected" : "disconnected", to: status });
          } else {
            await tx.insert(linkedinAccounts).values({ organizationId, ...fields, dailyInviteLimit: account.isPremium ? 30 : 5 });
            added += 1;
            changes.push({ ref: account.ref, from: null, to: status });
          }
        });
      } catch (error) {
        // A concurrent sync took the same id between the check and the write. The next sync settles it.
        if ((error as { code?: string }).code !== "23505" && (error as { cause?: { code?: string } }).cause?.code !== "23505") throw error;
        skip(`Account ${account.ref} conflicts with an existing account.`);
      }
    }
    return { added, updated, skipped, skippedReasons, changes };
  },

  async list(organizationId, now) {
    const rows = await db.select().from(linkedinAccounts).where(eq(linkedinAccounts.organizationId, organizationId)).orderBy(asc(linkedinAccounts.createdAt));
    // An account without its own hours sends by the organization's time zone, so show and count by that too.
    const [general] = await db
      .select({ values: channelSettings.values })
      .from(channelSettings)
      .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "general")));
    const orgZone = typeof general?.values?.timeZone === "string" ? general.values.timeZone : "UTC";
    return Promise.all(
      rows.map(async (row) => {
        const hours = (row.workingHours as WorkingHours | null) ?? defaultWorkingHours(orgZone);
        const zone = hours.timeZone;
        const [{ n }] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(sends)
          .where(
            and(
              eq(sends.linkedinAccountId, row.id),
              eq(sends.stepNumber, 1),
              eq(sends.channel, "linkedin"),
              inArray(sends.status, ["sending", "sent", "unknown"]),
              sql`${sends.claimedAt} >= ${startOfLocalDay(now, zone).toISOString()}::timestamptz`,
            ),
          );
        // Messages count per UTC day, the way the engine counts them: sequence messages from `sends`, replies from `send_attempts`.
        const messagesToday = await countMessagesToday(row, now);
        return {
          id: row.id,
          providerAccountId: row.providerAccountId,
          linkedinId: row.linkedinId,
          name: row.name,
          username: row.username,
          status: row.status,
          isPremium: row.isPremium,
          dailyInviteLimit: row.dailyInviteLimit,
          dailyMessageLimit: row.dailyMessageLimit,
          // Only a pause that still applies is worth showing.
          limitReachedUntil: row.limitReachedUntil && row.limitReachedUntil.getTime() > now.getTime() ? row.limitReachedUntil : null,
          workingHours: hours,
          invitesToday: n,
          messagesToday,
        };
      }),
    );
  },

  async update(organizationId, id, patch) {
    const set = {
      ...(patch.dailyInviteLimit !== undefined ? { dailyInviteLimit: patch.dailyInviteLimit } : {}),
      ...(patch.dailyMessageLimit !== undefined ? { dailyMessageLimit: patch.dailyMessageLimit } : {}),
      ...(patch.isPremium !== undefined ? { isPremium: patch.isPremium } : {}),
      ...(patch.workingHours !== undefined ? { workingHours: patch.workingHours } : {}),
    };
    const returning = { dailyInviteLimit: linkedinAccounts.dailyInviteLimit, dailyMessageLimit: linkedinAccounts.dailyMessageLimit, isPremium: linkedinAccounts.isPremium };
    const where = and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.id, id));
    // An empty patch changes nothing. Drizzle throws "No values to set" for an empty SET, which would answer 500.
    if (Object.keys(set).length === 0) {
      const [found] = await db.select(returning).from(linkedinAccounts).where(where);
      return found ?? null;
    }
    const [row] = await db.update(linkedinAccounts).set(set).where(where).returning(returning);
    return row ?? null;
  },
};
