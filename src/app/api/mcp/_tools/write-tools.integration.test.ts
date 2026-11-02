import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

const WRITE = ["mcp:read", "mcp:write"];

describeDb("MCP write tools: drafts, reply handling and tasks", () => {
  useTestEnv({ AI_PROVIDER: "fake" });
  const sql = testSql({ max: 3 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let writer: McpCaller;
  let reader: McpCaller;
  let thread: { conversationId: string; recordId: string };
  let memberId: string;

  async function inbound(org: TestOrg, n: number) {
    const { ingestInbound } = await import("@/contexts/conversations/infrastructure/composition");
    const mailbox = `sdr-${org.organizationId.slice(0, 8)}@corp.test`;
    const result = await ingestInbound({
      organizationId: org.organizationId,
      accountRef: mailbox,
      providerThreadId: `t-${org.organizationId}-${n}`,
      providerMessageId: `m-${org.organizationId}-${n}`,
      rfcMessageId: `<${org.organizationId}-${n}@x.test>`,
      inReplyTo: null,
      from: { email: `lead${n}@acme.test`, name: "Lena Lead" },
      to: [mailbox],
      subject: "Re: pricing",
      bodyText: "Can you send pricing?",
      receivedAt: new Date(Date.now() - 3_600_000),
      autoReply: false,
    });
    const [{ record_id }] = await sql<{ record_id: string }[]>`select record_id from conversations where id = ${result.conversationId}`;
    return { conversationId: result.conversationId, recordId: record_id };
  }

  const eventsOf = (recordId: string, type: string) => sql<{ meta: Record<string, unknown> }[]>`select meta from events where record_id = ${recordId} and event_type = ${type} order by created_at`;

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    orgs.push(await createTestOrg(sql, "Writes"));
    const [org] = orgs;
    await enableMcp(sql, org.organizationId);
    await sql`insert into mailboxes (organization_id, email_address, status) values (${org.organizationId}, ${`sdr-${org.organizationId.slice(0, 8)}@corp.test`}, 'connected')`;
    const [{ id }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Mo Member', ${`mo-${randomBytes(4).toString("hex")}@mcp.test`}) returning id`;
    memberId = id;
    users.push(id);
    await sql`insert into members (organization_id, user_id, role) values (${org.organizationId}, ${id}, 'member')`;
    thread = await inbound(org, 1);
    writer = await mcpCaller(sql, POST, org, WRITE);
    reader = await mcpCaller(sql, POST, org);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("keeps the write tools from a read-only token", async () => {
    const listed = await callMcp(POST, { era: "modern", token: reader.token, method: "tools/list" });
    const names = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).not.toContain("write_reply_draft");
    await expect(reader.tool("write_reply_draft", { action: "request_ai", conversationId: thread.conversationId })).rejects.toThrow();
  });

  it("writes, edits and discards a draft with the agent named on it, and never sends", async () => {
    const created = await writer.tool("write_reply_draft", { action: "create_manual", conversationId: thread.conversationId, subject: "Re: pricing", bodyText: "Pricing attached." });
    expect(created.isError, created.text).toBe(false);
    const draft = created.structured.draft as { draftId: string; revision: number; status: string; text: string };
    expect(draft).toMatchObject({ status: "awaiting_review", text: "Pricing attached." });
    expect(created.structured.reviewUrl).toBe(`http://localhost:3000/inbox/${thread.conversationId}`);
    const [row] = await sql<{ written_via_token_id: string }[]>`select written_via_token_id from drafts where id = ${draft.draftId}`;
    expect(row.written_via_token_id).toBe(writer.tokenId);
    expect((await eventsOf(thread.recordId, "draft.created_manual"))[0].meta).toMatchObject({ via: { tokenId: writer.tokenId, tokenName: "Test agent" } });

    const edited = await writer.tool("write_reply_draft", { action: "edit", draftId: draft.draftId, revision: draft.revision, bodyText: "Pricing attached. Talk Tuesday?" });
    expect(edited.isError, edited.text).toBe(false);
    expect(edited.structured.draft).toMatchObject({ revision: draft.revision + 1, text: "Pricing attached. Talk Tuesday?" });

    const stale = await writer.tool("write_reply_draft", { action: "discard", draftId: draft.draftId, revision: draft.revision });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("changed since you opened it");
    const discarded = await writer.tool("write_reply_draft", { action: "discard", draftId: draft.draftId, revision: draft.revision + 1 });
    expect(discarded.isError, discarded.text).toBe(false);
    expect((await eventsOf(thread.recordId, "draft.discarded"))[0].meta).toMatchObject({ via: { tokenId: writer.tokenId } });

    const asked = await writer.tool("write_reply_draft", { action: "request_ai", conversationId: thread.conversationId });
    expect(asked.isError, asked.text).toBe(false);
    expect(asked.structured.draft).toMatchObject({ status: "awaiting_review" });
    expect(await sql`select 1 from send_attempts where organization_id = ${orgs[0].organizationId}`).toHaveLength(0);
  });

  it("refuses an edit that carries the cut copy of a long draft", async () => {
    const long = `${"Pricing tiers explained at length. ".repeat(500)}The end.`;
    // The test before left an AI draft open, and a new draft replaces it only with its revision.
    const open = (await writer.tool("get_conversation", { conversationId: thread.conversationId })).structured.draft as { revision: number };
    const blind = await writer.tool("write_reply_draft", { action: "create_manual", conversationId: thread.conversationId, subject: "Re: pricing", bodyText: long });
    expect(blind.structured.error).toMatchObject({ code: "draft_open" });
    const created = await writer.tool("write_reply_draft", { action: "create_manual", conversationId: thread.conversationId, subject: "Re: pricing", bodyText: long, revision: open.revision });
    const draft = created.structured.draft as { draftId: string; revision: number; text: string; truncated: boolean };
    expect(draft.truncated).toBe(true);

    const cut = await writer.tool("write_reply_draft", { action: "edit", draftId: draft.draftId, revision: draft.revision, bodyText: draft.text });
    expect(cut.structured.error).toMatchObject({ code: "truncated_text" });
    const copied = await writer.tool("write_reply_draft", { action: "create_manual", conversationId: thread.conversationId, bodyText: draft.text, revision: draft.revision });
    expect(copied.structured.error).toMatchObject({ code: "truncated_text" });
    const [row] = await sql<{ edited_body_text: string }[]>`select edited_body_text from drafts where id = ${draft.draftId}`;
    expect(row.edited_body_text).toBe(long);

    const rewritten = await writer.tool("write_reply_draft", { action: "edit", draftId: draft.draftId, revision: draft.revision, bodyText: "A short answer instead." });
    expect(rewritten.isError, rewritten.text).toBe(false);
    await writer.tool("write_reply_draft", { action: "discard", draftId: draft.draftId, revision: draft.revision + 1 });
    // The file together writes more than one minute's write limit allows.
    await sql`delete from mcp_rate_limits where token_id = ${writer.tokenId}`;
  });

  it("refuses to regenerate a draft a person edited since the agent read it", async () => {
    const created = await writer.tool("write_reply_draft", { action: "request_ai", conversationId: thread.conversationId });
    const draft = created.structured.draft as { draftId: string; revision: number };
    await sql`update drafts set revision = revision + 1, edited_body_text = 'A person wrote this.' where id = ${draft.draftId}`;
    const stale = await writer.tool("write_reply_draft", { action: "regenerate", draftId: draft.draftId, revision: draft.revision });
    expect(stale.structured.error).toMatchObject({ code: "stale_version" });
    const [row] = await sql<{ status: string; edited_body_text: string }[]>`select status, edited_body_text from drafts where id = ${draft.draftId}`;
    expect(row).toEqual({ status: "awaiting_review", edited_body_text: "A person wrote this." });
    await writer.tool("write_reply_draft", { action: "discard", draftId: draft.draftId, revision: draft.revision + 1 });
    await sql`delete from mcp_rate_limits where token_id = ${writer.tokenId}`;
  });

  it("assigns, notes, closes and reopens a reply handling, each event marked with the token", async () => {
    const claimed = await writer.tool("update_conversation", { action: "claim", recordId: thread.recordId });
    expect(claimed.structured).toMatchObject({ assignedTo: orgs[0].userId, changed: true });
    const refused = await writer.tool("update_conversation", { action: "assign", recordId: thread.recordId, assignedTo: memberId, expectedAssignedTo: null });
    expect(refused.isError).toBe(true);
    const assigned = await writer.tool("update_conversation", { action: "assign", recordId: thread.recordId, assignedTo: memberId, expectedAssignedTo: orgs[0].userId });
    expect(assigned.structured).toMatchObject({ assignedTo: memberId, changed: true });
    const assignments = await eventsOf(thread.recordId, "assignee.changed");
    expect(assignments).toHaveLength(2);
    expect(assignments.every((e) => (e.meta.via as { tokenId: string }).tokenId === writer.tokenId)).toBe(true);

    expect((await writer.tool("update_conversation", { action: "add_note", recordId: thread.recordId, text: "Wants pricing for 20 seats" })).structured.noteId).toEqual(expect.any(String));
    expect((await writer.tool("update_conversation", { action: "close", recordId: thread.recordId, reason: "Sent pricing by phone" })).isError).toBe(false);
    expect((await writer.tool("update_conversation", { action: "reopen", recordId: thread.recordId })).isError).toBe(false);
    const states = await eventsOf(thread.recordId, "workflow.state_changed");
    expect(states.slice(-2).map((e) => (e.meta.via as { tokenId: string }).tokenId)).toEqual([writer.tokenId, writer.tokenId]);
  });

  it("changes the reply type with the version it read and refuses an old version", async () => {
    const [{ context_version }] = await sql<{ context_version: number }[]>`select context_version from records where id = ${thread.recordId}`;
    const changed = await writer.tool("set_reply_type", { action: "change", recordId: thread.recordId, groupKey: "interested", replyTypeId: null, expectedContextVersion: context_version });
    expect(changed.isError, changed.text).toBe(false);
    expect(changed.structured.contextVersion).toBe(context_version + 1);
    expect((await eventsOf(thread.recordId, "reply_type.changed")).at(-1)?.meta).toMatchObject({ via: { tokenId: writer.tokenId } });
    const old = await writer.tool("set_reply_type", { action: "change", recordId: thread.recordId, groupKey: "interested", replyTypeId: null, expectedContextVersion: context_version });
    expect(old.isError).toBe(true);
  });

  it("creates, lists and completes a task due in the organization's time zone", async () => {
    const created = await writer.tool("manage_task", { action: "create", recordId: thread.recordId, name: "Send the contract", dueDay: "2026-11-20", assigneeId: memberId });
    expect(created.isError, created.text).toBe(false);
    const taskId = created.structured.taskId as string;
    const listed = await writer.tool("manage_task", { action: "list", recordId: thread.recordId });
    expect(listed.structured.tasks).toEqual([expect.objectContaining({ taskId, name: "Send the contract", assigneeId: memberId, dueAt: expect.stringMatching(/^2026-11-2[01]T/) })]);
    expect((await writer.tool("manage_task", { action: "complete", taskId, completed: true })).isError).toBe(false);
    expect((await writer.tool("manage_task", { action: "list", recordId: thread.recordId })).structured.tasks).toEqual([]);
  });

  it("logs write calls as changes and leaves a list call among the reads", async () => {
    const { listMcpToolCalls } = await import("@/contexts/tenancy/application/mcp-tool-calls");
    const { mcpToolCallDeps } = await import("@/contexts/tenancy/infrastructure/mcp-composition");
    const owner = { userId: orgs[0].userId, organizationId: orgs[0].organizationId, role: "owner" };
    const changes = (await listMcpToolCalls(mcpToolCallDeps(), owner, { writesOnly: true, before: null })).calls;
    expect(changes.some((c) => c.tool === "write_reply_draft" && c.action === "create_manual" && c.target.conversationId === thread.conversationId)).toBe(true);
    expect(changes.some((c) => c.tool === "manage_task" && c.action === "list")).toBe(false);
  });

  it("refuses the 21st change in a minute with rate_limited and the seconds to wait", async () => {
    const limited = await mcpCaller(sql, POST, orgs[0], WRITE);
    const missing = crypto.randomUUID();
    const results = [];
    for (let i = 0; i < 21; i++) results.push(await limited.tool("manage_task", { action: "complete", taskId: missing, completed: true }));
    expect(results.slice(0, 20).every((r) => (r.structured.error as { code: string }).code === "not_found")).toBe(true);
    expect(results[20].structured.error).toMatchObject({ code: "rate_limited", retryAfterSeconds: expect.any(Number) });
  });

  it("drops write from a member's token once the organization stops member write tokens", async () => {
    const member = await mcpCaller(sql, POST, { organizationId: orgs[0].organizationId, userId: memberId }, WRITE);
    const names = async () => ((await callMcp(POST, { era: "modern", token: member.token, method: "tools/list" })).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(await names()).toContain("update_conversation");
    await sql`update channel_settings set values = values || '{"memberWriteTokens": false}'::jsonb where organization_id = ${orgs[0].organizationId} and channel = 'mcp'`;
    expect(await names()).not.toContain("update_conversation");
    await sql`update channel_settings set values = values || '{"memberWriteTokens": true}'::jsonb where organization_id = ${orgs[0].organizationId} and channel = 'mcp'`;
  });
});
