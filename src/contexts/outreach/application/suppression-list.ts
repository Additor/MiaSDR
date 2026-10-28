import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { SuppressionStore } from "../email/application/unsubscribe";

import type { SuppressionReason } from "@/contexts/people/domain/reachability";
export type { SuppressionReason };

export interface SuppressionRow {
  id: string;
  email: string;
  reason: SuppressionReason;
  note: string | null;
  /** Pasted on Settings, Suppression list. Only these rows can be removed there. */
  addedInSettings: boolean;
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
const SUPPRESS_CONCURRENCY = 8;
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
  const fresh = emails.filter((email) => !listed.has(email));
  // Each address is its own short transaction, as from the Inbox. A few run at once so 500 do not queue one by one;
  // different addresses lock different enrollments.
  let stopped = 0;
  let added = 0;
  for (let i = 0; i < fresh.length; i += SUPPRESS_CONCURRENCY) {
    const results = await Promise.all(
      fresh.slice(i, i + SUPPRESS_CONCURRENCY).map((email) => deps.suppress.suppressEmail({ organizationId: actor.organizationId, email, reason: "manual", note: note ?? undefined, addedInSettings: true })),
    );
    for (const result of results) {
      stopped += result.stopped;
      // An unsubscribe that landed after the check above keeps its row and its reason; it does not count as added here.
      if (result.added) added += 1;
    }
  }
  if (added > 0) await deps.list.audit({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "suppression.added", entityId: null, meta: { count: added, stopped } });
  return { added, alreadyListed: emails.length - added, stopped };
}

/**
 * Removes an address an owner or admin pasted on this page. Everything else stays: unsubscribes, complaints and bounces,
 * and the `manual` rows that a stop request or the deletion of a person marked do not contact wrote, because there a
 * person asked not to be contacted. Removing revives nothing; a stopped sequence stays stopped.
 */
export async function removeSuppression(deps: SuppressionListDeps, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  if (!UUID.test(id)) throw new NotFoundError("Address not found");
  const row = await deps.list.find(actor.organizationId, id);
  if (!row) throw new NotFoundError("Address not found");
  if (!row.addedInSettings) throw new ConflictError("Only an address added on this page can be removed. Unsubscribes, stop requests, complaints and bounces stay on the list.");
  await deps.list.remove(actor.organizationId, id);
  await deps.list.audit({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "suppression.removed", entityId: id, meta: { email: row.email } });
}
