import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

describeDb("LinkedIn inbound creates leads with linkedin_url", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let created: TestOrg;
  let org = "";
  let store: typeof import("../drizzle-linkedin-conversation-store").drizzleLinkedInConversationStore;

  beforeAll(async () => {
    store = (await import("../drizzle-linkedin-conversation-store")).drizzleLinkedInConversationStore;
    created = await createTestOrg(sql, "I");
    org = created.organizationId;
  });

  afterAll(async () => {
    await dropOrgs(sql, [created]);
    await sql.end();
  });

  it("stores the canonical URL for a new sender", async () => {
    const result = await store.ingestLinkedIn({
      organizationId: org,
      accountRef: "acct-1",
      accountName: "Me",
      providerThreadId: "thread-1",
      providerMessageId: "m-1",
      counterparty: { providerId: "prov-1", name: "Pat Sender", profileUrl: "https://www.linkedin.com/in/pat-sender", slug: "pat-sender" },
      personId: null,
      bodyText: "hello",
      receivedAt: new Date(),
    });
    expect(result.status).not.toBe("unresolved");
    const [p] = await sql`select linkedin_slug, linkedin_url from people where organization_id = ${org}`;
    expect(p).toEqual({ linkedin_slug: "pat-sender", linkedin_url: "https://www.linkedin.com/in/pat-sender/" });
  });
});
