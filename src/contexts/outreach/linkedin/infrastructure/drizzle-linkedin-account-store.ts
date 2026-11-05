import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import { sqlState } from "@/platform/db/errors";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { credentialCipher } from "@/contexts/integrations/infrastructure/credential-cipher";
import { db, type DbHandle } from "@/platform/db/client";
import { drafts, integrationAccounts, integrationCredentials, linkedinAccounts, sendAttempts, sends } from "@/platform/db/schema";
import type { AccountStatusChange, LinkedInAccountStore, LinkedInCredentials, SyncStatus, WebhookStatus } from "../application/linkedin-management";
import type { GatewayAccount } from "../application/linkedin-ports";
import { normalizePublicSlug } from "../domain/linkedin-identity";
import { defaultWorkingHours, startOfLocalDay, type WorkingHours } from "../../domain/working-hours";
import { deleteProviderAccount, mergeProviderConfig, saveProviderCredentialTx } from "@/contexts/integrations/infrastructure/provider-accounts";
import { SEND_COUNTED } from "../../domain/send-status";
import { credentialFieldsOf, inviteLimitCapOf, VENDOR_KEYS, VENDORS_READ_BY_POLL } from "./linkedin-vendor-facts";

const vendorRow = (organizationId: string) => and(eq(integrationAccounts.organizationId, organizationId), inArray(integrationAccounts.key, VENDOR_KEYS));

/** The one vendor row of an organization, enabled or not. */
async function connectedKey(runner: Pick<typeof db, "select">, organizationId: string): Promise<string | null> {
  const [row] = await runner.select({ key: integrationAccounts.key }).from(integrationAccounts).where(vendorRow(organizationId));
  return row?.key ?? null;
}

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
        inArray(sends.status, SEND_COUNTED),
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
        // ATTEMPT_COUNTED of conversations' send-attempt-status: outreach sits below conversations and cannot import it.
        inArray(sendAttempts.status, ["sending", "sent", "delivery_uncertain", "reconciled"]),
        sql`${sendAttempts.createdAt} >= ${dayStart}::timestamptz`,
      ),
    );
  return n + r;
}

function parseCredentials(key: string, plaintext: string): LinkedInCredentials | null {
  try {
    const value = JSON.parse(plaintext) as Record<string, unknown>;
    if (typeof value.notifySecret !== "string" || !credentialFieldsOf(key).every((field) => typeof value[field] === "string")) return null;
    return value as LinkedInCredentials;
  } catch {
    return null;
  }
}

/** What a listing means for an account's status. See `updateAccountStatuses`. */
function listedStatus(listed: GatewayAccount, row: { status: string; username: string | null }): string {
  if (listed.status !== "connected") return "disconnected";
  if (!listed.username || !row.username) return row.status;
  return normalizePublicSlug(listed.username) === normalizePublicSlug(row.username) ? "connected" : "disconnected";
}

/** The vendor connection lives in the shared integration tables, one row per organization, encrypted with INTEGRATION_CREDENTIALS_KEY. */
export const drizzleLinkedInAccountStore: LinkedInAccountStore = {
  async getCredentials(organizationId) {
    const [row] = await db
      .select({ key: integrationAccounts.key, payload: integrationCredentials.encryptedPayload, enabled: integrationAccounts.enabled })
      .from(integrationAccounts)
      .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
      .where(vendorRow(organizationId));
    if (!row || !row.enabled) return null;
    try {
      return parseCredentials(row.key, credentialCipher.decrypt(row.payload));
    } catch {
      // A rotated key or damaged blob reads as "not connected" so the page offers a reconnect.
      return null;
    }
  },

  async saveCredentials(organizationId, credentials, vendor) {
    const encrypted = credentialCipher.encrypt(JSON.stringify(credentials));
    await db.transaction((tx) => saveProviderCredentialTx(tx, organizationId, { kind: "platform", key: vendor.key, name: vendor.integrationName }, encrypted));
  },

  connectedVendor: (organizationId) => connectedKey(db, organizationId),

  async timeZone(organizationId) {
    const zone = await organizationTimeZone(organizationId);
    return zone === "UTC" ? null : zone;
  },

  async accountRefs(organizationId, vendorKey) {
    const rows = await db
      .select({ ref: linkedinAccounts.providerAccountId })
      .from(linkedinAccounts)
      .where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.provider, vendorKey)));
    return rows.map((row) => row.ref);
  },

  async updateAccountStatuses(organizationId, vendorKey, accounts) {
    const changes: AccountStatusChange[] = [];
    let updated = 0;
    for (const account of accounts) {
      const [row] = await db
        .select({ id: linkedinAccounts.id, status: linkedinAccounts.status, username: linkedinAccounts.username })
        .from(linkedinAccounts)
        .where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.provider, vendorKey), eq(linkedinAccounts.providerAccountId, account.ref)));
      if (!row) continue;
      updated += 1;
      const status = listedStatus(account, row);
      if (row.status === status) continue;
      await db.update(linkedinAccounts).set({ status }).where(eq(linkedinAccounts.id, row.id));
      changes.push({ ref: account.ref, from: row.status === "connected" ? "connected" : "disconnected", to: status === "connected" ? "connected" : "disconnected" });
    }
    return { added: 0, updated, skipped: 0, skippedReasons: [], changes };
  },

  async getWebhookStatus(organizationId) {
    const [row] = await db
      .select({ config: integrationAccounts.config })
      .from(integrationAccounts)
      .where(vendorRow(organizationId));
    const value = (row?.config as { webhooks?: unknown } | undefined)?.webhooks as Partial<WebhookStatus> | undefined;
    return value && typeof value.at === "string" && Array.isArray(value.hooks) ? { at: value.at, hooks: value.hooks } : null;
  },

  async saveWebhookStatus(organizationId, status) {
    const key = await connectedKey(db, organizationId);
    if (key) await mergeProviderConfig(db, organizationId, key, { webhooks: status });
  },

  async listCredentialedOrganizations() {
    const rows = await db
      .selectDistinct({ organizationId: integrationAccounts.organizationId })
      .from(integrationAccounts)
      .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
      .where(and(inArray(integrationAccounts.key, VENDOR_KEYS), eq(integrationAccounts.enabled, true)));
    return rows.map((row) => row.organizationId);
  },

  async getSyncStatus(organizationId) {
    const [row] = await db
      .select({ config: integrationAccounts.config })
      .from(integrationAccounts)
      .where(vendorRow(organizationId));
    const config = (row?.config ?? {}) as Partial<SyncStatus>;
    return {
      lastSyncAt: typeof config.lastSyncAt === "string" ? config.lastSyncAt : null,
      lastSyncError: typeof config.lastSyncError === "string" ? config.lastSyncError : null,
    };
  },

  async saveSyncStatus(organizationId, patch) {
    if (patch.lastSyncAt === undefined && patch.lastSyncError === undefined) return;
    const key = await connectedKey(db, organizationId);
    if (key) await mergeProviderConfig(db, organizationId, key, patch);
  },

  async clearCredentials(organizationId) {
    await db.transaction(async (tx) => {
      const key = await connectedKey(tx, organizationId);
      if (key) await deleteProviderAccount(tx, organizationId, key);
      await tx.update(linkedinAccounts).set({ status: "disconnected" }).where(and(eq(linkedinAccounts.organizationId, organizationId), key ? eq(linkedinAccounts.provider, key) : undefined));
    });
  },

  async upsertAccounts(organizationId, accounts, vendorKey) {
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
          if (existing && existing.provider !== vendorKey) {
            skip(`Account ${account.username ?? account.ref} is connected through another LinkedIn provider. Moving a profile between providers is not supported.`);
            return;
          }
          // provider_account_id is unique across all organizations, so a clash is settled before the write.
          const [byProvider] = await tx.select({ id: linkedinAccounts.id }).from(linkedinAccounts).where(eq(linkedinAccounts.providerAccountId, account.ref));
          if (byProvider && byProvider.id !== existing?.id) {
            skip(`Account id ${account.ref} is already used by another LinkedIn account.`);
            return;
          }
          // A late or replayed delivery still names the id this account had, so the old id stays resolvable.
          const formerIds = existing && existing.providerAccountId !== account.ref ? [...existing.formerProviderAccountIds.filter((id) => id !== account.ref), existing.providerAccountId] : (existing?.formerProviderAccountIds ?? []);
          const fields = {
            formerProviderAccountIds: formerIds,
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
            await tx.insert(linkedinAccounts).values({ organizationId, provider: vendorKey, ...fields, dailyInviteLimit: Math.min(account.isPremium ? 30 : 5, inviteLimitCapOf(vendorKey)) });
            added += 1;
            changes.push({ ref: account.ref, from: null, to: status });
          }
        });
      } catch (error) {
        // A concurrent sync took the same id between the check and the write. The next sync settles it.
        if (sqlState(error) !== "23505") throw error;
        skip(`Account ${account.ref} conflicts with an existing account.`);
      }
    }
    return { added, updated, skipped, skippedReasons, changes };
  },

  async list(organizationId, now) {
    const rows = await db.select().from(linkedinAccounts).where(eq(linkedinAccounts.organizationId, organizationId)).orderBy(asc(linkedinAccounts.createdAt));
    // An account without its own hours sends by the organization's time zone, so show and count by that too.
    const orgZone = await organizationTimeZone(organizationId);
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
              inArray(sends.status, SEND_COUNTED),
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
          inboundReadAt: row.inboundReadAt,
          inboxReadByPoll: VENDORS_READ_BY_POLL.includes(row.provider),
          isPremium: row.isPremium,
          dailyInviteLimit: row.dailyInviteLimit,
          dailyMessageLimit: row.dailyMessageLimit,
          // Only a pause that still applies is worth showing.
          limitReachedUntil: row.limitReachedUntil && row.limitReachedUntil.getTime() > now.getTime() ? row.limitReachedUntil : null,
          workingHours: hours,
          invitesToday: n,
          messagesToday,
          ownerUserId: row.ownerUserId,
        };
      }),
    );
  },

  async update(organizationId, id, patch, audit) {
    const set = {
      ...(patch.dailyInviteLimit !== undefined ? { dailyInviteLimit: patch.dailyInviteLimit } : {}),
      ...(patch.dailyMessageLimit !== undefined ? { dailyMessageLimit: patch.dailyMessageLimit } : {}),
      ...(patch.isPremium !== undefined ? { isPremium: patch.isPremium } : {}),
      ...(patch.workingHours !== undefined ? { workingHours: patch.workingHours } : {}),
      ...(patch.ownerUserId !== undefined ? { ownerUserId: patch.ownerUserId } : {}),
    };
    const returning = { dailyInviteLimit: linkedinAccounts.dailyInviteLimit, dailyMessageLimit: linkedinAccounts.dailyMessageLimit, isPremium: linkedinAccounts.isPremium };
    const where = and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.id, id));
    // An empty patch changes nothing. Drizzle throws "No values to set" for an empty SET, which would answer 500.
    if (Object.keys(set).length === 0) {
      const [found] = await db.select(returning).from(linkedinAccounts).where(where);
      return found ?? null;
    }
    return db.transaction(async (tx) => {
      const [row] = await tx.update(linkedinAccounts).set(set).where(where).returning(returning);
      if (!row) return null;
      for (const entry of audit(row)) await recordAudit(tx, entry);
      return row;
    });
  },
};

/** The vendor an account runs on, or null when the organization has no such account. */
export async function accountVendorOf(organizationId: string, accountId: string): Promise<string | null> {
  const [row] = await db.select({ provider: linkedinAccounts.provider }).from(linkedinAccounts).where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.id, accountId)));
  return row?.provider ?? null;
}

/** Clears the owner of every account the member owned in the organization. */
export async function clearLinkedInOwner(tx: DbHandle, organizationId: string, userId: string): Promise<void> {
  await tx.update(linkedinAccounts).set({ ownerUserId: null }).where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.ownerUserId, userId)));
}
