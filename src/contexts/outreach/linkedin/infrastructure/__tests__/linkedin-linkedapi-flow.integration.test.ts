import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { LinkedInEngineDeps, LinkedInGatewayProvider, LinkedInInboundDeps, LinkedInInboundPollDeps } from "../../application/linkedin-ports";
import type { LinkedInSettleDeps } from "../../application/settle-linkedin-operations";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "invitation", body: "", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks", waitDays: 1 },
];

type Workflow = { body: Record<string, unknown>; account: string; state: unknown };

/** Linked API as its documents describe it: accounts, workflows that stay pending until a test runs them, and what the inbox and network captured. */
function standIn() {
  const accounts: Array<Record<string, unknown>> = [];
  const workflows = new Map<string, Workflow>();
  const stand = {
    accounts,
    workflows,
    messages: [] as unknown[],
    events: [] as unknown[],
    add(id: string, slug: string, status = "active") {
      accounts.push({ id, name: "Jo Owner", url: `https://www.linkedin.com/in/${slug}`, status, identificationToken: `token-${id}`, connectedAt: new Date().toISOString() });
    },
    open: (action: string) => [...workflows.entries()].filter(([, w]) => w.body.actionType === action && (w.state as { workflowStatus: string }).workflowStatus === "pending"),
    /** Linked API's queue reaches every open action. */
    runAll(completionOf: (w: Workflow) => unknown = () => ({ success: true })) {
      for (const w of workflows.values()) {
        if ((w.state as { workflowStatus: string }).workflowStatus === "pending") w.state = { workflowStatus: "completed", completion: { actionType: w.body.actionType, ...(completionOf(w) as object) } };
      }
    },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.linkedapi.io", "");
      const answer = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status === 200, result }), { status });
      const token = (init?.headers as Record<string, string>)["identification-token"];
      const account = accounts.find((a) => a.identificationToken === token)?.id as string | undefined;
      if (path === "/admin/accounts.getAll") return answer({ accounts });
      if (path === "/workflows" && init?.method === "POST") {
        const workflowId = `wf-${workflows.size + 1}`;
        workflows.set(workflowId, { body: JSON.parse(String(init.body)), account: account as string, state: { workflowStatus: "pending" } });
        return answer({ workflowId, workflowStatus: "pending" });
      }
      const read = path.match(/^\/workflows\/(.+)$/);
      if (read && init?.method === "GET") return answer(workflows.get(read[1])?.state);
      if (path === "/inbox/poll") return answer({ messages: stand.messages });
      if (path === "/network/poll") return answer({ events: stand.events });
      throw new Error(`no route: ${init?.method} ${path}`);
    }) as unknown as typeof fetch,
  };
  return stand;
}

/** The whole way through on Linked API's adapter and the real stores, with only its HTTP stood in. Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("LinkedIn accounts on Linked API", () => {
  useTestEnv({ LINKEDIN_PROVIDER: undefined });
  const sql = testSql({ max: 6 });
  let store: typeof import("../drizzle-linkedin-store").drizzleLinkedInStore;
  let accounts: typeof import("../drizzle-linkedin-account-store").drizzleLinkedInAccountStore;
  let pollStore: typeof import("../drizzle-linkedin-inbound-read-store").drizzleLinkedInInboundPollStore;
  let openStore: typeof import("../drizzle-linkedin-open-operations-store").drizzleLinkedInOpenOperationStore;
  let searchStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchEngineStore;
  let engine: typeof import("../../application/send-next-linkedin");
  let poll: typeof import("../../application/poll-linkedin-inbound");
  let settle: typeof import("../../application/settle-linkedin-operations");
  let mgmt: typeof import("../../application/linkedin-management");
  let vendorModule: typeof import("../vendors/linkedapi/linkedapi-vendor");
  let inboundModule: typeof import("../vendors/linkedapi/linkedapi-inbound");
  let http: typeof import("../vendors/linkedapi/linkedapi-http");
  let gatewayModule: typeof import("../vendors/linkedapi/linkedapi-gateway");
  let replyStop: LinkedInEngineDeps["stopForReply"];
  let inbound: LinkedInInboundDeps;
  const orgs: string[] = [];

  beforeAll(async () => {
    const linkedinStore = await import("../drizzle-linkedin-store");
    store = linkedinStore.drizzleLinkedInStore;
    ({ drizzleLinkedInAccountStore: accounts } = await import("../drizzle-linkedin-account-store"));
    ({ drizzleLinkedInInboundPollStore: pollStore } = await import("../drizzle-linkedin-inbound-read-store"));
    ({ drizzleLinkedInOpenOperationStore: openStore } = await import("../drizzle-linkedin-open-operations-store"));
    ({ drizzleLinkedInSearchEngineStore: searchStore } = await import("../drizzle-linkedin-search-store"));
    engine = await import("../../application/send-next-linkedin");
    poll = await import("../../application/poll-linkedin-inbound");
    settle = await import("../../application/settle-linkedin-operations");
    mgmt = await import("../../application/linkedin-management");
    vendorModule = await import("../vendors/linkedapi/linkedapi-vendor");
    inboundModule = await import("../vendors/linkedapi/linkedapi-inbound");
    http = await import("../vendors/linkedapi/linkedapi-http");
    gatewayModule = await import("../vendors/linkedapi/linkedapi-gateway");
    const { contactStop, inboxFiling } = await import("@/composition/inbox-filing");
    replyStop = linkedinStore.createLinkedInReplyStop(contactStop);
    const { createDrizzleLinkedInInboundStore } = await import("../drizzle-linkedin-inbound-store");
    inbound = {
      store: createDrizzleLinkedInInboundStore(inboxFiling),
      clock: { now: () => new Date() },
      parse: (payload) => (inboundModule.isLinkedApiDelivery(payload) ? inboundModule.parseLinkedApiDelivery(payload) : null),
      unreadable: (payload) => (inboundModule.isLinkedApiDelivery(payload) ? inboundModule.unreadableLinkedApiDelivery(payload) : null),
      eventKey: (event, organizationId, payload) => inboundModule.linkedApiEventKey(event, organizationId, payload as never),
    };
  });

  afterAll(() => dropOrgs(sql, orgs.map((organizationId) => ({ organizationId }))));

  async function world() {
    const stand = standIn();
    const apiKey = `flow-${uniqueKey()}`;
    const [{ id: organizationId }] = await sql`insert into organizations (name, slug) values ('L', ${"la-" + uniqueKey()}) returning id`;
    orgs.push(organizationId);
    const gateway = new gatewayModule.LinkedApiGateway({ apiKey, fetch: stand.fetch });
    const gateways: LinkedInGatewayProvider = { forAccount: async () => gateway };
    const deps: LinkedInEngineDeps = { store, stopForReply: replyStop, gateways, clock: { now: () => new Date() }, random: () => 0 };
    const settleDeps: LinkedInSettleDeps = { operations: openStore, engine: deps, search: { store: searchStore, gateways, sink: { importPeople: async () => ({ ids: new Map(), skippedContact: 0 }) }, clock: deps.clock, random: () => 0 }, inbound };
    const vendor = vendorModule.createLinkedApiVendor({ fetch: stand.fetch });
    const management = { accounts, vendors: [vendor] } as never;
    await accounts.saveCredentials(organizationId, { apiKey, notifySecret: "s" }, vendor);
    const source: LinkedInInboundPollDeps["source"] = { read: ({ account, cursor, now }) => inboundModule.readLinkedApiInbound(new http.LinkedApiClient({ apiKey, fetch: stand.fetch }), account, cursor, now) };
    const pollDeps: LinkedInInboundPollDeps = { store: pollStore, source, inbound, clock: { now: () => new Date() } };
    return {
      stand,
      gateway,
      deps,
      organizationId: organizationId as string,
      sync: () => mgmt.syncWith(management, organizationId, vendor, gateway),
      settle: () => settle.settleLinkedInOperations(settleDeps, Date.now() + 30_000),
      read: async () => {
        await sql`update linkedin_accounts set inbound_lease_until = null where organization_id = ${organizationId}`;
        return poll.pollLinkedInInbound(pollDeps, Date.now() + 30_000);
      },
    };
  }

  /** A lead with a looked-up member on this account, waiting for its invitation. */
  async function pendingLead(organizationId: string, accountId: string) {
    const member = `ACoAAlead${uniqueKey().replaceAll("-", "")}`;
    const slug = `lead-${uniqueKey()}`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${organizationId}, 'linkedin', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    const [{ id: person }] = await sql`insert into people (organization_id, linkedin_slug, first_name) values (${organizationId}, ${slug}, 'Ada') returning id`;
    const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, linkedin_account_id) values (${organizationId}, ${campaign}, ${person}, 'linkedin', ${accountId}) returning id`;
    await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, member_urn) values (${enrollment}, ${organizationId}, ${member}, ${"urn:li:member:" + member})`;
    return { enrollment: enrollment as string, member, slug };
  }

  const pass = (id: string) => sql`update linkedin_accounts set next_allowed_run_at = null, working_hours = ${sql.json({ timeZone: "UTC", days: ALL_DAY } as never)} where id = ${id}`;
  const rowOf = async (organizationId: string) => (await sql`select * from linkedin_accounts where organization_id = ${organizationId}`)[0];

  it("opens the inbox gap on a reconnect that keeps its id, and not on a sync that changes nothing", async () => {
    const w = await world();
    const id = `acct-${uniqueKey()}`;
    w.stand.add(id, `owner-${uniqueKey()}`);
    await w.sync();
    await w.sync();
    expect((await rowOf(w.organizationId)).inbox_gap_until).toBeNull();

    w.stand.accounts[0].status = "reconnection_required";
    await w.sync();
    expect((await rowOf(w.organizationId)).status).toBe("disconnected");
    w.stand.accounts[0].status = "active";
    await w.sync();
    expect(await rowOf(w.organizationId)).toMatchObject({ status: "connected", inbound_read_at: null, former_provider_account_ids: [] });
    expect((await rowOf(w.organizationId)).inbox_gap_until).not.toBeNull();
  });

  it("carries a lead from invitation to message, across a reconnect, and stops on a reply it never saw", async () => {
    const w = await world();
    const slug = `owner-${uniqueKey()}`;
    const first = `acct-${uniqueKey()}`;
    w.stand.add(first, slug);

    // A sync adds the account. Linked API reports no Premium flag, so it starts at the free limit.
    await w.sync();
    const account = await rowOf(w.organizationId);
    expect(account).toMatchObject({ provider: "linkedapi", provider_account_id: first, daily_invite_limit: 5, is_premium: false });
    await pass(account.id);

    // Nothing goes out before the first read, and a read cannot finish before monitoring is on.
    const lead = await pendingLead(w.organizationId, account.id);
    expect((await engine.runNextLinkedInAction(w.deps, account.id)).kind).toBe("idle");
    expect((await w.read()).finished).toBe(0);
    expect(w.stand.open("st.syncInbox")).toHaveLength(1);
    w.stand.runAll();
    await w.read();
    expect(w.stand.open("st.syncNetwork")).toHaveLength(1);
    w.stand.runAll();
    expect((await w.read()).finished).toBe(1);

    // The invitation stays in flight, and goes on when Linked API says it did.
    expect((await engine.runNextLinkedInAction(w.deps, account.id)).kind).toBe("submitted");
    const [invite] = w.stand.open("st.sendConnectionRequest");
    expect(invite[1].body).toMatchObject({ personUrl: `https://www.linkedin.com/in/${lead.member}` });
    expect((await sql`select status from sends where enrollment_id = ${lead.enrollment}`)[0].status).toBe("sending");
    w.stand.runAll();
    await w.settle();
    expect((await sql`select status from sends where enrollment_id = ${lead.enrollment}`)[0].status).toBe("sent");

    // An acceptance names the person by public URL and URN, never by the id a send needs.
    w.stand.events = [{ id: "e1", type: "connectionAccepted", personUrn: `urn:li:member:${lead.member}`, personUrl: `https://www.linkedin.com/in/${lead.slug}`, detectedAt: new Date().toISOString() }];
    await sql`update linkedin_accounts set inbound_read_at = now() - interval '1 hour' where id = ${account.id}`;
    await w.read();
    expect((await sql`select connection_state from linkedin_enrollment_details where enrollment_id = ${lead.enrollment}`)[0].connection_state).toBe("connected");
    await sql`update campaign_enrollments set next_send_at = now() - interval '1 minute' where id = ${lead.enrollment}`;

    // A reconnect brings a new id. The row stays, keeps its old id for late deliveries, and the gate shuts until monitoring is back on.
    const second = `acct-${uniqueKey()}`;
    w.stand.accounts[0].status = "reconnection_required";
    w.stand.add(second, slug);
    w.gateway.client.forgetListing();
    await w.sync();
    const back = await rowOf(w.organizationId);
    expect(back).toMatchObject({ id: account.id, provider_account_id: second, former_provider_account_ids: [first], inbound_read_at: null });
    expect(back.inbox_gap_until).not.toBeNull();
    await pass(account.id);
    expect((await engine.runNextLinkedInAction(w.deps, account.id)).kind).toBe("idle");

    w.stand.events = [];
    await sql`update linkedin_accounts set inbound_lease_until = null where id = ${account.id}`;
    await w.read();
    w.stand.runAll();
    await w.read();
    w.stand.runAll();
    expect((await w.read()).finished).toBe(1);

    // The next message first reads the thread, and the thread holds a reply that was never captured.
    expect((await engine.runNextLinkedInAction(w.deps, account.id)).kind).toBe("submitted");
    const [look] = w.stand.open("st.syncConversation");
    expect(look[1].account).toBe(second);
    expect((await sql`select 1 from sends where enrollment_id = ${lead.enrollment} and step_number = 2`)).toHaveLength(0);
    w.stand.messages = [{ id: "m1", inboxMessageId: "m1", threadId: "2-t", personHashedUrl: `https://www.linkedin.com/in/${lead.member}`, personPublicUrl: `https://www.linkedin.com/in/${lead.slug}`, sender: "them", text: "No thanks", time: new Date().toISOString() }];
    w.stand.runAll();
    await w.settle();

    expect((await sql`select status from campaign_enrollments where id = ${lead.enrollment}`)[0].status).toBe("replied");
    expect(await sql`select provider, status from inbound_events where organization_id = ${w.organizationId} and event_type = 'message_received'`).toEqual([{ provider: "linkedapi", status: "done" }]);
    await pass(account.id);
    expect((await engine.runNextLinkedInAction(w.deps, account.id)).kind).toBe("idle");
    expect(w.stand.open("st.sendMessage")).toHaveLength(0);
  });
});
