import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/**
 * A mailbox address can leave one organization and join another. Gmail keeps the thread and message ids, so the new
 * organization's sync sees ids the old one stored. Each organization keeps its own history, and neither reaches the other's.
 */
describeDb("account keys across organizations", () => {
  useTestEnv({ AI_PROVIDER: "fake", MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];
  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("files the same Gmail message for the new organization, and leaves the old one's thread alone", async () => {
    const { ingestInbound } = await import("../composition");
    const a = await createTestOrg(sql, "Old owner");
    const b = await createTestOrg(sql, "New owner");
    orgs.push(a, b);
    const tag = randomBytes(4).toString("hex");
    const mail = (organizationId: string) => ({
      organizationId,
      accountRef: `moved-${tag}@corp.test`,
      providerThreadId: `thread-${tag}`,
      providerMessageId: `message-${tag}`,
      rfcMessageId: `<${tag}@x.test>`,
      inReplyTo: null,
      from: { email: `lead-${tag}@acme.test`, name: "Lena Lead" },
      to: [`moved-${tag}@corp.test`],
      subject: "Hello",
      bodyText: "Tell me more.",
      receivedAt: new Date(),
      autoReply: false,
    });
    const first = await ingestInbound(mail(a.organizationId));
    const second = await ingestInbound(mail(b.organizationId));
    expect(second.status).toBe("created");
    expect(second.conversationId).not.toBe(first.conversationId);
    const [row] = await sql`select organization_id from conversations where id = ${second.conversationId}`;
    expect(row.organization_id).toBe(b.organizationId);
    const [{ n }] = await sql`select count(*)::int as n from messages where conversation_id = ${first.conversationId}`;
    expect(n).toBe(1);
    expect((await ingestInbound(mail(b.organizationId))).status).toBe("duplicate");
  });
});
