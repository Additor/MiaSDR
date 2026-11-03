import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import { STOP_REQUEST_FIXTURES } from "../../domain/stop-request.fixtures";

/** SQL holds no copy of the patterns: it reads the flag ingest stored. Each fixture goes through ingest and comes back through the SQL form. */
describeDb("the SQL reading of a stop request", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg(sql, "Stop words");
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, [org]);
    } finally {
      await sql.end();
    }
  });

  it("answers as the fixture table says for every language", async () => {
    const { ingestInbound } = await import("@/contexts/conversations/infrastructure/composition");
    const { replyAskedToStop } = await import("../stop-requested-sql");
    const { db } = await import("@/platform/db/client");
    const read = async (text: string) => {
      const key = uniqueKey();
      const filed = await ingestInbound({
        organizationId: org.organizationId,
        accountRef: "sender@corp.test",
        providerThreadId: `t-${key}`,
        providerMessageId: `m-${key}`,
        rfcMessageId: null,
        inReplyTo: null,
        from: { email: `lead-${key}@acme.test`, name: null },
        to: ["sender@corp.test"],
        subject: "Re: hello",
        bodyText: text,
        receivedAt: new Date(),
        autoReply: false,
      });
      return replyAskedToStop(db, filed.messageId);
    };
    for (const { language, asks, ordinary } of STOP_REQUEST_FIXTURES) {
      for (const text of asks) expect(await read(text), `${language}: ${text}`).toBe(true);
      for (const text of ordinary) expect(await read(text), `${language}: ${text}`).toBe(false);
    }
  }, 60_000);
});
