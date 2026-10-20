import type { CrmDeps } from "../application/crm";
import { drizzleCrmStore } from "./drizzle-crm-store";
import { drizzleInboxStore } from "./drizzle-inbox-store";
import { ingestInbound, ingestInboundLinkedInMessage } from "./composition";

/**
 * Wires the CRM use cases. Holds no mailer: the only code that can send a reply is `approveAndSendDraft`,
 * wired in `ai-composition.ts`.
 */
export const crmDeps = (): CrmDeps => ({
  store: drizzleCrmStore,
  inbox: drizzleInboxStore,
  now: () => new Date(),
  replay: { email: ingestInbound, linkedin: ingestInboundLinkedInMessage },
});
