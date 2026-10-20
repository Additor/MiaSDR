import type { LeadCurrent, LeadEditPlan } from "../domain/lead-edit";
import type { LeadFilter } from "../domain/lead-filter";

export type { LeadFilter };

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

/** `has_hidden_sends`: `has_sends` where every send is in a personal campaign of another member, which the viewer cannot see. */
export type BlockReason = "has_sends" | "has_hidden_sends" | "in_active_campaign" | "linked_records";

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
  /**
   * The rule that stops this lead from being deleted, or null when it qualifies. The same check the delete runs. The viewer only
   * picks between `has_sends` and `has_hidden_sends`; it never lets a delete through.
   */
  deleteBlock(organizationId: string, id: string, viewer?: SendViewer): Promise<BlockReason | null>;
  deleteByIds(organizationId: string, ids: string[], viewer?: SendViewer): Promise<DeleteOutcome>;
  deleteByFilter(organizationId: string, filter: LeadFilter, viewer?: SendViewer): Promise<DeleteOutcome>;
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
