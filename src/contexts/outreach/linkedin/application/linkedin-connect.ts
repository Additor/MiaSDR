import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { LinkedInGatewayError, type LinkedInVendor, type VendorCredentials } from "./linkedin-ports";
import { isLocalOrigin } from "@/shared/local-origin";
import { syncWith, vendorOf, type LinkedInManagementDeps } from "./linkedin-management";

/** A callback may arrive a little after the link expired, because the person finishes the wizard before the vendor notifies us. */
export const CONNECT_CALLBACK_GRACE_MINUTES = 30;
export const MAX_PENDING_LINKS = 5;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function sameHash(secret: string, storedHex: string): boolean {
  const a = Buffer.from(sha256(secret), "hex");
  const b = Buffer.from(storedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can connect LinkedIn accounts.");
}

/** Removes an account no row here uses at the vendor, which would otherwise hold a seat of its plan and block a second try at the same profile. */
async function removeUnusedAccount(vendor: LinkedInVendor, credentials: VendorCredentials, account: string): Promise<void> {
  await vendor.connectSession?.cancel(credentials, account).catch((error: unknown) => {
    console.error(`LinkedIn connect: could not remove the unused account at ${vendor.name}: ${error instanceof Error ? error.name : "unknown error"}`);
  });
}

/** Ends this organization's links past their expiry, and gives their unused accounts back to the vendor. */
export async function expireConnectLinks(deps: LinkedInManagementDeps, organizationId: string, vendor: LinkedInVendor, credentials: VendorCredentials, now: Date): Promise<void> {
  const expired = await deps.connectLinks.expireDue(organizationId, now);
  const accounts = expired.filter((account) => account !== null);
  if (!vendor.connectSession || accounts.length === 0) return;
  const inUse = await deps.accounts.accountRefs(organizationId, vendor.key);
  for (const account of accounts) if (!inUse.includes(account)) await removeUnusedAccount(vendor, credentials, account);
}

export interface ConnectLinkResult {
  /** Send the browser here with a full navigation. */
  url: string;
  expiresAt: Date;
  /** False when the vendor cannot reach this app: the account shows up through the sync that runs when the person returns. */
  notify: boolean;
  linkId: string;
}

/**
 * Creates a link that connects a LinkedIn account through the vendor. `reconnectAccountId` is one of our LinkedIn account ids and
 * re-authenticates that account in place. The link row is stored before the provider call, so a callback cannot outrun it.
 */
export async function createConnectLink(deps: LinkedInManagementDeps, actor: Actor, input: { reconnectAccountId?: string | null; ownerUserId?: string | null } = {}): Promise<ConnectLinkResult> {
  requireAdmin(actor);
  // A reconnect keeps the owner the account has.
  const ownerUserId = input.reconnectAccountId ? null : (input.ownerUserId ?? null);
  if (ownerUserId && !(await deps.members?.isMember(actor.organizationId, ownerUserId))) throw new ValidationError("The owner must be a member of this organization.");
  const vendor = await vendorOf(deps, actor.organizationId);
  if (vendor.connectLinkMinutes === null) throw new ConflictError(`Connect the account in ${vendor.name}, then choose Sync accounts.`);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (!credentials) throw new ConflictError(`Connect ${vendor.name} first.`);
  const gateway = vendor.gatewayFor(credentials);
  const now = deps.now();

  let reconnectAccount: string | null = null;
  if (input.reconnectAccountId) {
    const accounts = await deps.accounts.list(actor.organizationId, now);
    const account = accounts.find((a) => a.id === input.reconnectAccountId);
    if (!account) throw new NotFoundError("LinkedIn account not found");
    // An account stays with its vendor, so one left from an earlier vendor cannot be reconnected through this one.
    if (!(await deps.accounts.accountRefs(actor.organizationId, vendor.key)).includes(account.providerAccountId)) throw new ConflictError(`This LinkedIn account is not on ${vendor.name}, and cannot move to it. Connect ${vendor.name} accounts as new ones.`);
    reconnectAccount = account.providerAccountId;
  }

  await expireConnectLinks(deps, actor.organizationId, vendor, credentials, now);
  if ((await deps.connectLinks.countPending(actor.organizationId, now)) >= (vendor.connectSession?.oneLinkAtATime ? 1 : MAX_PENDING_LINKS)) {
    throw new ConflictError(vendor.connectSession ? "Several connection links are still open. Finish or cancel one." : "Several connection links are still open. Finish one or wait a few minutes.");
  }

  const id = randomUUID();
  const secret = randomBytes(24).toString("base64url");
  const providerName = `mia-${randomBytes(9).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + vendor.connectLinkMinutes * 60_000);
  await deps.connectLinks.create({ id, organizationId: actor.organizationId, providerName, secretHash: sha256(secret), expiresAt, createdBy: actor.userId, ownerUserId, reconnectAccountId: input.reconnectAccountId ?? null });

  const urls = vendor.connectCallback?.urls({ appUrl: deps.appUrl, linkId: id, secret }) ?? null;
  const notify = urls !== null && !isLocalOrigin(deps.appUrl);
  try {
    const { url, account } = await gateway.createConnectLink!({
      name: providerName,
      expiresAt,
      successRedirectUrl: urls?.success ?? deps.appUrl,
      failureRedirectUrl: urls?.failure ?? deps.appUrl,
      notifyUrl: notify && urls ? urls.notify : null,
      reconnectAccount,
      timeZone: reconnectAccount ? null : await deps.accounts.timeZone(actor.organizationId),
    });
    if (account) await deps.connectLinks.noteAccount(id, account);
    await deps.audit.record({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: reconnectAccount ? "linkedin.reconnect_link_created" : "linkedin.connect_link_created",
      entityType: "linkedin_connect_link",
      entityId: id,
      meta: { expiresAt: expiresAt.toISOString(), notify },
    });
    return { url, expiresAt, notify, linkId: id };
  } catch (error) {
    await deps.connectLinks.fail(id, error instanceof LinkedInGatewayError ? vendor.explain(error) : "Could not create the link.");
    if (error instanceof LinkedInGatewayError) throw new ConflictError(vendor.explain(error));
    throw error;
  }
}

export type NotifyResult =
  | { status: 200; outcome: "completed" | "duplicate" | "failed" }
  | { status: 400 | 401 | 410 | 502 };

/**
 * The public callback. The link id picks the row and the secret in the URL must match its stored hash (constant-time).
 * Wrong id, wrong secret and a name that does not belong to the link all answer 401, so a caller learns nothing.
 * A repeat of a completed link answers 200 and changes nothing.
 */
export async function receiveConnectNotify(deps: LinkedInManagementDeps, input: { linkId: string; secret: string; payload: unknown }): Promise<NotifyResult> {
  if (!/^[0-9a-f-]{36}$/i.test(input.linkId) || input.secret === "") return { status: 401 };
  const link = await deps.connectLinks.find(input.linkId);
  if (!link || !sameHash(input.secret, link.secretHash)) return { status: 401 };
  const vendor = await vendorOf(deps, link.organizationId);
  if (!vendor.connectCallback) return { status: 401 };
  const body = vendor.connectCallback.readNotify(input.payload);
  if (!body) return { status: 400 };
  if (body.name !== link.providerName) return { status: 401 };
  if (link.status === "completed") return { status: 200, outcome: "duplicate" };

  const now = deps.now();
  if (link.status !== "pending" || now.getTime() > link.expiresAt.getTime() + CONNECT_CALLBACK_GRACE_MINUTES * 60_000) {
    if (link.status === "pending") await deps.connectLinks.fail(link.id, `The link expired before ${vendor.name} reported a result.`);
    return { status: 410 };
  }

  if (!body.connected) {
    await deps.connectLinks.fail(link.id, `${vendor.name} reported ${body.status.slice(0, 60)}.`);
    return { status: 200, outcome: "failed" };
  }
  if (!body.accountId) return { status: 400 };

  const credentials = await deps.accounts.getCredentials(link.organizationId);
  if (!credentials) {
    await deps.connectLinks.fail(link.id, `${vendor.name} is no longer connected.`);
    return { status: 200, outcome: "failed" };
  }
  try {
    await syncWith(deps, link.organizationId, vendor, vendor.gatewayFor(credentials));
  } catch (error) {
    // The vendor retries a non-200, and the link stays pending for that.
    await deps.connectLinks.noteError(link.id, vendor.explain(error));
    return { status: 502 };
  }
  const done = await deps.connectLinks.complete(link.id, { providerAccountId: body.accountId, now });
  if (done) {
    await deps.audit.record({
      organizationId: link.organizationId,
      actorUserId: null,
      action: "linkedin.account_connected",
      entityType: "linkedin_connect_link",
      entityId: link.id,
      meta: { providerAccountId: body.accountId, status: body.status },
    });
  }
  return { status: 200, outcome: done ? "completed" : "duplicate" };
}

export type ConnectLinkState = { status: "pending" | "completed" | "failed"; error: string | null };

const linkState = (status: "pending" | "completed" | "failed", error: string | null = null): ConnectLinkState => ({ status, error });

/**
 * Asks the vendor how a link stands, for a vendor whose link does not report back. Once it says connected, this reads who
 * signed in and stores the account. Someone else signed in on a reconnect leaves that account disconnected, because its
 * leads and threads are not theirs, and the link open, because the person may be on their way to the right sign-in.
 */
export async function checkConnectLink(deps: LinkedInManagementDeps, actor: Actor, linkId: string): Promise<ConnectLinkState> {
  requireAdmin(actor);
  const link = await deps.connectLinks.find(linkId);
  if (!link || link.organizationId !== actor.organizationId) throw new NotFoundError("Connection link not found");
  if (link.status === "completed") return linkState("completed");
  if (link.status !== "pending") return linkState("failed", link.lastError);
  const now = deps.now();
  const vendor = await vendorOf(deps, actor.organizationId);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (!credentials) {
    await deps.connectLinks.fail(link.id, `${vendor.name} is no longer connected.`);
    return linkState("failed", `${vendor.name} is no longer connected.`);
  }
  if (!vendor.connectSession || !link.providerAccountId) return linkState("pending");
  const ref = link.providerAccountId;
  try {
    const reconnecting = link.reconnectAccountId ? (await deps.accounts.list(actor.organizationId, now)).find((a) => a.id === link.reconnectAccountId) : undefined;
    const session = await vendor.connectSession.status(credentials, { ref, createdAt: link.createdAt, reconnectAccount: reconnecting?.providerAccountId ?? null });
    if (session.state === "pending") return linkState("pending");
    if (session.state === "failed") {
      // A reconnect starts from a sign-in the vendor already calls failed, so until the person signs in again this says nothing. Cancel or the expiry ends the link.
      if ((await deps.accounts.accountRefs(actor.organizationId, vendor.key)).includes(ref)) return linkState("pending");
      await removeUnusedAccount(vendor, credentials, ref);
      const text = session.error ?? `${vendor.name} could not keep LinkedIn signed in. Try again.`;
      await deps.connectLinks.fail(link.id, text);
      return linkState("failed", text);
    }
    // A vendor whose link is a session names the account here. The session is finished, so nothing is left to remove on a refusal.
    const account = session.account ?? ref;
    const namedByVendor = session.account !== undefined;
    const own = await vendor.gatewayFor(credentials).getOwnProfile(account);
    if (namedByVendor && reconnecting?.username && own.publicSlug !== reconnecting.username) {
      const text = "Someone else is signed in to this account. Sign in with its own LinkedIn.";
      await deps.connectLinks.noteError(link.id, text);
      return linkState("pending", text);
    }
    const stored = await deps.accounts.upsertAccounts(
      actor.organizationId,
      [{ ref: account, linkedinId: own.member, name: [own.firstName, own.lastName].filter(Boolean).join(" ") || null, username: own.publicSlug, status: "connected", isPremium: own.isPremium, headline: own.headline }],
      vendor.key,
    );
    if (stored.skipped > 0) {
      if (namedByVendor) {
        const text = stored.skippedReasons[0] ?? "This LinkedIn account could not be connected here.";
        await deps.connectLinks.fail(link.id, text);
        return linkState("failed", text);
      }
      if ((await deps.accounts.accountRefs(actor.organizationId, vendor.key)).includes(account)) {
        await deps.accounts.updateAccountStatuses(actor.organizationId, vendor.key, [{ ref: account, linkedinId: null, name: null, username: null, status: "disconnected" }]);
        const text = "Someone else is signed in to this account. Sign in with its own LinkedIn.";
        await deps.connectLinks.noteError(link.id, text);
        return linkState("pending", text);
      }
      await removeUnusedAccount(vendor, credentials, account);
      const text = stored.skippedReasons[0] ?? "This LinkedIn account could not be connected here.";
      await deps.connectLinks.fail(link.id, text);
      return linkState("failed", text);
    }
    if (await deps.connectLinks.complete(link.id, { providerAccountId: account, now })) {
      await deps.audit.record({ organizationId: link.organizationId, actorUserId: actor.userId, action: "linkedin.account_connected", entityType: "linkedin_connect_link", entityId: link.id, meta: { providerAccountId: account, status: "connected" } });
    }
    return linkState("completed");
  } catch (error) {
    const text = vendor.explain(error);
    await deps.connectLinks.noteError(link.id, text);
    return linkState("pending", text);
  }
}

/** Gives up on a link. An account no row uses is removed at the vendor; a reconnect keeps its account. */
export async function cancelConnectLink(deps: LinkedInManagementDeps, actor: Actor, linkId: string): Promise<void> {
  requireAdmin(actor);
  const link = await deps.connectLinks.find(linkId);
  if (!link || link.organizationId !== actor.organizationId) throw new NotFoundError("Connection link not found");
  if (link.status !== "pending") return;
  const vendor = await vendorOf(deps, actor.organizationId);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  const account = link.providerAccountId;
  // The link closes first: one a check completed a moment ago has an account, which stays.
  if (!(await deps.connectLinks.fail(link.id, "Cancelled."))) return;
  if (credentials && vendor.connectSession && account && !(await deps.accounts.accountRefs(actor.organizationId, vendor.key)).includes(account)) await removeUnusedAccount(vendor, credentials, account);
}
