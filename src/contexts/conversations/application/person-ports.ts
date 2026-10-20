import type { DbHandle } from "@/platform/db/client";

/**
 * What other contexts call on reply handling when a lead becomes a contact ("Leads and CRM" in docs/decisions.md). The functions are callee-owned: conversations owns the records, runs, drafts and events they touch, and the
 * caller passes its transaction so the whole conversion commits or rolls back together. The implementations live in
 * infrastructure/person-handling.ts.
 */

export type PersonChannel = "email" | "linkedin" | "whatsapp";

/** What ending a person's follow-up runs changes: runs ended and unsent drafts retired. */
export interface PersonRunStop {
  runs: number;
  drafts: number;
}

export interface PersonEventInput {
  organizationId: string;
  personId: string;
  /** Null or absent for an event about the person that no reply record owns. */
  recordId?: string | null;
  eventType: string;
  actorType: "ai" | "human" | "system" | "integration";
  /** Required for a human actor. */
  actorUserId?: string | null;
  fromData?: unknown;
  toData?: unknown;
  meta?: unknown;
}

export interface PersonEventView {
  id: string;
  eventType: string;
  actorType: string;
  createdAt: Date;
  recordId: string | null;
  meta: unknown;
  fromData: unknown;
  toData: unknown;
}

export interface PersonReplyHandling {
  /** Locks the person's records in id order, then the person's outreach advisory lock. Call it first in the transaction. */
  lockPersonRecords(tx: DbHandle, organizationId: string, personId: string): Promise<void>;
  /** The records half of `lockPersonRecords`, for a caller that changes its lock timeout between the two. Returns the rows locked. */
  lockPersonRecordRows(tx: DbHandle, organizationId: string, personId: string): Promise<number>;
  /** Ends the person's active and paused runs. `drafts` counts the unsent drafts the same statements retired. */
  interruptPersonRuns(tx: DbHandle, input: { organizationId: string; personId: string; reason: "converted"; now: Date }): Promise<PersonRunStop>;
  /** What `interruptPersonRuns` would change now, per person. Writes nothing. Every requested id has an entry. */
  previewPersonRunStop(organizationId: string, personIds: string[]): Promise<Map<string, PersonRunStop>>;
  appendPersonEvent(tx: DbHandle, input: PersonEventInput): Promise<void>;
  /** The public conversation of the person's active channel, else the most recently updated one. Null when the person has none or only personal-campaign threads. */
  activeConversationOfPerson(organizationId: string, personId: string): Promise<{ conversationId: string; channel: PersonChannel } | null>;
  /** Newest first. Events without a record, plus events of records that have a public conversation or none. */
  listPersonEvents(organizationId: string, personId: string, limit: number): Promise<PersonEventView[]>;
}
