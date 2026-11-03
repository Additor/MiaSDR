
/**
 * What other contexts call on reply handling when a lead becomes a contact ("Leads and CRM" in docs/decisions.md). The functions are callee-owned: conversations owns the conversations, runs, drafts and events they touch, and the
 * caller passes its transaction so the whole conversion commits or rolls back together. The implementations and their
 * contracts live in infrastructure/person-handling.ts.
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
  /** Null or absent for an event about the person that no conversation owns. */
  conversationId?: string | null;
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
  conversationId: string | null;
  meta: unknown;
  fromData: unknown;
  toData: unknown;
}
