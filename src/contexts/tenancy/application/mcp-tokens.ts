import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { MCP_TOKEN_DAYS, MCP_TOKEN_LIMIT, MCP_TOKEN_NAME_MAX, mcpGrantId, mcpTokenHint, mcpTokenNameProblem } from "../domain/mcp-token";
import { tokenAccess, tokenScopesProblem, type McpScope } from "../domain/mcp-policy";
import { mcpSettingsProblem, type McpSettings, type McpSettingsPatch } from "../domain/mcp-settings";
import { isOwnerOrAdmin } from "../domain/roles";
import type { AuditEntry } from "./audit-log";

/** A token as lists show it. The secret appears once, in the answer to `createMcpToken`. */
export interface McpTokenView {
  id: string;
  /** `pat` is a personal token; `oauth` is an app the person connected. */
  kind: "pat" | "oauth";
  name: string;
  /** The secret's last four characters. */
  hint: string | null;
  scopes: McpScope[];
  ownerUserId: string;
  ownerName: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

/** A token as the list reads it: the view, plus what its access depends on now. */
export interface McpTokenRow extends McpTokenView {
  /** The owner's role, or null when they left the organization. */
  ownerRole: string | null;
  policyEpoch: number;
}

/** A token in the Settings list, with what it does now. */
export interface McpTokenListItem extends McpTokenView {
  access: "read" | "write" | "send";
  /** A send token that will not send again; a new token sends. */
  sendRetired: boolean;
}

export interface NewMcpToken {
  organizationId: string;
  userId: string;
  name: string;
  tokenHash: string;
  tokenHint: string;
  scopes: McpScope[];
  policyEpoch: number;
  expiresAt: Date;
}

/** One person's tokens, while the transaction holds their member row. */
export interface McpTokenTx {
  /** Tokens that are neither revoked nor expired at `now`. */
  liveCount(now: Date): Promise<number>;
  insert(token: NewMcpToken, audit: AuditEntry): Promise<McpTokenView>;
  /** The app's row for this grant, created or brought back to life. */
  upsertGrant(grant: { organizationId: string; userId: string; name: string; oauthGrantId: string; scopes: McpScope[]; policyEpoch: number }, audit: AuditEntry): Promise<void>;
}

export interface McpTokenStore {
  /** Tokens that are not revoked, newest first; one person's when `userId` is given. */
  list(organizationId: string, userId: string | null): Promise<McpTokenRow[]>;
  /** The token's owner, revoked or not, or null when the organization has no such token. */
  owner(organizationId: string, tokenId: string): Promise<{ userId: string } | null>;
  /**
   * Runs `run` while it holds the person's member row, so a new token cannot slip in after their removal revoked the
   * others. Null when the person is no longer a member.
   */
  forMember<T>(organizationId: string, userId: string, run: (tx: McpTokenTx) => Promise<T>): Promise<T | null>;
  /**
   * Revokes the live tokens that match, under the agent-send lock. When it revoked any, it writes the audit row in the
   * same transaction with their number added to `meta.count`. Answers how many it revoked.
   */
  revoke(organizationId: string, match: { tokenId: string } | "all", audit: AuditEntry): Promise<number>;
  settings(organizationId: string): Promise<McpSettings>;
  saveSettings(organizationId: string, patch: McpSettingsPatch, userId: string, audit: AuditEntry[]): Promise<void>;
}

export interface McpTokenDeps {
  store: McpTokenStore;
  /** A new secret in the `msdr_pat_` format. */
  newSecret: () => string;
  hash: (token: string) => string;
  now: () => Date;
  /** `MCP_SEND_ENABLED`, the install's switch for agent sending. */
  installSendEnabled: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** What a new token may do. `send` also needs the organization's agent sending on. */
export const MCP_TOKEN_ACCESS = ["read", "write", "send"] as const;
export type McpTokenAccess = (typeof MCP_TOKEN_ACCESS)[number];
const SCOPES_OF: Record<McpTokenAccess, McpScope[]> = { read: ["mcp:read"], write: ["mcp:read", "mcp:write"], send: ["mcp:read", "mcp:write", "mcp:send"] };
/** Keys a person may save. The epoch is not one: only a mode change to off writes it, inside the database. */
const EDITABLE_SETTINGS = new Set(["enabled", "memberWriteTokens", "agentSendMode", "agentReplyCaps", "agentEnrollCap"]);

const audit = (actor: Actor, action: string, entityId: string | undefined, meta: Record<string, unknown>): AuditEntry => ({
  organizationId: actor.organizationId,
  actorUserId: actor.userId,
  action,
  entityType: entityId ? "mcp_token" : undefined,
  entityId,
  meta,
});

function requireAdmin(actor: Actor, message: string) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError(message);
}

/** Any member reads whether MCP is on, so the settings page can say why a token would not work. */
export async function getMcpSettings(deps: Pick<McpTokenDeps, "store">, actor: Actor): Promise<McpSettings> {
  return deps.store.settings(actor.organizationId);
}

export async function updateMcpSettings(deps: Pick<McpTokenDeps, "store">, actor: Actor, patch: Record<string, unknown>): Promise<McpSettings> {
  requireAdmin(actor, "Only an owner or admin can change MCP settings.");
  const problem = mcpSettingsProblem(patch) ?? Object.keys(patch).map((key) => (EDITABLE_SETTINGS.has(key) ? null : `${key} cannot be changed yet.`)).find(Boolean);
  if (problem) throw new ValidationError(problem);
  const current = await deps.store.settings(actor.organizationId);
  const entries: AuditEntry[] = [];
  if (typeof patch.enabled === "boolean" && patch.enabled !== current.enabled) entries.push(audit(actor, patch.enabled ? "mcp.enabled" : "mcp.disabled", undefined, {}));
  if (typeof patch.memberWriteTokens === "boolean" && patch.memberWriteTokens !== current.memberWriteTokens) {
    entries.push(audit(actor, patch.memberWriteTokens ? "mcp.member_write_on" : "mcp.member_write_off", undefined, {}));
  }
  if (typeof patch.agentSendMode === "string" && patch.agentSendMode !== current.agentSendMode) {
    entries.push(audit(actor, "mcp.agent_send_mode", undefined, { from: current.agentSendMode, to: patch.agentSendMode }));
  }
  const caps = patch.agentReplyCaps as McpSettings["agentReplyCaps"] | undefined;
  const capsChanged = caps !== undefined && (caps.org !== current.agentReplyCaps.org || caps.user !== current.agentReplyCaps.user || caps.mailbox !== current.agentReplyCaps.mailbox);
  const enrollChanged = typeof patch.agentEnrollCap === "number" && patch.agentEnrollCap !== current.agentEnrollCap;
  if (capsChanged || enrollChanged) {
    entries.push(audit(actor, "mcp.agent_limits", undefined, { replies: caps ?? current.agentReplyCaps, enroll: enrollChanged ? patch.agentEnrollCap : current.agentEnrollCap }));
  }
  if (entries.length > 0) await deps.store.saveSettings(actor.organizationId, patch as McpSettingsPatch, actor.userId, entries);
  return deps.store.settings(actor.organizationId);
}

/** The caller's own tokens; with `organization`, every member's, which only an owner or admin may read. */
export async function listMcpTokens(deps: Pick<McpTokenDeps, "store" | "now" | "installSendEnabled">, actor: Actor, scope: "mine" | "organization"): Promise<McpTokenListItem[]> {
  if (scope === "organization") requireAdmin(actor, "Only an owner or admin can see every member's MCP tokens.");
  const [rows, settings] = await Promise.all([deps.store.list(actor.organizationId, scope === "mine" ? actor.userId : null), deps.store.settings(actor.organizationId)]);
  const now = deps.now();
  return rows.map(({ ownerRole, policyEpoch, ...view }) => ({
    ...view,
    ...tokenAccess({ role: ownerRole, installSendEnabled: deps.installSendEnabled, settings, token: { scopes: view.scopes, policyEpoch, revokedAt: null, expiresAt: view.expiresAt }, now }),
  }));
}

/**
 * Creates a token for the caller, read-only unless `access` is `write`. A member creates a write token only while the
 * organization allows it. The answer carries the secret, which is never shown again.
 */
export async function createMcpToken(deps: McpTokenDeps, actor: Actor, input: { name: string; access?: McpTokenAccess }): Promise<McpTokenView & { token: string }> {
  const problem = mcpTokenNameProblem(input.name);
  if (problem) throw new ValidationError(problem);
  const settings = await deps.store.settings(actor.organizationId);
  if (!settings.enabled) throw new ConflictError("MCP is off in this organization. An owner or admin can turn it on.", { code: "mcp_disabled" });
  const scopes = SCOPES_OF[input.access ?? "read"];
  const refused = tokenScopesProblem({ role: actor.role, settings, scopes });
  if (refused) throw new ForbiddenError(refused);

  const now = deps.now();
  const token = deps.newSecret();
  const name = input.name.trim();
  const created = await deps.store.forMember(actor.organizationId, actor.userId, async (tx) => {
    if ((await tx.liveCount(now)) >= MCP_TOKEN_LIMIT) {
      throw new ConflictError(`You have ${MCP_TOKEN_LIMIT} live MCP tokens. Revoke one you no longer use first.`, { code: "mcp_token_limit" });
    }
    return tx.insert(
      {
        organizationId: actor.organizationId,
        userId: actor.userId,
        name,
        tokenHash: deps.hash(token),
        tokenHint: mcpTokenHint(token),
        scopes,
        policyEpoch: settings.agentSendEpoch,
        expiresAt: new Date(now.getTime() + MCP_TOKEN_DAYS * DAY_MS),
      },
      audit(actor, "mcp.token_created", undefined, { name, scopes: scopes.join(" ") }),
    );
  });
  // The session found the member a moment ago; null means a removal committed in between.
  if (!created) throw new ForbiddenError("You are no longer a member of this organization.");
  return { ...created, token };
}

/** What a person may let an app do here, highest last. Reading is always allowed while MCP is on. */
export function grantableAccess(settings: McpSettings, role: string, installSendEnabled: boolean): McpTokenAccess[] {
  return MCP_TOKEN_ACCESS.filter((access) => !tokenScopesProblem({ role, settings, scopes: SCOPES_OF[access] }) && (access !== "send" || installSendEnabled));
}

/**
 * The access levels a person may choose for an app: what the app asked for, within what this person may grant. An app
 * that names no MCP scope gets reading, the least it can do anything with. The consent page offers this list and the
 * consent route enforces it, so an edited request cannot grant more than the app asked for.
 */
export function consentChoices(settings: McpSettings, role: string, installSendEnabled: boolean, requestedScope: string): McpTokenAccess[] {
  const requested = requestedScope.split(" ");
  const asked = MCP_TOKEN_ACCESS.filter((access) => requested.includes(`mcp:${access}`));
  const allowed = grantableAccess(settings, role, installSendEnabled);
  return (asked.length > 0 ? asked : (["read"] as McpTokenAccess[])).filter((access) => allowed.includes(access));
}

/**
 * Records that a person lets an app act for them in this organization, on the same rules as creating a token. The
 * `mcp_tokens` row is what the endpoint checks on every call; agreeing again with another access level, or after a
 * revoke, updates the same row. Answers the scopes granted.
 */
export async function grantMcpAccess(deps: McpTokenDeps, actor: Actor, input: { clientId: string; clientName: string; access: McpTokenAccess }): Promise<McpScope[]> {
  const settings = await deps.store.settings(actor.organizationId);
  if (!settings.enabled) throw new ConflictError("MCP is off in this organization. An owner or admin can turn it on.", { code: "mcp_disabled" });
  const scopes = SCOPES_OF[input.access];
  const refused = tokenScopesProblem({ role: actor.role, settings, scopes });
  if (refused) throw new ForbiddenError(refused);
  const name = input.clientName.trim().slice(0, MCP_TOKEN_NAME_MAX) || "Connected app";
  const created = await deps.store.forMember(actor.organizationId, actor.userId, async (tx) => {
    await tx.upsertGrant(
      { organizationId: actor.organizationId, userId: actor.userId, name, oauthGrantId: mcpGrantId(actor.organizationId, actor.userId, input.clientId), scopes, policyEpoch: settings.agentSendEpoch },
      audit(actor, "mcp.app_connected", undefined, { name, clientId: input.clientId, scopes: scopes.join(" ") }),
    );
    return true;
  });
  if (!created) throw new ForbiddenError("You are no longer a member of this organization.");
  return scopes;
}

/** A member revokes their own tokens; an owner or admin revokes anyone's. Revoking a revoked token is a no-op. */
export async function revokeMcpToken(deps: Pick<McpTokenDeps, "store">, actor: Actor, tokenId: string): Promise<void> {
  const owner = await deps.store.owner(actor.organizationId, tokenId);
  // A member asking for someone else's token learns nothing about it.
  if (!owner || (owner.userId !== actor.userId && !isOwnerOrAdmin(actor.role))) throw new NotFoundError("Token not found");
  await deps.store.revoke(actor.organizationId, { tokenId }, audit(actor, "mcp.token_revoked", tokenId, { ownerUserId: owner.userId }));
}

/** Revokes every live token in the organization, for a suspected leak. Answers how many it revoked. */
export async function revokeAllMcpTokens(deps: Pick<McpTokenDeps, "store">, actor: Actor): Promise<{ revoked: number }> {
  requireAdmin(actor, "Only an owner or admin can revoke every MCP token.");
  return { revoked: await deps.store.revoke(actor.organizationId, "all", audit(actor, "mcp.tokens_revoked_all", undefined, {})) };
}
