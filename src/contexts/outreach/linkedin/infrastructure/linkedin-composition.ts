import type { DbHandle } from "@/platform/db/client";
import { drizzleMemberDirectory } from "@/contexts/tenancy/infrastructure/drizzle-member-directory";
import { clearLinkedInOwner } from "./drizzle-linkedin-account-store";
import { claimSlot, finishSlot } from "@/platform/jobs/slots";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/shared/env";
import type { Job } from "@/platform/jobs/types";
import type { ContactStop, InboxFiling } from "../../application/inbound-ports";
import { createLinkedInJobs } from "../application/linkedin-jobs";
import { receiveLinkedInWebhook, type WebhookResult } from "../application/linkedin-inbound";
import type { LinkedInOperationsDeps } from "../application/linkedin-operations";
import type { LinkedInCampaignDeps } from "../application/linkedin-campaigns";
import type { LinkedInManagementDeps } from "../application/linkedin-management";
import type { LinkedInSearchBatchDeps, LinkedInSearchCapacityDeps, LinkedInSearchDeps, LinkedInSearchEngineDeps } from "../application/linkedin-search-ports";
import { LinkedInGatewayError, type LinkedInEngineDeps, type LinkedInGateway, type LinkedInGatewayProvider, type LinkedInInboundDeps, type LinkedInInboundPollDeps } from "../application/linkedin-ports";
import type { LinkedInInboundEvent } from "../domain/linkedin";
import type { NoticeDeps } from "../application/linkedin-enroll-notices";
import { drizzleCrossCampaignNotices } from "../../infrastructure/drizzle-cross-campaign-notices";
import { drizzleEnrollmentAdminStore } from "../../infrastructure/drizzle-enrollment-admin";
import { drizzleMergeFieldSource } from "../../infrastructure/drizzle-merge-fields";
import { accountVendorOf, drizzleLinkedInAccountStore } from "./drizzle-linkedin-account-store";
import { drizzleLinkedInConnectStore } from "./drizzle-linkedin-connect-store";
import { drizzleLinkedInOperationsStore } from "./drizzle-linkedin-operations-store";
import { auditSink } from "@/contexts/tenancy/infrastructure/audit";
import { drizzleLinkedInCampaignStore } from "./drizzle-linkedin-campaign-store";
import { createDrizzleLinkedInInboundStore } from "./drizzle-linkedin-inbound-store";
import { drizzleLinkedInSearchBatchStore } from "./drizzle-linkedin-search-batch-store";
import { drizzleLinkedInSearchCapacityStore } from "./drizzle-linkedin-search-capacity";
import { drizzleLinkedInSearchEngineStore, drizzleLinkedInSearchStore } from "./drizzle-linkedin-search-store";
import { createLinkedInReplyStop, drizzleLinkedInStore } from "./drizzle-linkedin-store";
import { searchLeadSink } from "./search-lead-sink";
import { FakeLinkedInGateway } from "./fake-linkedin-gateway";
import { drizzleLinkedInInboundPollStore } from "./drizzle-linkedin-inbound-read-store";
import { EdgesGateway } from "./vendors/edges/edges-gateway";
import { EdgesClient } from "./vendors/edges/edges-http";
import { edgesEventKey, isEdgesDelivery, parseEdgesDelivery, readEdgesInbound, unreadableEdgesDelivery } from "./vendors/edges/edges-inbound";
import { createEdgesVendor } from "./vendors/edges/edges-vendor";
import { GtmGateway } from "./vendors/gtmapi/gtm-gateway";
import { GtmClient } from "./vendors/gtmapi/gtm-http";
import { gtmEventKey, isGtmDelivery, parseGtmDelivery, readGtmInbound, unreadableGtmDelivery, unreadableGtmKey } from "./vendors/gtmapi/gtm-inbound";
import { createGtmVendor } from "./vendors/gtmapi/gtm-vendor";
import { UnipileGateway } from "./vendors/unipile/unipile-gateway";
import { storedConnection, type DsnPolicy } from "./vendors/unipile/unipile-dsn";
import { createUnipileVendor } from "./vendors/unipile/unipile-vendor";
import { parseUnipilePayload, unipileEventKey, unreadablePayloadEvent } from "./vendors/unipile/unipile-webhook";

export { WEBHOOK_SECRET_HEADER } from "./vendors/unipile/unipile-webhook";

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

/** The gateway of the org's vendor when `accountId` runs on it. An account of a vendor the org no longer connects has none. */
async function storedGateway(organizationId: string, accountId: string, policy: DsnPolicy): Promise<LinkedInGateway | null> {
  const [vendorKey, accountVendor] = await Promise.all([drizzleLinkedInAccountStore.connectedVendor(organizationId), accountVendorOf(organizationId, accountId)]);
  if (!vendorKey || vendorKey !== accountVendor) return null;
  const credentials = await drizzleLinkedInAccountStore.getCredentials(organizationId);
  if (!credentials) return null;
  if (vendorKey === "edges") return new EdgesGateway({ apiKey: credentials.apiKey ?? "" });
  if (vendorKey === "gtmapi") return new GtmGateway({ apiKey: credentials.apiKey ?? "" });
  const connection = storedConnection(credentials, policy);
  return connection ? new UnipileGateway(connection) : null;
}

/** The one place that decides which LinkedIn adapter is live: the account's vendor with the organization's stored credentials, or the demo fake. */
export function linkedinGateways(options: { allowLoopback?: boolean } = {}): LinkedInGatewayProvider {
  if (fakeMode()) return fakeGateway();
  return { forAccount: ({ organizationId, accountId }) => storedGateway(organizationId, accountId, dsnPolicy(options)) };
}

export function linkedinManagementDeps(): LinkedInManagementDeps {
  return {
    accounts: drizzleLinkedInAccountStore,
    vendors: [createUnipileVendor({ dsnPolicy: dsnPolicy(), gatewayFor: (connection) => (fakeMode() ? fakeGateway() : new UnipileGateway(connection)) }), ...(fakeMode() ? [] : [createEdgesVendor(), createGtmVendor()])],
    appUrl: env().APP_URL,
    now: () => new Date(),
    audit: auditSink,
    connectLinks: drizzleLinkedInConnectStore,
    members: drizzleMemberDirectory,
  };
}

/** A member who leaves owns no LinkedIn account any more; an admin picks a new owner. */
export async function releaseLinkedInAccounts(tx: DbHandle, organizationId: string, userId: string): Promise<void> {
  await clearLinkedInOwner(tx, organizationId, userId);
}

export function linkedinOperationsDeps(inbox: InboxFiling): LinkedInOperationsDeps {
  return { store: drizzleLinkedInOperationsStore, inbound: inboundDeps(inbox), audit: auditSink, now: () => new Date() };
}


export const linkedinCampaignDeps = (): LinkedInCampaignDeps => ({ campaigns: drizzleLinkedInCampaignStore, fields: drizzleMergeFieldSource, audit: auditSink, admin: drizzleEnrollmentAdminStore });

export const linkedinNoticeDeps = (): NoticeDeps => ({ ...linkedinCampaignDeps(), notices: drizzleCrossCampaignNotices });

export const linkedinSearchDeps = (): LinkedInSearchDeps => ({ searches: drizzleLinkedInSearchStore, campaigns: drizzleLinkedInCampaignStore });

export const linkedinSearchBatchDeps = (): LinkedInSearchBatchDeps => ({ batches: drizzleLinkedInSearchBatchStore, campaigns: drizzleLinkedInCampaignStore });

export const linkedinSearchCapacityDeps = (): LinkedInSearchCapacityDeps => ({ capacity: drizzleLinkedInSearchCapacityStore });

function searchEngineDeps(): LinkedInSearchEngineDeps {
  return { store: drizzleLinkedInSearchEngineStore, gateways: linkedinGateways(), sink: searchLeadSink, clock: { now: () => new Date() }, random: Math.random };
}

function engineDeps(stop: ContactStop): LinkedInEngineDeps {
  return { store: drizzleLinkedInStore, stopForReply: createLinkedInReplyStop(stop), gateways: linkedinGateways(), clock: { now: () => new Date() }, random: Math.random };
}

/** A delivery says which vendor's it is: polled ones carry a tag, and webhook ones, including rows from before tags, are Unipile's. */
function readerOf(payload: unknown): Pick<LinkedInInboundDeps, "parse" | "unreadable"> & { eventKey: (event: LinkedInInboundEvent, organizationId: string) => string | null; unreadableKey?: (organizationId: string) => string | null } {
  if (isEdgesDelivery(payload)) return { parse: () => parseEdgesDelivery(payload), unreadable: () => unreadableEdgesDelivery(payload), eventKey: edgesEventKey };
  if (isGtmDelivery(payload)) return { parse: () => parseGtmDelivery(payload), unreadable: () => unreadableGtmDelivery(payload), eventKey: gtmEventKey, unreadableKey: (organizationId) => unreadableGtmKey(payload, organizationId) };
  return { parse: parseUnipilePayload, unreadable: unreadablePayloadEvent, eventKey: (event, organizationId) => unipileEventKey(event, organizationId) };
}

const parseLinkedInPayload = (payload: unknown) => readerOf(payload).parse(payload);
const unreadableLinkedInPayload = (payload: unknown) => readerOf(payload).unreadable?.(payload) ?? null;
const unreadableLinkedInKey = (payload: unknown, organizationId: string) => readerOf(payload).unreadableKey?.(organizationId) ?? null;
const linkedInEventKey: LinkedInInboundDeps["eventKey"] = (event, organizationId, payload) => readerOf(payload).eventKey(event, organizationId);

function inboundDeps(inbox: InboxFiling): LinkedInInboundDeps {
  return { store: createDrizzleLinkedInInboundStore(inbox), clock: { now: () => new Date() }, parse: parseLinkedInPayload, unreadable: unreadableLinkedInPayload, unreadableKey: unreadableLinkedInKey, eventKey: linkedInEventKey };
}

/** The vendors read by polling, each with its own reader. */
const polledInboundSource: LinkedInInboundPollDeps["source"] = {
  async read({ organizationId, provider, account, cursor, now }) {
    const credentials = await drizzleLinkedInAccountStore.getCredentials(organizationId);
    if (!credentials?.apiKey) throw new LinkedInGatewayError("LinkedIn is not connected.", "definite", "unavailable");
    if (provider === "gtmapi") return readGtmInbound(new GtmClient({ apiKey: credentials.apiKey }), account, cursor, now);
    return readEdgesInbound(new EdgesClient({ apiKey: credentials.apiKey }), account, cursor, now);
  },
};

/** LinkedIn jobs. They idle until an organization connects LinkedIn, so they are always registered. */
export function linkedinJobs(inbox: InboxFiling, stop: ContactStop): Job[] {
  const poll: LinkedInInboundPollDeps = { store: drizzleLinkedInInboundPollStore, source: polledInboundSource, inbound: inboundDeps(inbox), clock: { now: () => new Date() } };
  return createLinkedInJobs(engineDeps(stop), inboundDeps(inbox), searchEngineDeps(), linkedinManagementDeps(), { claim: claimSlot, finish: finishSlot }, poll);
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
  return { status: 200, result: await receiveLinkedInWebhook(inboundDeps(inbox), { organizationId: input.organizationId, provider: "unipile", payload: input.payload }) };
}
