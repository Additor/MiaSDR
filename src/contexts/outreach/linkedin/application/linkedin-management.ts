import { randomBytes } from "node:crypto";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { DEFAULT_LINKEDIN_RULES } from "../domain/linkedin";
import { INVITE_LIMIT_RULE, MESSAGE_LIMIT_RULE, limitProblem, limitWarnings } from "../domain/linkedin-limits";
import { canonicalTimeZone } from "@/shared/time-zone";
import { type WorkingHours } from "../../domain/working-hours";
import { LinkedInGatewayError, type GatewayAccount, type LinkedInGateway } from "./linkedin-ports";
import type { LinkedInConnectStore } from "./linkedin-connect-ports";

import type { AuditSink } from "@/contexts/tenancy/application/audit-log";
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

export const WEBHOOK_HEADER = "x-unipile-secret";

export interface LinkedInCredentials {
  /** Host of the Unipile DSN, such as `api1.unipile.com:13111`, without scheme or trailing slash. */
  dsn: string;
  apiKey: string;
  /** Shared secret Unipile sends in `x-unipile-secret` on every webhook. Generated on first save. */
  notifySecret: string;
}

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
}

export interface LinkedInAccountStore {
  getCredentials(organizationId: string): Promise<LinkedInCredentials | null>;
  saveCredentials(organizationId: string, credentials: LinkedInCredentials): Promise<void>;
  /** The last stored registration result, or null when none was recorded. */
  getWebhookStatus(organizationId: string): Promise<WebhookStatus | null>;
  /** Replaces the stored registration result. A no-op when the organization has no Unipile row. */
  saveWebhookStatus(organizationId: string, status: WebhookStatus): Promise<void>;
  /** Removes the credentials and marks every account disconnected. */
  clearCredentials(organizationId: string): Promise<void>;
  /** Matches by LinkedIn id, then by username (a reconnect brings a new provider id). An account whose provider account id is already taken by another organization or another LinkedIn account is skipped with a reason and the rest still sync. Returns how many rows changed. */
  upsertAccounts(
    organizationId: string,
    accounts: Array<GatewayAccount & { isPremium: boolean | null; headline: string | null }>,
  ): Promise<{ added: number; updated: number; skipped: number; skippedReasons: string[]; changes: AccountStatusChange[] }>;
  /** Organizations whose Unipile integration is enabled and has a credential row. Decrypting is left to `getCredentials`. */
  listCredentialedOrganizations(): Promise<string[]>;
  /** The last stored sync result. Both fields are null when no sync was recorded. */
  getSyncStatus(organizationId: string): Promise<SyncStatus>;
  /** Merges the given fields into the stored sync result. A no-op when the organization has no Unipile row. */
  saveSyncStatus(organizationId: string, patch: Partial<SyncStatus>): Promise<void>;
  list(organizationId: string, now: Date): Promise<LinkedInAccountRecord[]>;
  /** Returns the stored limits after the change, or null when the account is not in this organization. */
  update(
    organizationId: string,
    id: string,
    patch: { dailyInviteLimit?: number; dailyMessageLimit?: number; isPremium?: boolean; workingHours?: WorkingHours | null },
  ): Promise<{ dailyInviteLimit: number; dailyMessageLimit: number; isPremium: boolean } | null>;
}

export interface LinkedInManagementDeps {
  accounts: LinkedInAccountStore;
  /** Builds a gateway for credentials, so a connection can be verified before it is saved. */
  gatewayFor: (credentials: Pick<LinkedInCredentials, "dsn" | "apiKey"> & { scheme?: DsnScheme }) => LinkedInGateway;
  /** Which DSN hosts may receive the API key. Defaults to `*.unipile.com` only. */
  dsnPolicy?: DsnPolicy;
  appUrl: string;
  now: () => Date;
  audit: AuditSink;
  connectLinks: LinkedInConnectStore;
}

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can manage LinkedIn.");
}

export interface DsnPolicy {
  /** Hosts allowed besides `*.unipile.com`: `host`, `host:port` or `*.domain`. */
  allowedHosts: string[];
  /** Lets localhost, 127.0.0.1 and [::1] through, with plain http. Tests and the fake provider only. */
  allowLoopback: boolean;
}

/** `http` only for an allowed loopback host. Everything else is `https`. */
export type DsnScheme = "https" | "http";

const STRICT_DSN_POLICY: DsnPolicy = { allowedHosts: [], allowLoopback: false };
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function hostAllowed(hostname: string, host: string, entries: string[]): boolean {
  if (hostname.endsWith(".unipile.com")) return true;
  return entries.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "") return false;
    if (entry.startsWith("*.")) return hostname.endsWith(entry.slice(1));
    return entry === host || entry === hostname;
  });
}

/**
 * Accepts `https://api1.unipile.com:13111/` or `api1.unipile.com:13111` and returns the bare host with its port, or null.
 * The key is sent to this host, so it must be a Unipile host (or one the operator listed). IP literals, userinfo,
 * paths, non-https schemes and ports outside 1..65535 are refused.
 */
export function normalizeDsn(input: string, policy: DsnPolicy = STRICT_DSN_POLICY): string | null {
  return parseDsn(input, policy)?.host ?? null;
}

/** The single parse of a DSN: the normalized host and the scheme the gateway must use. The gateway never re-derives either. */
export function parseDsn(input: string, policy: DsnPolicy = STRICT_DSN_POLICY): { host: string; scheme: DsnScheme } | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > 255) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase() ?? null;
  if (scheme !== null && scheme !== "https" && scheme !== "http") return null;
  let url: URL;
  try {
    url = new URL(scheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  const hostname = url.hostname.toLowerCase();
  // URL drops a default port and leaves the rest alone, so read the port from the text.
  const authority = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0];
  const port = /:(\d*)$/.exec(authority.replace(/^\[[^\]]*\]/, ""))?.[1];
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
  const host = url.host.toLowerCase();

  if (LOOPBACK.test(hostname)) return policy.allowLoopback ? { host, scheme: "http" } : null;
  // Plain http is for loopback only.
  if (scheme === "http") return null;
  if (hostname.startsWith("[") || /^[0-9.]+$/.test(hostname) || /^0x/i.test(hostname)) return null;
  if (!HOSTNAME.test(hostname)) return null;
  return hostAllowed(hostname, host, policy.allowedHosts) ? { host, scheme: "https" } : null;
}

/** True for an IPv4 literal in a range Unipile cannot reach from the internet. */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  // 100.64.0.0/10 is carrier-grade NAT, which includes Tailscale addresses.
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True for loopback, private, CGNAT, link-local and container-internal hosts, including single-label names such as a compose service (`mia`). An unparseable URL counts as local. */
export function isLocalOrigin(url: string): boolean {
  let host: string;
  try {
    // WHATWG URL keeps the brackets on an IPv6 literal.
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "host.docker.internal") return true;
  if (isPrivateIpv4(host)) return true;
  // A name without a dot cannot be a public DNS name. It resolves only inside a container network or a LAN.
  if (!host.includes(".") && !host.includes(":")) return true;
  if (host.includes(":")) {
    // URL rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}

/** Turns gateway failures into fixed messages. The upstream error text is never passed on, because the host may not be Unipile. */
export function explain(error: unknown): string {
  if (error instanceof LinkedInGatewayError) {
    if (error.code === "auth") return "Unipile rejected the API key. Check the key and the DSN in your Unipile dashboard.";
    if (error.code === "unavailable") return "Could not reach Unipile. Check the DSN and try again.";
    if (error.code === "insufficient_privileges") return "Unipile refused the request because this API key or LinkedIn account lacks access to it.";
    return "Unipile refused the request. Check the DSN and the API key.";
  }
  return "Could not reach Unipile.";
}

/** A stored DSN is checked again before every use, so a row saved under an older, looser rule cannot reach the network. */
export function storedGateway(deps: LinkedInManagementDeps, credentials: LinkedInCredentials): LinkedInGateway {
  const parsed = parseDsn(credentials.dsn, deps.dsnPolicy);
  if (!parsed) throw new ConflictError("The saved Unipile DSN is not allowed. Reconnect with the DSN from your Unipile dashboard.");
  return deps.gatewayFor({ dsn: parsed.host, scheme: parsed.scheme, apiKey: credentials.apiKey });
}

const webhookRequestUrl = (deps: LinkedInManagementDeps, organizationId: string) => `${deps.appUrl.replace(/\/$/, "")}/api/webhooks/unipile?org=${organizationId}`;

export async function listLinkedInAccounts(deps: LinkedInManagementDeps, actor: Actor) {
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
    dsn: credentials?.dsn ?? null,
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
export function syncErrorText(error: unknown): string {
  if (error instanceof LinkedInGatewayError && error.code === "auth") return "Unipile rejected the saved key. Connect again with a new key.";
  if (error instanceof ConflictError) return error.message;
  return explain(error);
}

/** `syncWith`, then the result goes on the integration row. A failed sync keeps `lastSyncAt` and rethrows the original error. */
export async function syncAndRecord(deps: LinkedInManagementDeps, organizationId: string, gateway: LinkedInGateway | (() => LinkedInGateway)) {
  let result: Awaited<ReturnType<typeof syncWith>>;
  try {
    // A factory runs inside the try, so a DSN the policy rejects is recorded like any other failure.
    result = await syncWith(deps, organizationId, typeof gateway === "function" ? gateway() : gateway);
  } catch (error) {
    try {
      await deps.accounts.saveSyncStatus(organizationId, { lastSyncError: syncErrorText(error) });
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

/** Verifies the Unipile credentials, saves them encrypted, pulls the LinkedIn accounts and registers webhooks. */
export async function connectLinkedIn(deps: LinkedInManagementDeps, actor: Actor, input: { dsn: string; apiKey: string }): Promise<ConnectResult> {
  requireAdmin(actor);
  const parsed = parseDsn(input.dsn, deps.dsnPolicy);
  if (!parsed) throw new ValidationError("Enter the DSN as shown in the Unipile dashboard, for example api1.unipile.com:13111. Only Unipile hosts are accepted.");
  const apiKey = input.apiKey.trim();
  if (apiKey === "" || apiKey.length > 500) throw new ValidationError("Enter the Unipile API key.");

  const dsn = parsed.host;
  const gateway = deps.gatewayFor({ dsn, scheme: parsed.scheme, apiKey });
  try {
    await gateway.verify();
  } catch (error) {
    throw new ValidationError(explain(error));
  }
  const existing = await deps.accounts.getCredentials(actor.organizationId);
  const credentials: LinkedInCredentials = { dsn, apiKey, notifySecret: existing?.notifySecret ?? randomBytes(24).toString("base64url") };
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
    return { status: "skipped", detail: "APP_URL is a local or private address, so Unipile cannot reach it. Replies and acceptances are not delivered until the app has a public HTTPS URL." };
  }
  try {
    const { registered, hooks } = await gateway.registerWebhooks({ requestUrl: webhookRequestUrl(deps, organizationId), secret: credentials.notifySecret, name: "MiaSDR" });
    await persist(hooks.map((h) => (h.error === null ? { name: h.name, status: "registered" as const } : { name: h.name, status: "failed" as const, error: explain(h.error) })));
    const failed = hooks.filter((h) => h.error !== null);
    if (failed.length) {
      // The status stays failed. The text names the hooks that exist so nobody re-registers a working one.
      const detail = registered.length ? `Registered: ${registered.join(", ")}. Failed: ${failed.map((h) => h.name).join(", ")} - ${explain(failed[0].error)}` : explain(failed[0].error);
      return { status: "failed", detail };
    }
    return { status: "registered", detail: registered.length ? `Registered: ${registered.join(", ")}.` : "Already registered." };
  } catch (error) {
    await persist(WEBHOOK_NAMES.map((name) => ({ name, status: "failed" as const, error: explain(error) })));
    return { status: "failed", detail: explain(error) };
  }
}

const WEBHOOK_NAMES = ["users:new_relation", "messaging:message_received"];

export async function syncLinkedInAccounts(deps: LinkedInManagementDeps, actor: Actor): Promise<{ found: number; added: number; updated: number; skipped: number; skippedReasons: string[] }> {
  requireAdmin(actor);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (!credentials) throw new ConflictError("Connect Unipile first.");
  const gateway = storedGateway(deps, credentials);
  try {
    return await syncAndRecord(deps, actor.organizationId, gateway);
  } catch (error) {
    throw new ConflictError(explain(error));
  }
}

export async function registerLinkedInWebhooks(deps: LinkedInManagementDeps, actor: Actor): Promise<ConnectResult["webhooks"]> {
  requireAdmin(actor);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (!credentials) throw new ConflictError("Connect Unipile first.");
  return registerWebhooks(deps, actor.organizationId, storedGateway(deps, credentials), credentials);
}

/** Everything an owner or admin needs to register the webhooks by hand in the Unipile dashboard. Each call writes an audit row. */
export async function getLinkedInWebhookSetup(deps: LinkedInManagementDeps, actor: Actor) {
  requireAdmin(actor);
  const [credentials, status] = await Promise.all([deps.accounts.getCredentials(actor.organizationId), deps.accounts.getWebhookStatus(actor.organizationId)]);
  if (!credentials) throw new ConflictError("Connect Unipile first.");
  // The row is written first: when it fails, the secret does not leave.
  await deps.audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "integration.secret_viewed", entityType: "integration", meta: { provider: "unipile" } });
  const requestUrl = webhookRequestUrl(deps, actor.organizationId);
  return {
    requestUrl,
    headerName: WEBHOOK_HEADER,
    secret: credentials.notifySecret,
    webhooks: [
      { name: WEBHOOK_NAMES[0], source: "users", event: "new_relation", requestUrl },
      { name: WEBHOOK_NAMES[1], source: "messaging", event: "message_received", requestUrl },
    ],
    status,
  };
}

/** Removes this organization's webhooks at Unipile, then clears the credentials. A gateway failure is logged and never blocks the disconnect. */
export async function disconnectLinkedIn(deps: LinkedInManagementDeps, actor: Actor): Promise<void> {
  requireAdmin(actor);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (credentials && !isLocalOrigin(deps.appUrl)) {
    try {
      await storedGateway(deps, credentials).removeWebhooks({ requestUrl: webhookRequestUrl(deps, actor.organizationId) });
    } catch (error) {
      console.error(`LinkedIn disconnect: could not remove Unipile webhooks for organization ${actor.organizationId}: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  }
  await deps.accounts.clearCredentials(actor.organizationId);
}

export interface LinkedInAccountSettings {
  dailyInviteLimit?: number;
  dailyMessageLimit?: number;
  isPremium?: boolean;
  workingHours?: WorkingHours | null;
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
  const stored = await deps.accounts.update(actor.organizationId, id, settings);
  if (!stored) throw new NotFoundError("LinkedIn account not found");
  if (settings.dailyInviteLimit !== undefined || settings.dailyMessageLimit !== undefined || settings.isPremium !== undefined) {
    await deps.audit.record({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "linkedin.limits_changed",
      entityType: "linkedin_account",
      entityId: id,
      meta: { dailyInviteLimit: stored.dailyInviteLimit, dailyMessageLimit: stored.dailyMessageLimit, isPremium: stored.isPremium },
    });
  }
  return { warnings: limitWarnings(stored) };
}
