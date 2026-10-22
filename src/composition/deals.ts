import { db } from "@/platform/db/client";
import { CONVERSION_LOCK_TIMEOUT, lockPersonForConversion, setLockTimeout } from "@/platform/db/person-locks";
import { personReplyHandling } from "@/contexts/conversations/infrastructure/person-handling";
import { drizzleTaskStore } from "@/contexts/conversations/actions/infrastructure/drizzle-task-store";
import { convertToContact, type ConvertDeps, type PreviewDeps } from "@/contexts/leads/application/convert-to-contact";
import { drizzleLeadLifecycle } from "@/contexts/leads/infrastructure/drizzle-lead-lifecycle";
import { personSummaries } from "@/contexts/leads/infrastructure/people-directory";
import { conversionOutreach } from "@/contexts/outreach/infrastructure/drizzle-conversion-outreach";
import type { ConvertLead, DealsDeps, UnitOfWork } from "@/contexts/deals/application/deal-ports";
import { crmRead } from "@/contexts/deals/infrastructure/crm-read";
import { drizzleDealStore } from "@/contexts/deals/infrastructure/drizzle-deal-store";

/*
 * The composition root of the deals context. It wires the leads conversion (`convertToContact`) to the callee-owned
 * functions of conversations and outreach, and the deals use cases to their stores and the crm-read model. It spans
 * four contexts, so it lives in src/composition, beside person-lifecycle.ts.
 */

/** The conversion's ports, wired to the callee-owned functions of conversations and outreach. */
export const conversionDeps: ConvertDeps = {
  lockPerson: lockPersonForConversion,
  lifecycleOf: drizzleLeadLifecycle.lifecycleOf,
  markConverted: drizzleLeadLifecycle.markConverted,
  stopEnrollments: conversionOutreach.stopPersonEnrollmentsTx,
  interruptRuns: personReplyHandling.interruptPersonRuns,
  appendEvent: personReplyHandling.appendPersonEvent,
};

export const convertLead: ConvertLead = (tx, input) => convertToContact(conversionDeps, tx, input);

/** What `previewConvert` reads. */
export const convertPreviewDeps = (): PreviewDeps => ({
  lifecycles: drizzleLeadLifecycle.lifecycles,
  liveEnrollmentSummary: (organizationId, ids) => conversionOutreach.liveEnrollmentSummary(organizationId, [...ids]),
  previewRunStop: (organizationId, ids) => personReplyHandling.previewPersonRunStop(organizationId, [...ids]),
});

export const dealsUnitOfWork: UnitOfWork = {
  run: (fn, options) =>
    db.transaction(async (tx) => {
      if (options?.lockTimeout) await setLockTimeout(tx, CONVERSION_LOCK_TIMEOUT);
      return fn(tx);
    }),
};

export const dealsDeps = (overrides: Partial<DealsDeps> = {}): DealsDeps => ({
  uow: dealsUnitOfWork,
  store: drizzleDealStore,
  convertLead,
  people: { summaries: personSummaries },
  outreach: conversionOutreach,
  events: { append: personReplyHandling.appendPersonEvent },
  members: {
    isMember: drizzleTaskStore.isMember,
    names: async (organizationId) => new Map((await drizzleTaskStore.members(organizationId)).map((m) => [m.userId, m.name])),
  },
  crm: crmRead,
  now: () => new Date(),
  ...overrides,
});
