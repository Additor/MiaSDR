import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { normalizeEmail } from "@/contexts/people/domain/normalize";
import { canonicalTimeZone } from "@/shared/time-zone";
import { type WorkingHours } from "../../domain/working-hours";
import type { MailboxProvider } from "./ports";
import type { MailboxRecord, MailboxStore } from "../../application/management-ports";

/**
 * The service account can impersonate every address in the Workspace domain, so which addresses a tenant
 * may connect is an operator decision. `allowedDomains` null means the operator set no list.
 */
export interface MailboxDomainPolicy {
  allowedDomains: string[] | null;
  /** True when anyone can create an organization (AUTH_SIGNUP=open). */
  openSignup: boolean;
}

export interface MailboxDeps {
  mailboxes: MailboxStore;
  provider: MailboxProvider;
  now: () => Date;
  policy: MailboxDomainPolicy;
}

/** Parses the MAILBOX_ALLOWED_DOMAINS value: comma list, case-insensitive, leading "@" tolerated. Empty means unset. */
export function parseAllowedDomains(raw: string | undefined): string[] | null {
  const list = (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/** Returns why this address cannot be connected, or null when it can. */
export function mailboxPolicyViolation(policy: MailboxDomainPolicy, emailAddress: string): string | null {
  const domain = emailAddress.slice(emailAddress.lastIndexOf("@") + 1).toLowerCase();
  if (policy.allowedDomains) {
    return policy.allowedDomains.includes(domain)
      ? null
      : `${domain} is not an allowed mailbox domain. Allowed: ${policy.allowedDomains.join(", ")}.`;
  }
  if (policy.openSignup) {
    return "This instance allows open sign-up, so mailboxes cannot be connected until the operator sets MAILBOX_ALLOWED_DOMAINS to the domains tenants may use.";
  }
  return null;
}

/** Connected accounts send as the organization, so only owners and admins manage them. */
function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can manage mailboxes.");
}

async function load(deps: MailboxDeps, actor: Actor, id: string): Promise<MailboxRecord> {
  const mailbox = await deps.mailboxes.get(actor.organizationId, id);
  if (!mailbox) throw new NotFoundError("Mailbox not found");
  return mailbox;
}

export function listMailboxes(deps: MailboxDeps, actor: Actor) {
  return deps.mailboxes.list(actor.organizationId, deps.now());
}

async function verifyAndRecord(deps: MailboxDeps, actor: Actor, id: string, emailAddress: string) {
  try {
    const violation = mailboxPolicyViolation(deps.policy, emailAddress);
    if (violation) throw new Error(violation);
    await deps.provider.verify(emailAddress);
    await deps.mailboxes.setStatus(actor.organizationId, id, "connected", null, deps.now());
  } catch (error) {
    await deps.mailboxes.setStatus(actor.organizationId, id, "failed", error instanceof Error ? error.message : "Could not verify this mailbox.", deps.now());
  }
}

export async function connectMailbox(deps: MailboxDeps, actor: Actor, input: { emailAddress: string; displayName?: string }): Promise<{ id: string }> {
  requireAdmin(actor);
  const emailAddress = normalizeEmail(input.emailAddress);
  if (!emailAddress) throw new ValidationError("Enter a valid email address.");
  const violation = mailboxPolicyViolation(deps.policy, emailAddress);
  if (violation) throw new ValidationError(violation);
  const id = await deps.mailboxes.insert(actor.organizationId, { emailAddress, displayName: input.displayName?.trim() || null });
  await verifyAndRecord(deps, actor, id, emailAddress);
  return { id };
}

export async function retestMailbox(deps: MailboxDeps, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  const mailbox = await load(deps, actor, id);
  await verifyAndRecord(deps, actor, id, mailbox.emailAddress);
}

export interface MailboxSettings {
  displayName?: string | null;
  dailySendLimit?: number;
  signatureHtml?: string | null;
  workingHours?: WorkingHours | null;
}

export async function updateMailbox(deps: MailboxDeps, actor: Actor, id: string, settings: MailboxSettings): Promise<void> {
  requireAdmin(actor);
  await load(deps, actor, id);
  if (settings.dailySendLimit !== undefined && (!Number.isInteger(settings.dailySendLimit) || settings.dailySendLimit < 1 || settings.dailySendLimit > 200)) {
    throw new ValidationError("The daily limit is a whole number from 1 to 200.");
  }
  if (settings.workingHours) {
    const zone = canonicalTimeZone(settings.workingHours.timeZone);
    if (!zone) throw new ValidationError("Unknown time zone.");
    const hours = { ...settings.workingHours, timeZone: zone };
    settings = { ...settings, workingHours: hours };
    for (const windows of Object.values(hours.days)) {
      for (const w of windows) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)) {
          throw new ValidationError("Times must look like 09:00.");
        }
      }
    }
  }
  await deps.mailboxes.update(actor.organizationId, id, settings);
}

export async function setMailboxEnabled(deps: MailboxDeps, actor: Actor, id: string, enabled: boolean): Promise<void> {
  requireAdmin(actor);
  const mailbox = await load(deps, actor, id);
  if (!enabled) await deps.mailboxes.setStatus(actor.organizationId, id, "disabled", null, mailbox.lastTestedAt);
  else await verifyAndRecord(deps, actor, id, mailbox.emailAddress);
}

export async function removeMailbox(deps: MailboxDeps, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  await load(deps, actor, id);
  const active = await deps.mailboxes.activeEnrollmentCount(actor.organizationId, id);
  if (active > 0) {
    throw new ConflictError(`${active} lead${active === 1 ? " is" : "s are"} still in a sequence from this mailbox. Disable it instead, or finish those sequences first.`);
  }
  // Deleting the mailbox cascades its campaign_senders rows. For a campaign it was the only sender of, that empties the list and opens the campaign to every mailbox.
  const sole = await deps.mailboxes.soleSenderCampaigns(actor.organizationId, id);
  if (sole.length > 0) {
    throw new ConflictError(`This mailbox is the only sender assigned to ${sole.length === 1 ? "campaign" : "campaigns"} ${sole.slice(0, 3).map((n) => `"${n}"`).join(", ")}${sole.length > 3 ? ` and ${sole.length - 3} more` : ""}. Assign another mailbox to ${sole.length === 1 ? "it" : "them"} or complete ${sole.length === 1 ? "it" : "them"} first.`);
  }
  await deps.mailboxes.delete(actor.organizationId, id);
}
