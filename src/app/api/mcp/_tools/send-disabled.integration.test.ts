import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** `env()` caches for the process, so the install's switch gets a file of its own. */
describeDb("MCP_SEND_ENABLED=false", () => {
  useTestEnv({ MCP_SEND_ENABLED: "false", AI_PROVIDER: "fake", MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let org: TestOrg;
  let POST: (request: Request) => Promise<Response>;
  let agent: McpCaller;

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    org = await createTestOrg(sql, "Send disabled");
    orgs.push(org);
    await enableMcp(sql, org.organizationId);
    await sql`update channel_settings set values = values || ${sql.json({ agentSendMode: "replies_and_campaigns", agentSendEpoch: 0 })} where organization_id = ${org.organizationId} and channel = 'mcp'`;
    agent = await mcpCaller(sql, POST, org, ["mcp:read", "mcp:write", "mcp:send"]);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("hides the send tools whatever the organization chose, and refuses a send that reaches the store", async () => {
    const listed = (await callMcp(POST, { era: "modern", token: agent.token, method: "tools/list" })).body as { result: { tools: Array<{ name: string }> } };
    const names = listed.result.tools.map((t) => t.name);
    expect(names).toContain("write_reply_draft");
    for (const name of ["send_reply", "preview_campaign_launch", "launch_campaign"]) expect(names).not.toContain(name);

    const mailbox = `sdr-${org.organizationId.slice(0, 8)}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status) values (${org.organizationId}, ${mailbox}, 'connected')`;
    const { ingestInbound } = await import("@/contexts/conversations/infrastructure/composition");
    const tag = randomBytes(4).toString("hex");
    const { threadId } = await ingestInbound({
      organizationId: org.organizationId,
      accountRef: mailbox,
      providerThreadId: `t-${tag}`,
      providerMessageId: `m-${tag}`,
      rfcMessageId: `<${tag}@x.test>`,
      inReplyTo: null,
      from: { email: `lead-${tag}@acme.test`, name: "Lena" },
      to: [mailbox],
      subject: "Hi",
      bodyText: "Hello",
      receivedAt: new Date(),
      autoReply: false,
    });
    const created = await agent.tool("write_reply_draft", { action: "create_manual", threadId, subject: "Re: Hi", bodyText: "Hello back." });
    const draft = created.structured.draft as { draftId: string; revision: number };
    const { approveAndSendDraft } = await import("@/contexts/conversations/application/reply-management");
    const { replySendDeps } = await import("@/contexts/conversations/infrastructure/reply-send-composition");
    const person = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    const via = { ...person, via: { kind: "agent" as const, tokenId: agent.tokenId, tokenName: "Test agent", clientName: null } };
    await expect(approveAndSendDraft(replySendDeps(), via, draft.draftId, { revision: draft.revision, idempotencyKey: `via-${tag}` })).rejects.toMatchObject({ details: { code: "agent_send_off" } });
    expect((await approveAndSendDraft(replySendDeps(), person, draft.draftId, { revision: draft.revision, idempotencyKey: `person-${tag}` })).status).toBe("sent");
  });
});
