import { afterAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/** A delivery of an event this app acts on that it cannot read leaves a row a person sees, since a reply may be inside it. */
describeDb("an unreadable Unipile delivery", () => {
  useTestEnv({ AI_PROVIDER: "fake", MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  async function deliver(payload: unknown) {
    const org = await createTestOrg(sql, "Webhook");
    orgs.push(org);
    const { receiveLinkedInWebhook } = await import("../../application/linkedin-inbound");
    const { createDrizzleLinkedInInboundStore } = await import("../drizzle-linkedin-inbound-store");
    const { parseUnipilePayload, unreadablePayloadEvent } = await import("../unipile-webhook");
    const { inboxFiling } = await import("@/composition/inbox-filing");
    const deps = { store: createDrizzleLinkedInInboundStore(inboxFiling), clock: { now: () => new Date() }, parse: parseUnipilePayload, unreadable: unreadablePayloadEvent };
    const result = await receiveLinkedInWebhook(deps, { organizationId: org.organizationId, payload });
    return { result, rows: await sql`select status, event_type from inbound_events where organization_id = ${org.organizationId}` };
  }

  it("keeps a message with no id, which would otherwise vanish", async () => {
    const { result, rows } = await deliver({ event: "message_received", account_type: "LINKEDIN", account_id: "acct", chat_id: "c", message: "Stop" });
    expect(result.status).toBe("ignored");
    expect(rows).toEqual([expect.objectContaining({ status: "failed", event_type: "message_received" })]);
  });

  it("keeps an event it acts on that fails to parse", async () => {
    const { rows } = await deliver({ event: "new_relation", account_type: "LINKEDIN", account_id: "acct" });
    expect(rows).toEqual([expect.objectContaining({ status: "failed", event_type: "new_relation" })]);
  });

  it("writes nothing for an event this app does not act on", async () => {
    const { rows } = await deliver({ event: "message_reaction", account_type: "LINKEDIN", account_id: "acct" });
    expect(rows).toEqual([]);
  });
});
