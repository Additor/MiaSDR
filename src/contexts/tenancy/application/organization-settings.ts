import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { canonicalTimeZone } from "@/shared/time-zone";
import { unknownSenderAiCapProblem } from "../domain/ai-cap";
import { normalizePhoneCountry, phoneCountryProblem } from "../domain/phone-country";
import { organizationNameProblem } from "../domain/organization";
import { parseRoles } from "../domain/roles";

export interface OrganizationView {
  id: string;
  name: string;
  /** Read-only: the slug appears in invitation links and is not renamed here. */
  slug: string;
  timeZone: string;
  /** AI jobs per day for replies from senders the organization never wrote to. */
  unknownSenderAiDailyCap: number;
  /** Country for phone numbers written without a country code, or null when unset (the DEFAULT_PHONE_COUNTRY variable applies then). */
  defaultPhoneCountry: string | null;
  createdAt: Date;
}

export interface AuditEntry {
  organizationId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  meta: Record<string, unknown>;
}

/**
 * One transaction per change: the update and its audit row commit together.
 * `timeZone` is stored on `organizations.timezone` and mirrored to the `general` channel
 * settings row that the send engine and email rules already read.
 */
export interface OrganizationStore {
  get(organizationId: string): Promise<OrganizationView | null>;
  update(organizationId: string, patch: { name?: string; timeZone?: string; unknownSenderAiDailyCap?: number; defaultPhoneCountry?: string | null }, audit: AuditEntry[], actorUserId: string): Promise<void>;
}

export interface OrganizationDeps {
  organizations: OrganizationStore;
  isValidTimeZone: (zone: string) => boolean;
}

export async function getOrganization(deps: OrganizationDeps, actor: Actor): Promise<OrganizationView> {
  const org = await deps.organizations.get(actor.organizationId);
  if (!org) throw new NotFoundError("Organization not found");
  return org;
}

/** Rename is owner-only. The time zone default is open to owners and admins, like the email rules. */
export async function updateOrganization(deps: OrganizationDeps, actor: Actor, input: { name?: string; timeZone?: string; unknownSenderAiDailyCap?: number; defaultPhoneCountry?: string | null }): Promise<OrganizationView> {
  const roles = parseRoles(actor.role);
  const isOwner = roles.includes("owner");
  const isAdmin = isOwner || roles.includes("admin");
  if (!isAdmin) throw new ForbiddenError("Only an owner or admin can change organization settings.");

  const current = await getOrganization(deps, actor);
  const patch: { name?: string; timeZone?: string; unknownSenderAiDailyCap?: number; defaultPhoneCountry?: string | null } = {};
  const audit: AuditEntry[] = [];
  const base = { organizationId: actor.organizationId, actorUserId: actor.userId, entityType: "organization", entityId: actor.organizationId };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name !== current.name) {
      if (!isOwner) throw new ForbiddenError("Only the owner can rename the organization.");
      const problem = organizationNameProblem(name);
      if (problem) throw new ValidationError(problem);
      patch.name = name;
      audit.push({ ...base, action: "organization.renamed", meta: { from: current.name, to: name } });
    }
  }
  if (input.timeZone !== undefined && input.timeZone !== current.timeZone) {
    // Legacy ICU ids (Asia/Calcutta) become the current IANA name before they are stored or compared.
    const zone = deps.isValidTimeZone(input.timeZone) ? canonicalTimeZone(input.timeZone) : null;
    if (!zone) throw new ValidationError("Unknown time zone.");
    if (zone !== current.timeZone) {
      patch.timeZone = zone;
      audit.push({ ...base, action: "organization.timezone_changed", meta: { from: current.timeZone, to: zone } });
    }
  }
  if (input.unknownSenderAiDailyCap !== undefined && input.unknownSenderAiDailyCap !== current.unknownSenderAiDailyCap) {
    const problem = unknownSenderAiCapProblem(input.unknownSenderAiDailyCap);
    if (problem) throw new ValidationError(problem);
    patch.unknownSenderAiDailyCap = input.unknownSenderAiDailyCap;
    audit.push({ ...base, action: "organization.ai_cap_changed", meta: { from: current.unknownSenderAiDailyCap, to: input.unknownSenderAiDailyCap } });
  }
  if (input.defaultPhoneCountry !== undefined) {
    const raw = input.defaultPhoneCountry ?? "";
    const problem = phoneCountryProblem(raw);
    if (problem) throw new ValidationError(problem);
    const next = normalizePhoneCountry(raw);
    if (next !== current.defaultPhoneCountry) {
      patch.defaultPhoneCountry = next;
      audit.push({ ...base, action: "organization.phone_country_changed", meta: { from: current.defaultPhoneCountry, to: next } });
    }
  }
  if (audit.length > 0) await deps.organizations.update(actor.organizationId, patch, audit, actor.userId);
  return getOrganization(deps, actor);
}
