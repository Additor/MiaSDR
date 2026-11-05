import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { listLinkedInAccounts, type LinkedInAccountRecord, type LinkedInManagementDeps } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { createEdgesVendor } from "@/contexts/outreach/linkedin/infrastructure/vendors/edges/edges-vendor";
import { createGtmVendor } from "@/contexts/outreach/linkedin/infrastructure/vendors/gtmapi/gtm-vendor";
import { createLinkedApiVendor } from "@/contexts/outreach/linkedin/infrastructure/vendors/linkedapi/linkedapi-vendor";
import { createUnipileVendor } from "@/contexts/outreach/linkedin/infrastructure/vendors/unipile/unipile-vendor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }),
  usePathname: () => "/settings/linkedin",
  useSearchParams: () => new URLSearchParams(),
}));

import { LinkedInPanel } from "./linkedin-panel";

/*
 * e2e runs with LINKEDIN_PROVIDER=fake, which leaves out every vendor but Unipile. So this renders each vendor's states from
 * the real listing and the real vendors. Only what the first render shows is covered: not effects, menus or dialogs.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const actor = { userId: "00000000-0000-4000-8000-000000000003", organizationId: ORG, role: "owner" as const };
const CREDENTIALS = { unipile: { dsn: "api1.unipile.com:13111", apiKey: "k", notifySecret: "n" }, edges: { apiKey: "k", notifySecret: "n" }, gtmapi: { apiKey: "k", notifySecret: "n" }, linkedapi: { apiKey: "k", notifySecret: "n" } };

const account = (provider: string, over: Partial<LinkedInAccountRecord> = {}): LinkedInAccountRecord =>
  ({
    id: "00000000-0000-4000-8000-000000000010",
    provider,
    providerAccountId: "ref-1",
    linkedinId: "ACoAAseller1",
    name: "Sam Seller",
    username: "sam-seller",
    status: "connected",
    isPremium: false,
    dailyInviteLimit: 20,
    dailyMessageLimit: 50,
    limitReachedUntil: null,
    invitesPausedUntil: null,
    inboundReadAt: new Date(),
    inboxReadByPoll: provider !== "unipile",
    workingHours: { timeZone: "UTC", days: { "1": [{ start: "09:00", end: "18:00" }] } },
    invitesToday: 0,
    messagesToday: 0,
    ownerUserId: null,
    ...over,
  }) as LinkedInAccountRecord;

async function render(options: { connected: keyof typeof CREDENTIALS | null; accounts?: LinkedInAccountRecord[] }) {
  const { connected, accounts = [] } = options;
  const deps = {
    vendors: [createUnipileVendor({ gatewayFor: () => ({}) as never }), createEdgesVendor(), createGtmVendor(), createLinkedApiVendor()],
    accounts: {
      connectedVendor: async () => connected,
      getCredentials: async () => (connected ? CREDENTIALS[connected] : null),
      getWebhookStatus: async () => null,
      getSyncStatus: async () => ({ lastSyncAt: null, lastSyncError: null }),
      list: async () => accounts,
    },
    connectLinks: { listRecent: async () => [] },
    appUrl: "https://app.test/",
    now: () => new Date(),
  } as unknown as LinkedInManagementDeps;
  const state = JSON.parse(JSON.stringify(await listLinkedInAccounts(deps, actor)));
  return renderToStaticMarkup(createElement(LinkedInPanel, { state, canManage: true, zones: ["UTC"], members: [], ownerOnConnect: false }));
}

const asksDsn = (html: string) => html.includes('id="dsn"');

describe("the LinkedIn settings panel", () => {
  describe("with no vendor connected", () => {
    it("starts on Unipile for an organization with no accounts", async () => {
      const html = await render({ connected: null });
      expect(html).toContain("Unipile connection");
      expect(asksDsn(html)).toBe(true);
      expect(html).toContain("Verify and connect");
      expect(html).not.toContain("LinkedIn accounts</");
    });

    it.each([
      ["edges", "Edges connection", "Settings, Developers"],
      ["gtmapi", "gtm-api connection", "every LinkedIn account in the key&#x27;s team"],
      ["linkedapi", "Linked API connection", "with the policy on Run anyway"],
    ])("starts on the vendor the accounts of %s came through, and asks for a key alone", async (provider, heading, sentence) => {
      const html = await render({ connected: null, accounts: [account(provider)] });
      expect(html).toContain(heading);
      expect(html).toContain(sentence);
      expect(asksDsn(html)).toBe(false);
    });

    it("offers no way back on the accounts, because the form above is the way back", async () => {
      const html = await render({ connected: null, accounts: [account("gtmapi", { status: "disconnected" })] });
      expect(html).not.toContain("Reconnect");
      expect(html).not.toContain("Sign in again in");
    });
  });

  describe("connected to Unipile", () => {
    it("offers connect links and no team sentence", async () => {
      const html = await render({ connected: "unipile", accounts: [account("unipile")] });
      expect(html).toContain("Connected to api1.unipile.com:13111");
      expect(html).toContain("Connect a LinkedIn account");
      expect(html).not.toContain("this key&#x27;s team");
    });

    it("says when the connection found no accounts", async () => {
      expect(await render({ connected: "unipile" })).toContain("No LinkedIn accounts yet.");
    });

    it("offers Reconnect on a disconnected account", async () => {
      const html = await render({ connected: "unipile", accounts: [account("unipile", { status: "disconnected" })] });
      expect(html).toContain("Reconnect");
    });
  });

  describe("connected to Edges", () => {
    it("offers connect links and Reconnect", async () => {
      const html = await render({ connected: "edges", accounts: [account("edges", { status: "disconnected" })] });
      expect(html).toContain("Connected to Edges.");
      expect(html).toContain("Connect a LinkedIn account");
      expect(html).toContain("Reconnect");
    });
  });

  describe("connected to Linked API", () => {
    it("says a send can take minutes, and offers its own link", async () => {
      const html = await render({ connected: "linkedapi", accounts: [account("linkedapi")] });
      expect(html).toContain("A send can take minutes");
      expect(html).toContain("Connect a LinkedIn account");
    });

    it("offers a reconnect on a signed-out account", async () => {
      expect(await render({ connected: "linkedapi", accounts: [account("linkedapi", { status: "disconnected" })] })).toContain("Reconnect");
    });
  });

  describe("connected to gtm-api", () => {
    it("offers Sync in place of connect links, and says the whole team is read", async () => {
      const html = await render({ connected: "gtmapi", accounts: [account("gtmapi")] });
      expect(html).toContain("Sync accounts");
      expect(html).not.toContain("Connect a LinkedIn account");
      expect(html).toContain("Every LinkedIn account in this key&#x27;s team is read here");
    });

    it("sends a signed-out account to gtm-api, with no Reconnect", async () => {
      const html = await render({ connected: "gtmapi", accounts: [account("gtmapi", { status: "disconnected" })] });
      expect(html).toContain("Sign in again in gtm-api, then choose Sync accounts.");
      expect(html).not.toContain("Reconnect");
    });

    it("shows a hold on invitations, and that messages go on", async () => {
      const until = new Date(Date.now() + 3_600_000);
      const held = await render({ connected: "gtmapi", accounts: [account("gtmapi", { invitesPausedUntil: until })] });
      expect(held).toContain("invitations and lookups wait until");
      expect(held).toContain("Messages and replies go on.");
      expect(await render({ connected: "gtmapi", accounts: [account("gtmapi")] })).not.toContain("invitations and lookups wait until");
    });
  });
});
