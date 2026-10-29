import type { DbHandle } from "@/platform/db/client";
import type { Actor } from "@/shared/errors";
import type { LeadCurrent, LeadEditPlan } from "../domain/lead-edit";
import type { LeadFilter } from "../domain/lead-filter";
import type { BlockReason, LeadOutreachBlocker } from "../domain/person-delete-policy";

export type { BlockReason, LeadFilter, LeadOutreachBlocker };

export interface LeadDetail {
  person: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    email: string | null;
    phone: string | null;
    linkedinSlug: string | null;
    /** Canonical profile URL, or another LinkedIn page kept as imported. */
    linkedinUrl: string | null;
    title: string | null;
    companyName: string | null;
    companyDomain: string | null;
    custom: Record<string, unknown>;
    /** Unmapped import columns of the person. Null when the lead never came from an import. */
    raw: Record<string, unknown> | null;
    /** Unmapped import columns of the company. */
    companyRaw: Record<string, unknown> | null;
    source: string | null;
    /** `lead` or `contact`. The lead page redirects a contact to its CRM page. */
    lifecycle: string;
    /** Set once, when the person became a contact. */
    convertedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  /** Custom field definitions of the organization (not archived), for labels. */
  customColumns: Array<{ key: string; name: string }>;
  policy: { doNotContact: boolean; reason: string | null; source: string | null; setAt: Date | null; clearedAt: Date | null } | null;
  /** The address is on the organization's suppression list (unsubscribed, bounced, manual, complaint). */
  suppression: { reason: string; note: string | null; createdAt: Date } | null;
  enrollments: Array<{
    id: string;
    campaignId: string;
    campaignName: string;
    campaignStatus: string;
    channel: string;
    status: string;
    currentStep: number;
    nextSendAt: Date | null;
    lastSentAt: Date | null;
    stopReason: string | null;
  }>;
  /** The newest Inbox conversation with this lead, or null when none exists. Private (personal campaign) threads never count. */
  conversationId: string | null;
  /**
   * Campaign sends in personal campaigns the viewer may see (their own, or any for an owner or admin) and every regular campaign
   * send. A send in another member's personal campaign stays out.
   */
  sends: Array<{
    id: string;
    campaignId: string;
    campaignName: string;
    /** Null for sends that belong to no sequence step, such as a mailbox test. */
    stepNumber: number | null;
    channel: string;
    status: string;
    subject: string | null;
    sentAt: Date | null;
    claimedAt: Date;
    error: string | null;
  }>;
  /** True when another member's personal campaign sent to this lead, so `sends` leaves those sends out. */
  hiddenSends: boolean;
}

/** Who reads sends: the actor, and whether they see every personal campaign (owner or admin). */
export interface SendViewer {
  userId: string;
  seesAllPersonal: boolean;
}

/** The part of the lead detail that other contexts' tables hold: enrollments, sends, the Inbox conversation. */
export type LeadDetailActivity = Pick<LeadDetail, "enrollments" | "conversationId" | "sends" | "hiddenSends">;

/** Reads `LeadDetailActivity` for one person in the organization. `src/composition/leads.ts` passes the read model's reader. */
export type ReadLeadDetailActivity = (organizationId: string, personId: string, viewer: SendViewer | undefined) => Promise<LeadDetailActivity>;

export interface BlockedLead {
  id: string;
  name: string | null;
  reason: BlockReason;
}

export interface DeleteOutcome {
  deleted: number;
  blocked: BlockedLead[];
}

export interface ExportRow {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  doNotContact: boolean;
  /** `lead` or `contact`. */
  lifecycle: string;
  source: string | null;
  createdAt: Date;
  custom: Record<string, unknown>;
  raw: Record<string, unknown> | null;
}

export interface LeadRepository {
  /** Without a viewer, the sends list regular campaigns only. */
  get(organizationId: string, id: string, viewer?: SendViewer): Promise<LeadDetail | null>;
  /**
   * Loads the lead under a row lock, asks `plan` what to write, and writes it in
   * the same transaction. Throws NotFoundError for another organization's id and
   * ConflictError when the email or LinkedIn profile belongs to another lead.
   * `plan` runs twice (labels before the row lock, values under it), so it must be pure.
   * A new field label that matches an archived column restores it only with `restoreArchived`;
   * otherwise the edit fails with ConflictError.
   */
  update(
    organizationId: string,
    id: string,
    plan: (current: LeadCurrent & { custom: Record<string, unknown> }) => LeadEditPlan,
    options?: { restoreArchived?: boolean },
  ): Promise<void>;
  count(organizationId: string, filter: LeadFilter): Promise<number>;
  /** Ids of the leads that match the filter, newest first, up to `limit`. */
  matchingIds(organizationId: string, filter: LeadFilter, limit: number): Promise<string[]>;
  customColumns(organizationId: string): Promise<Array<{ key: string; name: string }>>;
  /**
   * Copies raw[rawKey] of every lead in the organization into custom[customKey]
   * (text), keeping the raw key. Never overwrites a value the lead already has
   * unless `overwrite` is set. Returns how many leads gained or changed a value.
   */
  mapRawToCustom(organizationId: string, input: { rawKey: string; customKey: string; overwrite: boolean }): Promise<number>;
  /** The raw keys in use with the number of leads that have each, most common first. */
  rawKeyStats(organizationId: string): Promise<Array<{ key: string; leads: number }>>;
  /** Creates the custom column when it does not exist; returns the key. */
  ensureCustomColumn(organizationId: string, name: string, options?: { restoreArchived?: boolean }): Promise<{ key: string; name: string }>;
  /** Batches of rows in a stable order, so a long export never loads the whole table. */
  exportBatches(organizationId: string, filter: LeadFilter): AsyncIterable<ExportRow[]>;
}

export interface LeadDeps {
  leads: LeadRepository;
  /** The organization's country for phone numbers written without a country code (setting, then environment fallback). */
  defaultPhoneCountry?: (organizationId: string) => Promise<string | undefined>;
}

/** A person as the lead delete reads it. */
export interface LeadForDelete {
  id: string;
  /** The full name, else the email. */
  name: string | null;
  contact: boolean;
}

/** The people side of the lead delete. `drizzle-lead-repository.ts` implements it. Every method filters by organization. */
export interface LeadDeleteStore {
  /** Ids of the people that match the filter, for a delete by filter. */
  idsMatching(organizationId: string, filter: LeadFilter): Promise<string[]>;
  /** `statement_timeout` for the rest of the transaction. */
  limitStatements(tx: DbHandle): Promise<void>;
  /** The people of the organization among `ids`, without a lock. */
  read(tx: DbHandle, organizationId: string, ids: readonly string[]): Promise<LeadForDelete[]>;
  /**
   * The outreach advisory lock of every id in one statement, then `HELD_LOCK_TIMEOUT`, then the people rows `FOR UPDATE` in
   * id order. Ids of another organization or of a deleted person drop out.
   */
  lock(tx: DbHandle, organizationId: string, ids: readonly string[]): Promise<LeadForDelete[]>;
  /** A person marked do not contact leaves their address on the suppression list. */
  keepSuppressed(tx: DbHandle, organizationId: string, ids: readonly string[]): Promise<void>;
  /** Deletes the do not contact rows and the people rows. Returns how many people went. */
  deletePeople(tx: DbHandle, organizationId: string, ids: readonly string[]): Promise<number>;
}

/** Outreach: `person-outreach.ts`. */
export interface LeadDeleteOutreach {
  /** The enrollments of these people `FOR UPDATE` in id order, so no send claim lands between the check and the purge. */
  lockEnrollments(tx: DbHandle, organizationId: string, ids: readonly string[]): Promise<unknown>;
  /** The outreach blockers of each person, as the actor may see them. A person without one is left out. */
  blockers(tx: DbHandle, actor: Actor, ids: readonly string[]): Promise<Map<string, LeadOutreachBlocker[]>>;
  /** Deletes the failed sends of these people, then their enrollments. */
  purge(tx: DbHandle, organizationId: string, ids: readonly string[]): Promise<unknown>;
}

/** Conversations: `person-handling.ts`. */
export interface LeadDeleteHandling {
  /** The people among `ids` with a reply-handling record or an event. */
  peopleWithHistory(tx: DbHandle, organizationId: string, ids: readonly string[]): Promise<Set<string>>;
}

/** The lead delete and its check. `src/composition/person-lifecycle.ts` wires it. */
export interface LeadDeleteDeps {
  leads: Pick<LeadRepository, "count">;
  people: LeadDeleteStore;
  outreach: LeadDeleteOutreach;
  handling: LeadDeleteHandling;
  /** One transaction with `lock_timeout` set to `CONVERSION_LOCK_TIMEOUT`. */
  transaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T>;
}
