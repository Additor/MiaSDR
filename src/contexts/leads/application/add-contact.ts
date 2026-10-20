import type { DbHandle } from "@/platform/db/client";
import { TRY_AGAIN } from "@/platform/db/person-locks";
import { ConflictError, ValidationError, type Actor } from "@/shared/errors";
import { renameOnCompanyPage } from "../domain/company-domain";
import { NEW_PERSON, planLeadEdit } from "../domain/lead-edit";
import type { Lifecycle, PersonEventInput } from "./convert-to-contact";

/*
 * Add contact ("Contacts and Companies CRUD" in docs/decisions.md): a person who starts at lifecycle `contact`, with
 * no detour through a lead. The use case runs in the caller's transaction, so deals' `addContactWithDeal` commits the contact
 * and its deal together. A lead or contact with the same email or LinkedIn profile answers 409 and nothing is written: the
 * client offers to make that lead a contact, which keeps the lead's own details (P7).
 */

export const MIN_CREATION_KEY = 8;
export const MAX_CREATION_KEY = 200;

export interface AddContactInput {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  /** A profile URL or a bare slug. */
  linkedinUrl?: string | null;
  title?: string | null;
  companyDomain?: string | null;
  /** Names the company when the domain is new. A different name for an existing company answers 422 (M8). */
  companyName?: string | null;
  /** One per dialog open, 8 to 200 characters. A repeat with the same key replays the first result. */
  creationKey: string;
}

/** A person who already holds the email or LinkedIn profile. */
export interface IdentityMatch {
  personId: string;
  name: string | null;
  email: string | null;
  lifecycle: Lifecycle;
  linkedinUrl: string | null;
}

export interface NewContact {
  email: string | null;
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  companyId: string | null;
  creationKey: string;
  convertedAt: Date;
}

/** The leads side of Add contact. `drizzle-contact-store.ts` implements it. */
export interface ContactStore {
  /** The person an earlier Add contact with this key created. */
  byCreationKey(tx: DbHandle, organizationId: string, key: string): Promise<string | null>;
  matchByEmail(tx: DbHandle, organizationId: string, email: string): Promise<IdentityMatch | null>;
  matchBySlug(tx: DbHandle, organizationId: string, slug: string): Promise<IdentityMatch | null>;
  /** The company of a normalized domain under the domain lock: by domain, by other domain, or a new one (`resolveCompanyDomain`). */
  resolveCompany(tx: DbHandle, organizationId: string, domain: string, input: { name: string | null }): Promise<{ companyId: string; name: string | null; domain: string; created: boolean }>;
  /** Inserts the contact; null when a unique index (email, LinkedIn, creation key) holds another row. */
  insertContact(tx: DbHandle, organizationId: string, row: NewContact): Promise<string | null>;
}

export interface AddContactDeps {
  contacts: ContactStore;
  /** Conversations `appendPersonEvent`, through the composition root. Add contact writes `contact.added`. */
  appendEvent(tx: DbHandle, input: Omit<PersonEventInput, "eventType"> & { eventType: "contact.added" }): Promise<void>;
  now?: () => Date;
}

export interface AddContactResult {
  personId: string;
  replayed: boolean;
}

const sayPerson = (match: IdentityMatch): string => {
  const name = match.name ?? match.email ?? match.linkedinUrl ?? "This person";
  return match.name && match.email ? `${name} (${match.email})` : name;
};

/** 409 `lead_exists` or `contact_exists` for the email match, else the LinkedIn match; `others` names a second person. */
function identityConflict(byEmail: IdentityMatch | null, bySlug: IdentityMatch | null): ConflictError | null {
  const match = byEmail ?? bySlug;
  if (!match) return null;
  const others = bySlug && byEmail && bySlug.personId !== byEmail.personId ? [{ personId: bySlug.personId, name: bySlug.name ?? bySlug.email, lifecycle: bySlug.lifecycle, linkedinUrl: bySlug.linkedinUrl }] : [];
  const code = match.lifecycle === "lead" ? "lead_exists" : "contact_exists";
  return new ConflictError(`${sayPerson(match)} is already a ${match.lifecycle}.`, {
    code,
    personId: match.personId,
    name: match.name,
    email: match.email,
    others,
  });
}

export function parseCreationKey(key: unknown): string {
  const value = typeof key === "string" ? key.trim() : "";
  if (value.length < MIN_CREATION_KEY || value.length > MAX_CREATION_KEY) {
    throw new ValidationError(`Send an idempotency key of ${MIN_CREATION_KEY} to ${MAX_CREATION_KEY} characters.`);
  }
  return value;
}

/**
 * Creates a contact in the caller's transaction, in the order of plan 4.3: the field plan, the replay by key, the identity match,
 * the company, the insert, the event. Errors: 422 with the field messages or "Rename {Company} on its company page."; 409
 * `lead_exists` or `contact_exists` with `{ personId, name, email, others }`.
 */
export async function addContact(deps: AddContactDeps, tx: DbHandle, actor: Actor, input: AddContactInput): Promise<AddContactResult> {
  const organizationId = actor.organizationId;
  const creationKey = parseCreationKey(input.creationKey);
  const plan = planLeadEdit(
    NEW_PERSON,
    {
      firstName: input.firstName ?? undefined,
      lastName: input.lastName ?? undefined,
      email: input.email ?? undefined,
      linkedin: input.linkedinUrl ?? undefined,
      title: input.title ?? undefined,
      companyDomain: input.companyDomain ?? undefined,
      companyName: input.companyName ?? undefined,
    },
    { mode: "create" },
  );
  if (plan.issues.length > 0) throw new ValidationError(plan.issues[0], plan.issues.map((message) => ({ message })));

  const replayed = await deps.contacts.byCreationKey(tx, organizationId, creationKey);
  if (replayed) return { personId: replayed, replayed: true };

  const email = plan.patch.email ?? null;
  const slug = plan.patch.linkedinSlug ?? null;
  const match = async () => identityConflict(email ? await deps.contacts.matchByEmail(tx, organizationId, email) : null, slug ? await deps.contacts.matchBySlug(tx, organizationId, slug) : null);
  const early = await match();
  if (early) throw early;

  let companyId: string | null = null;
  if (plan.company) {
    const company = await deps.contacts.resolveCompany(tx, organizationId, plan.company.domain, { name: plan.company.name });
    if (!company.created && plan.company.name !== null && plan.company.name !== company.name) throw new ValidationError(renameOnCompanyPage(company));
    companyId = company.companyId;
  }

  const now = deps.now?.() ?? new Date();
  const personId = await deps.contacts.insertContact(tx, organizationId, {
    email,
    linkedinSlug: slug,
    linkedinUrl: plan.patch.linkedinUrl ?? null,
    firstName: plan.patch.firstName ?? null,
    lastName: plan.patch.lastName ?? null,
    fullName: plan.patch.fullName ?? null,
    title: plan.patch.title ?? null,
    companyId,
    creationKey,
    convertedAt: now,
  });
  if (!personId) {
    // A concurrent insert won a unique index. Our own key first: that is a replay of this dialog.
    const late = await deps.contacts.byCreationKey(tx, organizationId, creationKey);
    if (late) return { personId: late, replayed: true };
    const conflict = await match();
    throw conflict ?? new ConflictError(TRY_AGAIN, { code: "try_again" });
  }

  await deps.appendEvent(tx, {
    organizationId,
    personId,
    eventType: "contact.added",
    actorType: "human",
    actorUserId: actor.userId,
    meta: companyId ? { companyId } : {},
  });
  return { personId, replayed: false };
}
