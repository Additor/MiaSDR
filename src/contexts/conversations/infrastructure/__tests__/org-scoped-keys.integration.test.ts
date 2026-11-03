import { randomBytes } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
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
    expect(second.threadId).not.toBe(first.threadId);
    const [row] = await sql`select organization_id from threads where id = ${second.threadId}`;
    expect(row.organization_id).toBe(b.organizationId);
    const [{ n }] = await sql`select count(*)::int as n from messages where thread_id = ${first.threadId}`;
    expect(n).toBe(1);
    expect((await ingestInbound(mail(b.organizationId))).status).toBe("duplicate");
  });

  it("keeps the same LinkedIn chat apart for each organization", async () => {
    const { drizzleLinkedInThreadStore: store } = await import("../drizzle-linkedin-thread-store");
    const a = await createTestOrg(sql, "Old account owner");
    const b = await createTestOrg(sql, "New account owner");
    orgs.push(a, b);
    const tag = randomBytes(4).toString("hex");
    const chat = (organizationId: string) => ({
      organizationId,
      accountRef: `account-${tag}`,
      accountName: null,
      providerThreadId: `chat-${tag}`,
      providerMessageId: `message-${tag}`,
      counterparty: { providerId: `member-${tag}`, name: "Lena Lead", profileUrl: null, slug: `lena-${tag}` },
      personId: null,
      bodyText: "Tell me more.",
      receivedAt: new Date(),
    });
    const first = await store.ingestLinkedIn(chat(a.organizationId));
    const second = await store.ingestLinkedIn(chat(b.organizationId));
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(second.status === "created" && first.status === "created" && second.threadId !== first.threadId).toBe(true);
    expect((await store.ingestLinkedIn(chat(b.organizationId))).status).toBe("duplicate");
  });
});
