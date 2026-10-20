import type { DbHandle } from "@/platform/db/client";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";

/*
 * Lead to contact, the one transition the leads context owns ("Leads and CRM" in docs/decisions.md).
 *
 * The use case runs against ports this file declares. Outreach and conversations own the rows the conversion stops, so
 * their functions arrive through the composition root (the deals context wires them), not through an import. The caller
 * owns the transaction: the conversion and the deal that follows it commit together or not at all.
 */

export type Lifecycle = "lead" | "contact";

/** The leads side of the transition: the `people.lifecycle` read and write. `drizzle-lead-lifecycle.ts` implements it. */
export interface LeadLifecycleStore {
  /** The person's lifecycle, or null when the person is not in the organization. */
  lifecycleOf(tx: DbHandle, organizationId: string, personId: string): Promise<Lifecycle | null>;
  /** Lifecycle of each id that exists in the organization. An unknown id has no entry. */
  lifecycles(organizationId: string, personIds: readonly string[]): Promise<Map<string, Lifecycle>>;
  /** One update sets `lifecycle` and `converted_at`. Idempotent: false when the person is already a contact (no row changed). */
  markConverted(tx: DbHandle, organizationId: string, personId: string, at: Date): Promise<boolean>;
}

export interface PersonStopInput {
  organizationId: string;
  personId: string;
  reason: "converted";
  now: Date;
}

export interface PersonEventInput {
  organizationId: string;
  personId: string;
  eventType: "lifecycle.converted";
  actorType: "human" | "system";
  /** Set for a human actor (`events_human_user_ck`). */
  actorUserId: string | null;
  meta: Record<string, unknown>;
}

/** What the conversion writes through other contexts. All of them run in the caller's transaction. */
export interface ConversionPorts {
  /** Locks the person's records `FOR UPDATE` in id order, then the person advisory lock (conversations `lockPersonRecords`). */
  lockPerson(tx: DbHandle, organizationId: string, personId: string): Promise<void>;
  /** Cancels the person's pending and active enrollments with reason `converted` (outreach). */
  stopEnrollments(tx: DbHandle, input: PersonStopInput): Promise<{ stopped: number }>;
  /** Interrupts the person's active and paused follow-up runs and retires their unsent drafts (conversations). Counted in the transaction. */
  interruptRuns(tx: DbHandle, input: PersonStopInput): Promise<{ runs: number; drafts: number }>;
  /** Appends a row to the person's history (conversations `appendPersonEvent`; the record is null). */
  appendEvent(tx: DbHandle, input: PersonEventInput): Promise<void>;
}

export type ConvertDeps = Pick<LeadLifecycleStore, "lifecycleOf" | "markConverted"> & ConversionPorts;

export interface ConvertInput {
  organizationId: string;
  personId: string;
  /** Why the person converts, kept in the event ("deal_created"). */
  reason: string;
  /** The person who acts. Null for a system caller. */
  actorUserId: string | null;
  now?: Date;
  /**
   * The caller's last check, run under the person's locks after the lifecycle re-read and before anything changes. A throw
   * aborts the conversion. Deals passes the personal-campaign rule here, so an enrollment that committed before the locks counts.
   */
  guard?: (tx: DbHandle) => Promise<void>;
}

export interface ConvertResult {
  /** False for a person who was already a contact. Nothing else changed then. */
  changed: boolean;
  stopped: { enrollments: number; runs: number; drafts: number };
}

const NOTHING_STOPPED = { enrollments: 0, runs: 0, drafts: 0 };

/**
 * Converts one lead, in the order the lock rules need: person lock, lifecycle re-read, the caller's guard, `markConverted`,
 * enrollments, runs, event. Lock order per person is records, advisory lock, people row, enrollments, runs, as the conversations paths take
 * it. The caller runs it inside one transaction (with `lock_timeout` and one retry on 40P01 or 55P03), so any throw undoes
 * every step. Idempotent: a contact returns `changed: false`.
 */
export async function convertToContact(deps: ConvertDeps, tx: DbHandle, input: ConvertInput): Promise<ConvertResult> {
  const { organizationId, personId } = input;
  const now = input.now ?? new Date();
  await deps.lockPerson(tx, organizationId, personId);
  const lifecycle = await deps.lifecycleOf(tx, organizationId, personId);
  if (lifecycle === null) throw new NotFoundError("Lead not found");
  if (lifecycle === "contact") return { changed: false, stopped: NOTHING_STOPPED };
  if (input.guard) await input.guard(tx);
  if (!(await deps.markConverted(tx, organizationId, personId, now))) return { changed: false, stopped: NOTHING_STOPPED };
  const stop: PersonStopInput = { organizationId, personId, reason: "converted", now };
  const { stopped: enrollments } = await deps.stopEnrollments(tx, stop);
  const { runs, drafts } = await deps.interruptRuns(tx, stop);
  await deps.appendEvent(tx, {
    organizationId,
    personId,
    eventType: "lifecycle.converted",
    actorType: input.actorUserId ? "human" : "system",
    actorUserId: input.actorUserId,
    meta: { reason: input.reason, stopped: { enrollments, runs, drafts } },
  });
  return { changed: true, stopped: { enrollments, runs, drafts } };
}

/** The person's live (pending or active) enrollments, split the way the permission rule needs them. */
export interface LiveEnrollmentSummary {
  /** Enrollments in regular campaigns. */
  regular: number;
  /** Enrollments in personal campaigns, with the distinct users who created those campaigns. */
  personal: { count: number; createdBy: string[] };
}

export interface RunStopPreview {
  runs: number;
  drafts: number;
}

/** What the preview reads, besides the lifecycle. Outreach and conversations implement them (`drizzle-lead-lifecycle.ts` holds the leads part). */
export interface PreviewDeps {
  lifecycles: LeadLifecycleStore["lifecycles"];
  /** Live enrollments per person. A person without any has no entry. */
  liveEnrollmentSummary(organizationId: string, personIds: readonly string[]): Promise<Map<string, LiveEnrollmentSummary>>;
  /** Active and paused follow-up runs per person with the unsent drafts an interruption retires. A person without a run has no entry. */
  previewRunStop(organizationId: string, personIds: readonly string[]): Promise<Map<string, RunStopPreview>>;
}

export const MAX_CONVERT_PREVIEW_IDS = 500;

export interface ConvertPreview {
  /** Leads the actor may convert. */
  people: number;
  alreadyContacts: number;
  /** Pending and active enrollments the conversion stops, personal campaigns the actor may see included. */
  enrollments: number;
  runs: number;
  followUpDraftsToRetire: number;
  /** Leads the actor may not convert, because a personal campaign of another member holds them. They are left out of every count above. */
  skippedPersonalCampaign: number;
}

/**
 * The `personal_campaign` skip: a person with a live personal-campaign enrollment can be converted only by the creator of
 * that campaign or an owner or admin. Another member's private outreach stays theirs to end.
 */
export function personalCampaignSkip(actor: Pick<Actor, "userId" | "role">, summary: LiveEnrollmentSummary | undefined): boolean {
  if (!summary || summary.personal.count === 0) return false;
  if (isOwnerOrAdmin(actor.role)) return false;
  const { createdBy } = summary.personal;
  return !(createdBy.length > 0 && createdBy.every((id) => id === actor.userId));
}

/** What a refused conversion says when `personalCampaignSkip` holds. Deals answers it as 403, the leads routes as 409 `personal_campaign`. */
export const PERSONAL_CAMPAIGN_MESSAGE = "A personal campaign of another member is still reaching this person. Its creator or an admin can create the deal.";

/** The effects of converting these leads, said before the click. Counts only what the actor may convert and see. */
export async function previewConvert(deps: PreviewDeps, actor: Actor, personIds: readonly string[]): Promise<ConvertPreview> {
  const ids = [...new Set(personIds)];
  if (ids.length > MAX_CONVERT_PREVIEW_IDS) throw new ValidationError(`Preview up to ${MAX_CONVERT_PREVIEW_IDS} people at a time.`);
  const preview: ConvertPreview = { people: 0, alreadyContacts: 0, enrollments: 0, runs: 0, followUpDraftsToRetire: 0, skippedPersonalCampaign: 0 };
  if (ids.length === 0) return preview;

  const lifecycles = await deps.lifecycles(actor.organizationId, ids);
  const leadIds = ids.filter((id) => lifecycles.get(id) === "lead");
  preview.alreadyContacts = ids.filter((id) => lifecycles.get(id) === "contact").length;
  if (leadIds.length === 0) return preview;

  const enrollments = await deps.liveEnrollmentSummary(actor.organizationId, leadIds);
  const convertible = leadIds.filter((id) => !personalCampaignSkip(actor, enrollments.get(id)));
  preview.skippedPersonalCampaign = leadIds.length - convertible.length;
  preview.people = convertible.length;
  for (const id of convertible) {
    const summary = enrollments.get(id);
    if (summary) preview.enrollments += summary.regular + summary.personal.count;
  }
  if (convertible.length === 0) return preview;

  const runStops = await deps.previewRunStop(actor.organizationId, convertible);
  for (const id of convertible) {
    const stop = runStops.get(id);
    if (!stop) continue;
    preview.runs += stop.runs;
    preview.followUpDraftsToRetire += stop.drafts;
  }
  return preview;
}
