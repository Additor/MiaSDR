import { isLocalOrigin } from "@/shared/local-origin";
import type { MemberDirectory } from "@/contexts/tenancy/application/member-directory";
import { randomBytes } from "node:crypto";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { DEFAULT_LINKEDIN_RULES } from "../domain/linkedin";
import { INVITE_LIMIT_RULE, MESSAGE_LIMIT_RULE, limitProblem, limitWarnings } from "../domain/linkedin-limits";
import { canonicalTimeZone } from "@/shared/time-zone";
import { type WorkingHours } from "../../domain/working-hours";
import type { GatewayAccount, LinkedInGateway, LinkedInVendor, VendorCredentials } from "./linkedin-ports";
import type { LinkedInConnectStore } from "./linkedin-connect-ports";

import type { AuditEntry, AuditSink } from "@/contexts/tenancy/application/audit-log";
export type { AuditSink };

/** The last webhook registration, kept on the integration row. It never holds the secret. */
export interface WebhookStatus {
  /** ISO 8601 time of the attempt. */
  at: string;
  /** Empty when the attempt was skipped (local APP_URL). */
  hooks: Array<{ name: string; status: "registered" | "failed"; error?: string }>;
}

/** The last account sync, kept on the integration row next to the webhook status. */
export interface SyncStatus {
  /** ISO 8601 time of the last successful sync, or null when none ran yet. */
  lastSyncAt: string | null;
  /** Fixed text of the last failure, or null when the last sync succeeded. */
  lastSyncError: string | null;
}

export interface AccountStatusChange {
  ref: string;
  /** Null for an account that did not exist before. */
  from: "connected" | "disconnected" | null;
  to: "connected" | "disconnected";
}

/** Vendor fields stored as given, plus the shared secret the vendor sends on every webhook. Generated on first save. */
export type LinkedInCredentials = VendorCredentials & { notifySecret: string };

export interface LinkedInAccountRecord {
  id: string;
  providerAccountId: string;
  linkedinId: string;
  name: string | null;
  username: string | null;
  status: string;
  isPremium: boolean;
  dailyInviteLimit: number;
  dailyMessageLimit: number;
  limitReachedUntil: Date | null;
  workingHours: WorkingHours | null;
  invitesToday: number;
  messagesToday: number;
  /** The member whose LinkedIn this is, or null when nobody is set. */
  ownerUserId: string | null;
}

export interface LinkedInAccountStore {
  getCredentials(organizationId: string): Promise<LinkedInCredentials | null>;
  saveCredentials(organizationId: string, credentials: LinkedInCredentials): Promise<void>;
  /** The last stored registration result, or null when none was recorded. */
  getWebhookStatus(organizationId: string): Promise<WebhookStatus | null>;
  /** Replaces the stored registration result. A no-op when the organization has no connection row. */
  saveWebhookStatus(organizationId: string, status: WebhookStatus): Promise<void>;
  /** Removes the credentials and marks every account disconnected. */
  clearCredentials(organizationId: string): Promise<void>;
  /** Matches by LinkedIn id, then by username (a reconnect brings a new provider id). An account whose provider account id is already taken by another organization or another LinkedIn account is skipped with a reason and the rest still sync. Returns how many rows changed. */
  upsertAccounts(
    organizationId: string,
    accounts: Array<GatewayAccount & { isPremium: boolean | null; headline: string | null }>,
  ): Promise<{ added: number; updated: number; skipped: number; skippedReasons: string[]; changes: AccountStatusChange[] }>;
  /** Organizations whose LinkedIn integration is enabled and has a credential row. Decrypting is left to `getCredentials`. */
  listCredentialedOrganizations(): Promise<string[]>;
  /** The last stored sync result. Both fields are null when no sync was recorded. */
  getSyncStatus(organizationId: string): Promise<SyncStatus>;
  /** Merges the given fields into the stored sync result. A no-op when the organization has no connection row. */
  saveSyncStatus(organizationId: string, patch: Partial<SyncStatus>): Promise<void>;
  list(organizationId: string, now: Date): Promise<LinkedInAccountRecord[]>;
  /** Returns the stored limits after the change, or null when the account is not in this organization. */
  update(
    organizationId: string,
    id: string,
    patch: { dailyInviteLimit?: number; dailyMessageLimit?: number; isPremium?: boolean; workingHours?: WorkingHours | null; ownerUserId?: string | null },
    /** The audit rows for the stored values, written in the update's transaction. */
    audit: (stored: { dailyInviteLimit: number; dailyMessageLimit: number; isPremium: boolean }) => AuditEntry[],
  ): Promise<{ dailyInviteLimit: number; dailyMessageLimit: number; isPremium: boolean } | null>;
}

export interface LinkedInManagementDeps {
  accounts: LinkedInAccountStore;
  vendor: LinkedInVendor;
  appUrl: string;
  now: () => Date;
  audit: AuditSink;
  connectLinks: LinkedInConnectStore;
  /** Checks that an account's owner is a member. Setting an owner needs it. */
  members?: Pick<MemberDirectory, "isMember">;
}

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can manage LinkedIn.");
}

const webhookRequestUrl = (deps: LinkedInManagementDeps, organizationId: string) => deps.vendor.webhooks.requestUrl(deps.appUrl, organizationId);

/**
 * The accounts with their status, limits and use today, for an owner or admin. Members only see that LinkedIn is
 * connected, as on the settings page. Reads no credentials, webhooks or connect links.
 */
export async function listLinkedInAccountStatus(deps: LinkedInManagementDeps, actor: Actor): Promise<LinkedInAccountRecord[]> {
  requireAdmin(actor);
  return deps.accounts.list(actor.organizationId, deps.now());
}

export async function listLinkedInAccounts(deps: LinkedInManagementDeps, actor: Actor) {
  requireAdmin(actor);
  const now = deps.now();
  const [credentials, webhooks, sync, accounts, links] = await Promise.all([
    deps.accounts.getCredentials(actor.organizationId),
    deps.accounts.getWebhookStatus(actor.organizationId),
    deps.accounts.getSyncStatus(actor.organizationId),
    deps.accounts.list(actor.organizationId, now),
    deps.connectLinks.listRecent(actor.organizationId, 5, now),
  ]);
  return {
    connected: credentials !== null,
    ...deps.vendor.describe(credentials),
    webhooks,
    sync,
    accounts: accounts.map((account) => ({ ...account, warnings: limitWarnings(account) })),
    links,
    limits: { invites: INVITE_LIMIT_RULE, messages: MESSAGE_LIMIT_RULE },
    defaults: { invitesPerDayPremium: DEFAULT_LINKEDIN_RULES.invitesPerDayPremium, invitesPerDayFree: DEFAULT_LINKEDIN_RULES.invitesPerDayFree },
    webhookUrl: webhookRequestUrl(deps, actor.organizationId),
  };
}

export async function syncWith(deps: LinkedInManagementDeps, organizationId: string, gateway: LinkedInGateway) {
  const listed = await gateway.listAccounts();
  const enriched = await Promise.all(
    listed.map(async (account) => {
      if (account.status !== "connected") return { ...account, isPremium: null, headline: null };
      try {
        const own = await gateway.getOwnProfile(account.ref);
        return { ...account, isPremium: own.isPremium, headline: own.headline };
      } catch {
        return { ...account, isPremium: null, headline: null };
      }
    }),
  );
  return { found: listed.length, ...(await deps.accounts.upsertAccounts(organizationId, enriched)) };
}

/** The fixed text stored and shown after a failed sync. The upstream error text never reaches the page. */
export function syncErrorText(vendor: LinkedInVendor, error: unknown): string {
  if (error instanceof ConflictError) return error.message;
  return vendor.explainSyncFailure(error);
}

/** `syncWith`, then the result goes on the integration row. A failed sync keeps `lastSyncAt` and rethrows the original error. */
export async function syncAndRecord(deps: LinkedInManagementDeps, organizationId: string, gateway: LinkedInGateway | (() => LinkedInGateway)) {
  let result: Awaited<ReturnType<typeof syncWith>>;
  try {
    // A factory runs inside the try, so a DSN the policy rejects is recorded like any other failure.
    result = await syncWith(deps, organizationId, typeof gateway === "function" ? gateway() : gateway);
  } catch (error) {
    try {
      await deps.accounts.saveSyncStatus(organizationId, { lastSyncError: syncErrorText(deps.vendor, error) });
    } catch (saveError) {
      console.error(`LinkedIn sync: could not save the failure for organization ${organizationId}: ${saveError instanceof Error ? saveError.name : "unknown error"}`);
    }
    throw error;
  }
  await deps.accounts.saveSyncStatus(organizationId, { lastSyncAt: deps.now().toISOString(), lastSyncError: null });
  return result;
}

export interface ConnectResult {
  accounts: number;
  added: number;
  webhooks: { status: "registered" | "skipped" | "failed"; detail: string };
}

/** Verifies the vendor credentials, saves them encrypted, pulls the LinkedIn accounts and registers webhooks. */
export async function connectLinkedIn(deps: LinkedInManagementDeps, actor: Actor, input: Record<string, string>): Promise<ConnectResult> {
  requireAdmin(actor);
  const entered = deps.vendor.readConnectInput(input);
  const gateway = deps.vendor.gatewayFor(entered);
  try {
    await gateway.verify();
  } catch (error) {
    throw new ValidationError(deps.vendor.explain(error));
  }
  const existing = await deps.accounts.getCredentials(actor.organizationId);
  const credentials: LinkedInCredentials = { ...entered, notifySecret: existing?.notifySecret ?? randomBytes(24).toString("base64url") };
  await deps.accounts.saveCredentials(actor.organizationId, credentials);

  const synced = await syncAndRecord(deps, actor.organizationId, gateway);
  return { accounts: synced.found, added: synced.added, webhooks: await registerWebhooks(deps, actor.organizationId, gateway, credentials) };
}

async function registerWebhooks(deps: LinkedInManagementDeps, organizationId: string, gateway: LinkedInGateway, credentials: LinkedInCredentials): Promise<ConnectResult["webhooks"]> {
  // A failed save must not hide what the provider answered, and must not run the catch path below.
  const persist = async (hooks: WebhookStatus["hooks"]) => {
    try {
      await deps.accounts.saveWebhookStatus(organizationId, { at: deps.now().toISOString(), hooks });
    } catch (error) {
      console.error(`LinkedIn webhooks: could not save the registration status for organization ${organizationId}: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  };
  if (isLocalOrigin(deps.appUrl)) {
    await persist([]);
    return { status: "skipped", detail: `APP_URL is a local or private address, so ${deps.vendor.name} cannot reach it. Replies and acceptances are not delivered until the app has a public HTTPS URL.` };
  }
  try {
    const { registered, hooks } = await gateway.registerWebhooks({ requestUrl: webhookRequestUrl(deps, organizationId), secret: credentials.notifySecret, name: "MiaSDR" });
    await persist(hooks.map((h) => (h.error === null ? { name: h.name, status: "registered" as const } : { name: h.name, status: "failed" as const, error: deps.vendor.explain(h.error) })));
    const failed = hooks.filter((h) => h.error !== null);
    if (failed.length) {
      // The status stays failed. The text names the hooks that exist so nobody re-registers a working one.
      const detail = registered.length ? `Registered: ${registered.join(", ")}. Failed: ${failed.map((h) => h.name).join(", ")} - ${deps.vendor.explain(failed[0].error)}` : deps.vendor.explain(failed[0].error);
      return { status: "failed", detail };
    }
    return { status: "registered", detail: registered.length ? `Registered: ${registered.join(", ")}.` : "Already registered." };
  } catch (error) {
    await persist(deps.vendor.webhooks.hooks.map(({ name }) => ({ name, status: "failed" as const, error: deps.vendor.explain(error) })));
    return { status: "failed", detail: deps.vendor.explain(error) };
  }
}

export async function syncLinkedInAccounts(deps: LinkedInManagementDeps, actor: Actor): Promise<{ found: number; added: number; updated: number; skipped: number; skippedReasons: string[] }> {
  requireAdmin(actor);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (!credentials) throw new ConflictError(`Connect ${deps.vendor.name} first.`);
  const gateway = deps.vendor.gatewayFor(credentials);
  try {
    return await syncAndRecord(deps, actor.organizationId, gateway);
  } catch (error) {
    throw new ConflictError(deps.vendor.explain(error));
  }
}

export async function registerLinkedInWebhooks(deps: LinkedInManagementDeps, actor: Actor): Promise<ConnectResult["webhooks"]> {
  requireAdmin(actor);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (!credentials) throw new ConflictError(`Connect ${deps.vendor.name} first.`);
  return registerWebhooks(deps, actor.organizationId, deps.vendor.gatewayFor(credentials), credentials);
}

/** Everything an owner or admin needs to register the webhooks by hand in the vendor's dashboard. Each call writes an audit row. */
export async function getLinkedInWebhookSetup(deps: LinkedInManagementDeps, actor: Actor) {
  requireAdmin(actor);
  const [credentials, status] = await Promise.all([deps.accounts.getCredentials(actor.organizationId), deps.accounts.getWebhookStatus(actor.organizationId)]);
  if (!credentials) throw new ConflictError(`Connect ${deps.vendor.name} first.`);
  // The row is written first: when it fails, the secret does not leave.
  await deps.audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "integration.secret_viewed", entityType: "integration", meta: { provider: deps.vendor.key } });
  const requestUrl = webhookRequestUrl(deps, actor.organizationId);
  return {
    requestUrl,
    headerName: deps.vendor.webhooks.headerName,
    secret: credentials.notifySecret,
    webhooks: deps.vendor.webhooks.hooks.map((hook) => ({ ...hook, requestUrl })),
    status,
  };
}

/** Removes this organization's webhooks at the vendor, then clears the credentials. A gateway failure is logged and never blocks the disconnect. */
export async function disconnectLinkedIn(deps: LinkedInManagementDeps, actor: Actor): Promise<void> {
  requireAdmin(actor);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (credentials && !isLocalOrigin(deps.appUrl)) {
    try {
      await deps.vendor.gatewayFor(credentials).removeWebhooks({ requestUrl: webhookRequestUrl(deps, actor.organizationId) });
    } catch (error) {
      console.error(`LinkedIn disconnect: could not remove ${deps.vendor.name} webhooks for organization ${actor.organizationId}: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  }
  await deps.accounts.clearCredentials(actor.organizationId);
}

export interface LinkedInAccountSettings {
  dailyInviteLimit?: number;
  dailyMessageLimit?: number;
  isPremium?: boolean;
  workingHours?: WorkingHours | null;
  /** The member whose LinkedIn this is, or null for none. An agent's search uses only accounts its token's person owns and accounts with no owner. */
  ownerUserId?: string | null;
}

/** Saves the limits and hours of one account. A value past the safe edge saves, and the answer carries the warning text. */
export async function updateLinkedInAccount(deps: LinkedInManagementDeps, actor: Actor, id: string, settings: LinkedInAccountSettings): Promise<{ warnings: string[] }> {
  requireAdmin(actor);
  if (settings.dailyInviteLimit !== undefined) {
    const problem = limitProblem(INVITE_LIMIT_RULE, settings.dailyInviteLimit);
    if (problem) throw new ValidationError(problem);
  }
  if (settings.dailyMessageLimit !== undefined) {
    const problem = limitProblem(MESSAGE_LIMIT_RULE, settings.dailyMessageLimit);
    if (problem) throw new ValidationError(problem);
  }
  if (settings.workingHours) {
    const zone = canonicalTimeZone(settings.workingHours.timeZone);
    if (!zone) throw new ValidationError("Unknown time zone.");
    const hours = { ...settings.workingHours, timeZone: zone };
    settings = { ...settings, workingHours: hours };
    for (const windows of Object.values(hours.days)) {
      for (const w of windows) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)) throw new ValidationError("Times must look like 09:00.");
      }
    }
  }
  if (settings.ownerUserId && !(await deps.members?.isMember(actor.organizationId, settings.ownerUserId))) throw new ValidationError("The owner must be a member of this organization.");
  const stored = await deps.accounts.update(actor.organizationId, id, settings, (row) => [
    ...(settings.ownerUserId !== undefined
      ? [{ organizationId: actor.organizationId, actorUserId: actor.userId, action: "linkedin.owner_changed", entityType: "linkedin_account", entityId: id, meta: { ownerUserId: settings.ownerUserId } }]
      : []),
    ...(settings.dailyInviteLimit !== undefined || settings.dailyMessageLimit !== undefined || settings.isPremium !== undefined
      ? [{ organizationId: actor.organizationId, actorUserId: actor.userId, action: "linkedin.limits_changed", entityType: "linkedin_account", entityId: id, meta: { dailyInviteLimit: row.dailyInviteLimit, dailyMessageLimit: row.dailyMessageLimit, isPremium: row.isPremium } }]
      : []),
  ]);
  if (!stored) throw new NotFoundError("LinkedIn account not found");
  return { warnings: limitWarnings(stored) };
}
