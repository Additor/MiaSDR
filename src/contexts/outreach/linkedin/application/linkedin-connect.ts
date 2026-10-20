import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ConflictError, ForbiddenError, NotFoundError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { LinkedInGatewayError } from "./linkedin-ports";
import { explain, isLocalOrigin, storedGateway, syncWith, type LinkedInManagementDeps } from "./linkedin-management";

/** How long the wizard link stays valid. Unipile expires every link at its daily restart anyway. */
export const CONNECT_LINK_MINUTES = 15;
/** A callback may arrive a little after the link expired, because the person finishes the wizard before Unipile notifies us. */
export const CONNECT_CALLBACK_GRACE_MINUTES = 30;
export const MAX_PENDING_LINKS = 5;

export const CONNECT_NOTIFY_PATH = "/api/webhooks/unipile-account";
export const CONNECT_RETURN_PATH = "/settings/linkedin";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function sameHash(secret: string, storedHex: string): boolean {
  const a = Buffer.from(sha256(secret), "hex");
  const b = Buffer.from(storedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can connect LinkedIn accounts.");
}

export interface ConnectLinkResult {
  /** Send the browser here with a full navigation. */
  url: string;
  expiresAt: Date;
  /** False when Unipile cannot reach this app: the account shows up through the sync that runs when the person returns. */
  notify: boolean;
  linkId: string;
}

/**
 * Creates a Unipile hosted-auth link for the organization. `reconnectAccountId` is one of our LinkedIn account ids and
 * re-authenticates that account in place. The link row is stored before the provider call, so a callback cannot outrun it.
 */
export async function createConnectLink(deps: LinkedInManagementDeps, actor: Actor, input: { reconnectAccountId?: string | null } = {}): Promise<ConnectLinkResult> {
  requireAdmin(actor);
  const credentials = await deps.accounts.getCredentials(actor.organizationId);
  if (!credentials) throw new ConflictError("Connect Unipile first.");
  const gateway = storedGateway(deps, credentials);
  const now = deps.now();

  let reconnectAccount: string | null = null;
  if (input.reconnectAccountId) {
    const accounts = await deps.accounts.list(actor.organizationId, now);
    const account = accounts.find((a) => a.id === input.reconnectAccountId);
    if (!account) throw new NotFoundError("LinkedIn account not found");
    reconnectAccount = account.providerAccountId;
  }

  await deps.connectLinks.expireDue(actor.organizationId, now);
  if ((await deps.connectLinks.countPending(actor.organizationId, now)) >= MAX_PENDING_LINKS) {
    throw new ConflictError("Several connection links are still open. Finish one or wait a few minutes.");
  }

  const id = randomUUID();
  const secret = randomBytes(24).toString("base64url");
  const providerName = `mia-${randomBytes(9).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + CONNECT_LINK_MINUTES * 60_000);
  await deps.connectLinks.create({ id, organizationId: actor.organizationId, providerName, secretHash: sha256(secret), expiresAt, createdBy: actor.userId });

  const base = deps.appUrl.replace(/\/$/, "");
  const notify = !isLocalOrigin(deps.appUrl);
  try {
    const { url } = await gateway.createHostedAuthLink({
      name: providerName,
      expiresAt,
      successRedirectUrl: `${base}${CONNECT_RETURN_PATH}?unipile=success&link=${id}`,
      failureRedirectUrl: `${base}${CONNECT_RETURN_PATH}?unipile=failure&link=${id}`,
      notifyUrl: notify ? `${base}${CONNECT_NOTIFY_PATH}?link=${id}&secret=${encodeURIComponent(secret)}` : null,
      reconnectAccount,
    });
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
    await deps.connectLinks.fail(id, error instanceof LinkedInGatewayError ? error.message.slice(0, 300) : "Could not create the link.");
    if (error instanceof LinkedInGatewayError) throw new ConflictError(explain(error));
    throw error;
  }
}

export type NotifyResult =
  | { status: 200; outcome: "completed" | "duplicate" | "failed" }
  | { status: 400 | 401 | 410 | 502 };

/** Unipile's body on `notify_url`: { status, account_id, name }. The docs name no signature, so the secret rides in the URL. */
function parseNotify(payload: unknown): { status: string; accountId: string | null; name: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.status !== "string" || typeof p.name !== "string") return null;
  return { status: p.status, accountId: typeof p.account_id === "string" && p.account_id !== "" ? p.account_id : null, name: p.name };
}

/**
 * The public callback. The link id picks the row and the secret in the URL must match its stored hash (constant-time).
 * Wrong id, wrong secret and a name that does not belong to the link all answer 401, so a caller learns nothing.
 * A repeat of a completed link answers 200 and changes nothing.
 */
export async function receiveConnectNotify(deps: LinkedInManagementDeps, input: { linkId: string; secret: string; payload: unknown }): Promise<NotifyResult> {
  if (!/^[0-9a-f-]{36}$/i.test(input.linkId) || input.secret === "") return { status: 401 };
  const link = await deps.connectLinks.find(input.linkId);
  if (!link || !sameHash(input.secret, link.secretHash)) return { status: 401 };
  const body = parseNotify(input.payload);
  if (!body) return { status: 400 };
  if (body.name !== link.providerName) return { status: 401 };
  if (link.status === "completed") return { status: 200, outcome: "duplicate" };

  const now = deps.now();
  if (link.status !== "pending" || now.getTime() > link.expiresAt.getTime() + CONNECT_CALLBACK_GRACE_MINUTES * 60_000) {
    if (link.status === "pending") await deps.connectLinks.fail(link.id, "The link expired before Unipile reported a result.");
    return { status: 410 };
  }

  if (body.status !== "CREATION_SUCCESS" && body.status !== "RECONNECTED") {
    await deps.connectLinks.fail(link.id, `Unipile reported ${body.status.slice(0, 60)}.`);
    return { status: 200, outcome: "failed" };
  }
  if (!body.accountId) return { status: 400 };

  const credentials = await deps.accounts.getCredentials(link.organizationId);
  if (!credentials) {
    await deps.connectLinks.fail(link.id, "Unipile is no longer connected.");
    return { status: 200, outcome: "failed" };
  }
  try {
    await syncWith(deps, link.organizationId, storedGateway(deps, credentials));
  } catch (error) {
    // Unipile retries a non-200, and the link stays pending for that.
    await deps.connectLinks.noteError(link.id, explain(error));
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
