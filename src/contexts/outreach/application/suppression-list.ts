import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { SuppressionStore } from "../email/application/unsubscribe";

export type SuppressionReason = "unsubscribed" | "bounced" | "manual" | "complaint";

export interface SuppressionRow {
  id: string;
  email: string;
  reason: SuppressionReason;
  note: string | null;
  createdAt: Date;
}

/** Port. Reads and trims the organization's suppression list. Adding goes through `SuppressionStore.suppressEmail`. */
export interface SuppressionListStore {
  list(organizationId: string, query: { q: string | null; limit: number; offset: number }): Promise<{ rows: SuppressionRow[]; total: number }>;
  existing(organizationId: string, emails: readonly string[]): Promise<Set<string>>;
  find(organizationId: string, id: string): Promise<SuppressionRow | null>;
  remove(organizationId: string, id: string): Promise<void>;
  audit(entry: { organizationId: string; actorUserId: string; action: string; entityId: string | null; meta: Record<string, unknown> }): Promise<void>;
}

export interface SuppressionListDeps {
  list: SuppressionListStore;
  suppress: SuppressionStore;
}

export const MAX_SUPPRESSIONS_PER_ADD = 500;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAdmin(actor: Actor): void {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can change the suppression list.");
}

/** Splits pasted text on commas, semicolons, spaces and line breaks, lowercases each address and drops repeats. */
export function parseSuppressionInput(text: string): { emails: string[]; invalid: string[] } {
  const emails = new Set<string>();
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (EMAIL.test(value)) emails.add(value);
    else invalid.push(part.trim());
  }
  return { emails: [...emails], invalid };
}

/** Any member reads the list: it explains why a lead's email is blocked. */
export function listSuppressions(deps: SuppressionListDeps, actor: Actor, query: { q?: string | null; limit: number; offset: number }) {
  const q = query.q?.trim().toLowerCase() || null;
  return deps.list.list(actor.organizationId, { q, limit: query.limit, offset: query.offset });
}

/**
 * Adds addresses by hand (reason `manual`). Each one stops its unfinished email sequences, as a suppression from the
 * Inbox does. An address already on the list keeps its first reason.
 */
export async function addSuppressions(deps: SuppressionListDeps, actor: Actor, input: { text: string; note?: string | null }): Promise<{ added: number; alreadyListed: number; stopped: number }> {
  requireAdmin(actor);
  const { emails, invalid } = parseSuppressionInput(input.text);
  if (invalid.length > 0) throw new ValidationError(`Not an email address: ${invalid.slice(0, 3).join(", ")}${invalid.length > 3 ? ` and ${invalid.length - 3} more` : ""}.`);
  if (emails.length === 0) throw new ValidationError("Enter at least one email address.");
  if (emails.length > MAX_SUPPRESSIONS_PER_ADD) throw new ValidationError(`Add up to ${MAX_SUPPRESSIONS_PER_ADD} addresses at a time.`);
  const note = input.note?.trim() || null;
  if (note && note.length > 500) throw new ValidationError("The note is up to 500 characters.");
  const listed = await deps.list.existing(actor.organizationId, emails);
  let stopped = 0;
  for (const email of emails) {
    if (listed.has(email)) continue;
    stopped += (await deps.suppress.suppressEmail({ organizationId: actor.organizationId, email, reason: "manual", note: note ?? undefined })).stopped;
  }
  const added = emails.length - listed.size;
  if (added > 0) await deps.list.audit({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "suppression.added", entityId: null, meta: { count: added, stopped } });
  return { added, alreadyListed: listed.size, stopped };
}

/**
 * Removes an address someone added by hand. Unsubscribes, complaints and bounces stay: the person asked, or the address
 * does not exist. Removing revives nothing; a stopped sequence stays stopped.
 */
export async function removeSuppression(deps: SuppressionListDeps, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  if (!UUID.test(id)) throw new NotFoundError("Address not found");
  const row = await deps.list.find(actor.organizationId, id);
  if (!row) throw new NotFoundError("Address not found");
  if (row.reason !== "manual") throw new ConflictError("Only an address added by hand can be removed. Unsubscribes, complaints and bounces stay on the list.");
  await deps.list.remove(actor.organizationId, id);
  await deps.list.audit({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "suppression.removed", entityId: id, meta: { email: row.email } });
}
