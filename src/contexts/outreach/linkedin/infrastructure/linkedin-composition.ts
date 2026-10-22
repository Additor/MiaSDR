import { claimSlot, finishSlot } from "@/platform/jobs/slots";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/shared/env";
import type { Job } from "@/platform/jobs/types";
import type { InboxFiling } from "../../application/inbound-ports";
import { createLinkedInJobs } from "../application/linkedin-jobs";
import { receiveLinkedInWebhook, type WebhookResult } from "../application/linkedin-inbound";
import type { LinkedInOperationsDeps } from "../application/linkedin-operations";
import type { LinkedInCampaignDeps } from "../application/linkedin-campaigns";
import { parseDsn, type DsnPolicy, type LinkedInManagementDeps } from "../application/linkedin-management";
import type { LinkedInSearchBatchDeps, LinkedInSearchCapacityDeps, LinkedInSearchDeps, LinkedInSearchEngineDeps } from "../application/linkedin-search-ports";
import type { LinkedInEngineDeps, LinkedInGateway, LinkedInGatewayProvider, LinkedInInboundDeps } from "../application/linkedin-ports";
import type { NoticeDeps } from "../application/linkedin-enroll-notices";
import { drizzleCrossCampaignNotices } from "../../infrastructure/drizzle-cross-campaign-notices";
import { drizzleEnrollmentAdminStore } from "../../infrastructure/drizzle-enrollment-admin";
import { drizzleLinkedInAccountStore } from "./drizzle-linkedin-account-store";
import { drizzleLinkedInConnectStore } from "./drizzle-linkedin-connect-store";
import { drizzleAuditSink, drizzleLinkedInOperationsStore } from "./drizzle-linkedin-operations-store";
import { drizzleLinkedInCampaignStore } from "./drizzle-linkedin-campaign-store";
import { createDrizzleLinkedInInboundStore } from "./drizzle-linkedin-inbound-store";
import { drizzleLinkedInSearchBatchStore } from "./drizzle-linkedin-search-batch-store";
import { drizzleLinkedInSearchCapacityStore } from "./drizzle-linkedin-search-capacity";
import { drizzleLinkedInSearchEngineStore, drizzleLinkedInSearchStore } from "./drizzle-linkedin-search-store";
import { drizzleLinkedInStore } from "./drizzle-linkedin-store";
import { drizzlePersonalThreadStore } from "./drizzle-personal-thread-store";
import { searchLeadSink } from "./search-lead-sink";
import { FakeLinkedInGateway } from "./fake-linkedin-gateway";
import { UnipileGateway } from "./unipile-gateway";
import { parseUnipilePayload } from "./unipile-webhook";

const globalForFake = globalThis as unknown as { __miasdrFakeLinkedIn?: FakeLinkedInGateway };

const fakeMode = () => env().LINKEDIN_PROVIDER === "fake";

/** Loopback hosts and plain http are for the fake provider only. NODE_ENV does not enable them. */
export function dsnPolicy(options: { allowLoopback?: boolean } = {}): DsnPolicy {
  const allowedHosts = (env().LINKEDIN_DSN_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return { allowedHosts, allowLoopback: fakeMode() || options.allowLoopback === true };
}

function fakeGateway(): FakeLinkedInGateway {
  if (!globalForFake.__miasdrFakeLinkedIn) {
    globalForFake.__miasdrFakeLinkedIn = new FakeLinkedInGateway();
    // Demo mode: every search finds 45 made-up people, so the queue can be tried without a LinkedIn account.
    globalForFake.__miasdrFakeLinkedIn.autoSearchTotal = 45;
    globalForFake.__miasdrFakeLinkedIn.accounts = [{ ref: "demo-account", linkedinId: "ACo-demo", name: "Demo Seller", username: "demo-seller", status: "connected" }];
  }
  return globalForFake.__miasdrFakeLinkedIn;
}

/** The one place that decides which LinkedIn adapter is live: Unipile with the organization's stored credentials, or the demo fake. */
export function linkedinGateways(options: { allowLoopback?: boolean } = {}): LinkedInGatewayProvider {
  if (fakeMode()) return fakeGateway();
  return {
    async forOrganization(organizationId): Promise<LinkedInGateway | null> {
      const credentials = await drizzleLinkedInAccountStore.getCredentials(organizationId);
      if (!credentials) return null;
      // A DSN saved under an older rule is checked again, so the key only goes to an allowed host.
      const parsed = parseDsn(credentials.dsn, dsnPolicy(options));
      return parsed ? new UnipileGateway({ dsn: parsed.host, scheme: parsed.scheme, apiKey: credentials.apiKey }) : null;
    },
  };
}

export function linkedinManagementDeps(): LinkedInManagementDeps {
  return {
    accounts: drizzleLinkedInAccountStore,
    dsnPolicy: dsnPolicy(),
    gatewayFor: (credentials) => (fakeMode() ? fakeGateway() : new UnipileGateway(credentials)),
    appUrl: env().APP_URL,
    now: () => new Date(),
    audit: drizzleAuditSink,
    connectLinks: drizzleLinkedInConnectStore,
  };
}

export function linkedinOperationsDeps(inbox: InboxFiling): LinkedInOperationsDeps {
  return { store: drizzleLinkedInOperationsStore, inbound: inboundDeps(inbox), audit: drizzleAuditSink, now: () => new Date() };
}

export const personalThreadDeps = () => ({ store: drizzlePersonalThreadStore });

export const linkedinCampaignDeps = (): LinkedInCampaignDeps => ({ campaigns: drizzleLinkedInCampaignStore, admin: drizzleEnrollmentAdminStore });

export const linkedinNoticeDeps = (): NoticeDeps => ({ ...linkedinCampaignDeps(), notices: drizzleCrossCampaignNotices });

export const linkedinSearchDeps = (): LinkedInSearchDeps => ({ searches: drizzleLinkedInSearchStore, campaigns: drizzleLinkedInCampaignStore });

export const linkedinSearchBatchDeps = (): LinkedInSearchBatchDeps => ({ batches: drizzleLinkedInSearchBatchStore, campaigns: drizzleLinkedInCampaignStore });

export const linkedinSearchCapacityDeps = (): LinkedInSearchCapacityDeps => ({ capacity: drizzleLinkedInSearchCapacityStore });

function searchEngineDeps(): LinkedInSearchEngineDeps {
  return { store: drizzleLinkedInSearchEngineStore, gateways: linkedinGateways(), sink: searchLeadSink, clock: { now: () => new Date() }, random: Math.random };
}

function engineDeps(): LinkedInEngineDeps {
  return { store: drizzleLinkedInStore, gateways: linkedinGateways(), clock: { now: () => new Date() }, random: Math.random };
}

function inboundDeps(inbox: InboxFiling): LinkedInInboundDeps {
  return { store: createDrizzleLinkedInInboundStore(inbox), clock: { now: () => new Date() }, parse: parseUnipilePayload };
}

/** LinkedIn jobs. They idle until an organization connects Unipile, so they are always registered. */
export function linkedinJobs(inbox: InboxFiling): Job[] {
  return createLinkedInJobs(engineDeps(), inboundDeps(inbox), searchEngineDeps(), linkedinManagementDeps(), { claim: claimSlot, finish: finishSlot });
}

export type UnipileDelivery = { status: 401 } | { status: 200; result: WebhookResult };

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * One webhook delivery. The secret in `x-unipile-secret` must match the organization's stored one
 * (constant-time compare). The ledger row is written before processing; failures are recorded for replay.
 */
export async function receiveUnipileDelivery(inbox: InboxFiling, input: { organizationId: string; secret: string | null; payload: unknown }): Promise<UnipileDelivery> {
  const credentials = await drizzleLinkedInAccountStore.getCredentials(input.organizationId);
  if (!credentials || !input.secret || !sameSecret(input.secret, credentials.notifySecret)) return { status: 401 };
  return { status: 200, result: await receiveLinkedInWebhook(inboundDeps(inbox), { organizationId: input.organizationId, payload: input.payload }) };
}
