import type { DbHandle } from "@/platform/db/client";
import { retryOnce, sqlState, TRY_AGAIN } from "@/platform/db/person-locks";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { LeadsAudit } from "./leads-audit";

/*
 * Contact delete ("Contacts and Companies CRUD" in docs/decisions.md). A contact without an open deal goes
 * with their closed deals, reply handling, conversations, messages, history, notes, tasks, enrollments and sends, in one
 * transaction. The use case owns the order of plan 4.3; each context deletes its own rows through the ports below, which the
 * composition root (`src/composition/person-lifecycle.ts`) wires. Any member can delete (P4), except that another member's
 * personal campaign or private thread with the contact needs its creator, an owner or an admin.
 */

/** The person as the delete reads it. */
export interface ContactForDelete {
  id: string;
  fullName: string | null;
  email: string | null;
  linkedinUrl: string | null;
  linkedinSlug: string | null;
  lifecycle: "lead" | "contact";
  companyId: string | null;
  /** Marked do not contact (`contact_policies`). */
  doNotContact: boolean;
  /** The email has a suppression row. */
  suppressed: boolean;
}

/** A deal of the person, open or closed. */
export interface ContactDealRef {
  id: string;
  title: string;
  stageName: string;
  stageKind: "open" | "won" | "lost";
}

export type ContactDeleteBlocker =
  | { reason: "open_deals"; deals: Array<{ id: string; title: string; stageName: string; stageKind: "open" }> }
  | { reason: "send_in_flight" }
  | { reason: "recent_send"; until: Date }
  | { reason: "recent_invite"; until: Date }
  | { reason: "ai_job_running" }
  | { reason: "private_conversation" }
  | { reason: "personal_campaign_sends" };

export interface ContactDeleteCounts {
  deals: { won: number; lost: number; wonTitles: string[] };
  notes: number;
  tasks: number;
  events: number;
  conversations: number;
  messages: number;
  campaigns: number;
  sends: number;
}

/** The counts the dialog showed, sent back with the delete. `deals` is won plus lost. */
export interface ContactDeleteExpected {
  deals: number;
  notes: number;
  tasks: number;
  events: number;
  conversations: number;
  messages: number;
  sends: number;
}

/** The leads side: the people row. `drizzle-contact-delete-store.ts` implements it. */
export interface ContactDeleteStore {
  /** The person without a lock, with the reach facts the preview states. */
  read(tx: DbHandle, organizationId: string, personId: string): Promise<ContactForDelete | null>;
  /** Step 2: the people row `FOR UPDATE`. */
  lock(tx: DbHandle, organizationId: string, personId: string): Promise<ContactForDelete | null>;
  /** `statement_timeout` for the rest of the transaction. */
  limitStatements(tx: DbHandle): Promise<void>;
  /** Step 14: deletes the people row. Notes, tasks and `lead_ccs` go with it. */
  deletePerson(tx: DbHandle, organizationId: string, personId: string): Promise<void>;
  /** Step 13 (M3): a company whose last contact went stays in Companies. */
  stampCompaniesLeftByContacts(tx: DbHandle, organizationId: string, companyIds: readonly string[]): Promise<void>;
}

/** Conversations: `person-handling.ts` and `person-purge.ts`. */
export interface ContactDeleteHandling {
  lockPersonForDelete(tx: DbHandle, organizationId: string, personId: string): Promise<void>;
  lockContactPolicy(tx: DbHandle, organizationId: string, personId: string): Promise<{ doNotContact: boolean }>;
  counts(tx: DbHandle, actor: Actor, personId: string): Promise<{ conversations: number; messages: number; events: number; notes: number; tasks: number; hidden: boolean }>;
  blockers(tx: DbHandle, actor: Actor, personId: string): Promise<Array<{ reason: "send_in_flight" | "ai_job_running" | "private_conversation" }>>;
  purge(tx: DbHandle, organizationId: string, personId: string): Promise<unknown>;
}

/** Deals: `person-deals.ts`, and a read of the person's deals for the preview. */
export interface ContactDeleteDeals {
  /** Every deal of the person, without a lock. */
  list(tx: DbHandle, organizationId: string, personId: string): Promise<ContactDealRef[]>;
  /** Step 4: every deal of the person `FOR UPDATE`. */
  lock(tx: DbHandle, organizationId: string, personId: string): Promise<ContactDealRef[]>;
  counts(tx: DbHandle, organizationId: string, personId: string): Promise<{ won: number; lost: number; wonTitles: string[] }>;
  /** Step 11. */
  deleteClosed(tx: DbHandle, organizationId: string, personId: string): Promise<unknown>;
}

/** Outreach: `person-outreach.ts`. */
export interface ContactDeleteOutreach {
  counts(tx: DbHandle, actor: Actor, personId: string): Promise<{ campaigns: number; sends: number; hidden: boolean }>;
  blockers(tx: DbHandle, actor: Actor, personId: string, now: Date): Promise<Array<{ reason: "send_in_flight" | "personal_campaign_sends" } | { reason: "recent_send" | "recent_invite"; until: Date }>>;
  /** Step 9: returns whether the email has a suppression row after the call. */
  keepEmailSuppressed(tx: DbHandle, organizationId: string, input: { email: string | null; doNotContact: boolean }): Promise<boolean>;
  /** Step 12. */
  purge(tx: DbHandle, organizationId: string, personId: string): Promise<unknown>;
}

export interface ContactDeleteDeps {
  people: ContactDeleteStore;
  handling: ContactDeleteHandling;
  deals: ContactDeleteDeals;
  outreach: ContactDeleteOutreach;
  audit: LeadsAudit;
  /** One transaction with `lock_timeout` set to `CONVERSION_LOCK_TIMEOUT`. */
  transaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T>;
  now?: () => Date;
}

export interface ContactDeletePreview {
  person: { id: string; fullName: string | null; email: string | null; linkedinUrl: string | null; doNotContact: boolean };
  counts: ContactDeleteCounts;
  blockers: ContactDeleteBlocker[];
  /** The email stays Email suppressed after the delete. */
  suppressionKept: boolean;
  /** Marked do not contact with a LinkedIn profile, which no list keeps blocked after the delete. */
  linkedinOnlyBlock: boolean;
  /** The counts leave out rows in another member's personal campaign that the actor cannot see. */
  hiddenExcluded: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The statement timeout of the delete: a contact with a long history rolls back and answers `try_again` past it. */
export const CONTACT_DELETE_STATEMENT_TIMEOUT = "30s";

export const CONTACT_GONE = "This contact no longer exists.";

/** `{Name}` of section 6: the full name, else the email, else "this contact". */
const nameOf = (person: Pick<ContactForDelete, "fullName" | "email">) => person.fullName?.trim() || person.email?.trim() || "this contact";
const Name = (person: Pick<ContactForDelete, "fullName" | "email">) => {
  const name = nameOf(person);
  return name === "this contact" ? "This contact" : name;
};

const EXPECTED_KEYS = ["deals", "notes", "tasks", "events", "conversations", "messages", "sends"] as const;

/** The counts of the dialog, as numbers or as the query's strings. 422 for a missing or non-integer count. */
export function parseDeleteExpected(raw: unknown): ContactDeleteExpected {
  const sent = (raw ?? {}) as Record<string, unknown>;
  const out = {} as ContactDeleteExpected;
  for (const key of EXPECTED_KEYS) {
    const value = typeof sent[key] === "string" && sent[key] !== "" ? Number(sent[key]) : sent[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ValidationError("Send the counts the delete dialog showed.");
    out[key] = value;
  }
  return out;
}

const openDealsBlocker = (deals: ContactDealRef[]): ContactDeleteBlocker[] => {
  const open = deals.filter((deal) => deal.stageKind === "open").map((deal) => ({ id: deal.id, title: deal.title, stageName: deal.stageName, stageKind: "open" as const }));
  return open.length > 0 ? [{ reason: "open_deals", deals: open }] : [];
};

/** Every blocker in one list: the open deals, then outreach, then conversations, without repeating `send_in_flight`. */
async function blockersOf(deps: ContactDeleteDeps, tx: DbHandle, actor: Actor, personId: string, deals: ContactDealRef[], now: Date): Promise<ContactDeleteBlocker[]> {
  const outreach = await deps.outreach.blockers(tx, actor, personId, now);
  const handling = await deps.handling.blockers(tx, actor, personId);
  const all: ContactDeleteBlocker[] = [...openDealsBlocker(deals), ...outreach, ...handling];
  return all.filter((blocker, index) => blocker.reason !== "send_in_flight" || all.findIndex((b) => b.reason === "send_in_flight") === index);
}

async function countsOf(deps: ContactDeleteDeps, tx: DbHandle, actor: Actor, personId: string): Promise<{ counts: ContactDeleteCounts; hidden: boolean }> {
  const deals = await deps.deals.counts(tx, actor.organizationId, personId);
  const handling = await deps.handling.counts(tx, actor, personId);
  const outreach = await deps.outreach.counts(tx, actor, personId);
  return {
    counts: {
      deals,
      notes: handling.notes,
      tasks: handling.tasks,
      events: handling.events,
      conversations: handling.conversations,
      messages: handling.messages,
      campaigns: outreach.campaigns,
      sends: outreach.sends,
    },
    hidden: handling.hidden || outreach.hidden,
  };
}

const flatten = (counts: ContactDeleteCounts): ContactDeleteExpected => ({
  deals: counts.deals.won + counts.deals.lost,
  notes: counts.notes,
  tasks: counts.tasks,
  events: counts.events,
  conversations: counts.conversations,
  messages: counts.messages,
  sends: counts.sends,
});

function checkPerson(person: ContactForDelete | null): ContactForDelete {
  if (!person) throw new NotFoundError(CONTACT_GONE);
  if (person.lifecycle !== "contact") throw new ConflictError(`${Name(person)} is a lead. Delete leads from the lead page.`, { code: "not_a_contact" });
  return person;
}

/**
 * What a delete of the contact would remove and what blocks it, as the actor may see it. The contact page states it before
 * any click, and the dialog shows its counts. 404 for a person outside the organization; 409 `not_a_contact` for a lead.
 */
export async function previewContactDelete(deps: ContactDeleteDeps, actor: Actor, personId: string): Promise<ContactDeletePreview> {
  if (!UUID.test(personId)) throw new NotFoundError(CONTACT_GONE);
  const organizationId = actor.organizationId;
  const now = deps.now?.() ?? new Date();
  return deps.transaction(async (tx) => {
    const person = checkPerson(await deps.people.read(tx, organizationId, personId));
    const deals = await deps.deals.list(tx, organizationId, personId);
    const blockers = await blockersOf(deps, tx, actor, personId, deals, now);
    const { counts, hidden } = await countsOf(deps, tx, actor, personId);
    return {
      person: { id: person.id, fullName: person.fullName, email: person.email, linkedinUrl: person.linkedinUrl, doNotContact: person.doNotContact },
      counts,
      blockers,
      suppressionKept: Boolean(person.email?.trim()) && (person.suppressed || person.doNotContact),
      linkedinOnlyBlock: person.doNotContact && Boolean(person.linkedinUrl || person.linkedinSlug),
      hiddenExcluded: hidden,
    };
  });
}

/**
 * Deletes a contact in the order of plan 4.3, under the person's locks: records and their conversations, the outreach advisory
 * lock, the people row, the do not contact row and the deals. 404 when the person is gone; 409 `not_a_contact`; 409
 * `contact_blocked { blockers }`; 409 `counts_changed { counts }` when the counts differ from what the dialog showed; 409
 * `try_again` after one retry on a lock error, or past the statement timeout.
 */
export async function deleteContact(deps: ContactDeleteDeps, actor: Actor, personId: string, input: { expected: unknown }): Promise<{ deleted: ContactDeleteCounts }> {
  if (!UUID.test(personId)) throw new NotFoundError(CONTACT_GONE);
  const expected = parseDeleteExpected(input.expected);
  const organizationId = actor.organizationId;
  try {
    return await retryOnce(() =>
      deps.transaction(async (tx) => {
        await deps.people.limitStatements(tx);
        await deps.handling.lockPersonForDelete(tx, organizationId, personId);
        const person = checkPerson(await deps.people.lock(tx, organizationId, personId));
        const { doNotContact } = await deps.handling.lockContactPolicy(tx, organizationId, personId);
        const deals = await deps.deals.lock(tx, organizationId, personId);
        const blockers = await blockersOf(deps, tx, actor, personId, deals, deps.now?.() ?? new Date());
        if (blockers.length > 0) throw new ConflictError("This contact cannot be deleted.", { code: "contact_blocked", blockers });

        const { counts } = await countsOf(deps, tx, actor, personId);
        const now = flatten(counts);
        if (EXPECTED_KEYS.some((key) => now[key] !== expected[key])) {
          throw new ConflictError(`${Name(person)} changed while this was open. Check the new counts and confirm again.`, { code: "counts_changed", counts });
        }

        const suppressionKept = await deps.outreach.keepEmailSuppressed(tx, organizationId, { email: person.email, doNotContact });
        await deps.handling.purge(tx, organizationId, personId);
        await deps.deals.deleteClosed(tx, organizationId, personId);
        await deps.outreach.purge(tx, organizationId, personId);
        await deps.people.deletePerson(tx, organizationId, personId);
        // The stamp reads "no contact left", so it runs once the person is gone.
        if (person.companyId) await deps.people.stampCompaniesLeftByContacts(tx, organizationId, [person.companyId]);
        await deps.audit.record(tx, {
          organizationId,
          actorUserId: actor.userId,
          action: "person.deleted",
          entityType: "person",
          entityId: personId,
          meta: { lifecycle: "contact", counts: { ...counts, deals: { won: counts.deals.won, lost: counts.deals.lost } }, suppressionKept },
        });
        return { deleted: counts };
      }),
    );
  } catch (error) {
    // 57014: the statement timeout rolled the delete back. A second run would meet the same size, so it is not retried.
    if (sqlState(error) === "57014") throw new ConflictError(TRY_AGAIN, { code: "try_again" });
    throw error;
  }
}
