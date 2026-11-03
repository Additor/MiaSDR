import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * No sequence of MCP calls opens the agent send gate on a reply that asks to stop, and the reply stays in front of a person
 * while the gate holds. Each row runs one way out of the gate on one way a pick reads the reply.
 */
describeDb("the agent send gate on a stop request", () => {
  useTestEnv({ AI_PROVIDER: "fake", MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  let POST: (request: Request) => Promise<Response>;
  let org: TestOrg;
  let mailbox: string;
  let mailboxId: string;
  let agent: McpCaller;
  let n = 0;

  const codeOf = (r: { structured: Record<string, unknown> }) => (r.structured.error as { code?: string } | undefined)?.code;

  async function conversation(body = "Please stop emailing me.") {
    n += 1;
    const email = `lead${n}-${randomBytes(3).toString("hex")}@acme.test`;
    const threadId = `t-${org.organizationId}-${n}`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org.organizationId}, 'email', ${`c${n}`}, 'active', ${sql.json([])}) returning id`;
    const [{ id: person }] = await sql`insert into people (organization_id, email, full_name) values (${org.organizationId}, ${email}, 'Lena Lead') returning id`;
    const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${org.organizationId}, ${campaign}, ${person}, 'email') returning id`;
    await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, subject, body, thread_id, sent_at)
      values (${org.organizationId}, ${enrollment}, 1, 'email', 'sent', ${mailboxId}, 'Hello', 'Opening pitch', ${threadId}, now() - interval '2 hours')`;
    const { ingestInbound } = await import("@/contexts/conversations/infrastructure/composition");
    const result = await ingestInbound({
      organizationId: org.organizationId,
      accountRef: mailbox,
      providerThreadId: threadId,
      providerMessageId: `m-${org.organizationId}-${n}`,
      rfcMessageId: `<${org.organizationId}-${n}@x.test>`,
      inReplyTo: null,
      from: { email, name: "Lena Lead" },
      to: [mailbox],
      subject: "Re: Hello",
      bodyText: body,
      receivedAt: new Date(Date.now() - 3_600_000),
      autoReply: false,
    });
    const [{ record_id }] = await sql<{ record_id: string }[]>`select record_id from conversations where id = ${result.conversationId}`;
    return { conversationId: result.conversationId, recordId: record_id, personId: person as string };
  }

  async function types(recordId: string) {
    const all = await sql<{ id: string; key: string; group_key: string; system_role: string | null }[]>`
      select t.id, t.key, t.group_key, t.system_role from reply_types t join records r on r.reply_type_set_id = t.reply_type_set_id where r.id = ${recordId} and t.active`;
    return { applied: all.find((t) => !t.system_role && t.group_key === "interested")!, other: all.find((t) => !t.system_role && t.group_key !== "interested")!, stop: all.find((t) => t.system_role === "stop_request")! };
  }

  type PickKind = "proposed" | "proposed_role" | "auto_applied";
  async function seedPick(thread: { recordId: string }, kind: PickKind) {
    const t = await types(thread.recordId);
    const [{ message_id }] = await sql<{ message_id: string }[]>`select latest_inbound_message_id as message_id from records where id = ${thread.recordId}`;
    if (kind === "auto_applied") {
      await sql`update records set group_key = ${t.applied.group_key}, reply_type_id = ${t.applied.id}, reply_type_source = 'ai' where id = ${thread.recordId}`;
      const [{ id }] = await sql<{ id: string }[]>`
        insert into reply_type_picks (organization_id, record_id, message_id, status, confidence, response, expected_context_version, proposed_group_key, proposed_reply_type_id, applied_group_key, applied_reply_type_id)
        select organization_id, id, ${message_id}, 'auto_applied', 0.9, ${sql.json({ stopRequested: true })}, context_version, ${t.applied.group_key}, ${t.applied.id}, ${t.applied.group_key}, ${t.applied.id} from records where id = ${thread.recordId} returning id`;
      return { pick: id, t };
    }
    const role = kind === "proposed_role";
    const [{ id }] = await sql<{ id: string }[]>`
      insert into reply_type_picks (organization_id, record_id, message_id, status, confidence, response, expected_context_version, proposed_group_key, proposed_reply_type_id)
      select organization_id, id, ${message_id}, 'proposed', 0.9, ${sql.json(role ? {} : { stopRequested: true })}, context_version, ${role ? t.stop.group_key : null}, ${role ? t.stop.id : null} from records where id = ${thread.recordId} returning id`;
    return { pick: id, t };
  }

  /** The code a send answers on a fresh draft: the gate's refusal, or none when the send went out. */
  async function sendCode(conversationId: string) {
    const created = await agent.tool("write_reply_draft", { action: "create_manual", conversationId, subject: "Re: Hello", bodyText: "One more thing." });
    expect(created.isError).toBeFalsy();
    const d = created.structured.draft as { draftId: string; revision: number };
    const sent = await agent.tool("send_reply", { conversationId, draftId: d.draftId, revision: d.revision, idempotencyKey: `k-${randomBytes(8).toString("hex")}` });
    return codeOf(sent) ?? sent.structured.status;
  }

  /** A draft the gate refused puts the row under replies first, so this reads every group. */
  const queued = async (recordId: string) => JSON.stringify((await agent.tool("get_work_queue", { limit: 40 })).structured).includes(recordId);

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    org = await createTestOrg(sql, "Stop gate");
    await enableMcp(sql, org.organizationId);
    mailbox = `sdr-${org.organizationId.slice(0, 8)}@corp.test`;
    [{ id: mailboxId }] = await sql<{ id: string }[]>`insert into mailboxes (organization_id, email_address, status) values (${org.organizationId}, ${mailbox}, 'connected') returning id`;
    await sql`update channel_settings set values = values || ${sql.json({ agentSendMode: "replies", agentSendEpoch: 0 } as never)} where organization_id = ${org.organizationId} and channel = 'mcp'`;
    agent = await mcpCaller(sql, POST, org, ["mcp:read", "mcp:write", "mcp:send"]);
  });
  beforeEach(() => sql`delete from mcp_rate_limits where token_id = ${agent.tokenId}`);
  afterAll(async () => {
    try {
      await dropOrgs(sql, [org]);
    } finally {
      await sql.end();
    }
  });

  const exits: Array<{ name: string; run: (a: { recordId: string; pick: string; t: Awaited<ReturnType<typeof types>> }) => Promise<unknown> }> = [
    {
      name: "change",
      run: async ({ recordId, t }) => {
        const [{ v }] = await sql<{ v: number }[]>`select context_version as v from records where id = ${recordId}`;
        return agent.tool("set_reply_type", { action: "change", recordId, groupKey: t.other.group_key, replyTypeId: t.other.id, expectedContextVersion: v });
      },
    },
    { name: "confirm_pick", run: ({ pick }) => agent.tool("set_reply_type", { action: "confirm_pick", replyTypePickId: pick }) },
    { name: "undo_pick", run: ({ pick }) => agent.tool("set_reply_type", { action: "undo_pick", replyTypePickId: pick }) },
    {
      name: "close and reopen",
      run: async ({ recordId }) => {
        await agent.tool("update_conversation", { action: "close", recordId, reason: "done" });
        return agent.tool("update_conversation", { action: "reopen", recordId });
      },
    },
  ];

  describe.each<PickKind>(["proposed", "proposed_role", "auto_applied"])("a %s pick", (kind) => {
    it.each(exits)("stays closed and listed after an agent's $name", async ({ run }) => {
      const thread = await conversation();
      const { pick, t } = await seedPick(thread, kind);
      expect(await sendCode(thread.conversationId)).toBe("agent_stop_requested");
      await sql`update drafts set status = 'stale' where record_id = ${thread.recordId} and status = 'awaiting_review'`;
      await run({ recordId: thread.recordId, pick, t });
      expect(await sendCode(thread.conversationId)).toBe("agent_stop_requested");
      expect(await queued(thread.recordId)).toBe(true);
    });
  });

  it("keeps a person with an open stop request out of a campaign, until a person reviews it", async () => {
    const thread = await conversation();
    await seedPick(thread, "proposed");
    const made = await agent.tool("draft_campaign", { action: "create", channel: "email", name: `Stop ${randomBytes(3).toString("hex")}` });
    const campaignId = made.structured.campaignId as string;
    const add = () => agent.tool("draft_campaign", { action: "add_leads", channel: "email", campaignId, personIds: [thread.personId] });
    expect((await add()).structured).toMatchObject({ enroll: { added: 0, skipped: { stopRequest: 1 } } });
    await sql`insert into stop_reviews (organization_id, message_id, reviewed_at) select organization_id, latest_inbound_message_id, now() from records where id = ${thread.recordId}`;
    expect((await add()).structured).toMatchObject({ enroll: { added: 1 } });
  });

  describe("a held pick that does not ask to stop", () => {
    async function held(body = "Tell me more.") {
      const thread = await conversation(body);
      const t = await types(thread.recordId);
      const [{ message_id, v }] = await sql<{ message_id: string; v: number }[]>`select latest_inbound_message_id as message_id, context_version as v from records where id = ${thread.recordId}`;
      await sql`insert into reply_type_picks (organization_id, record_id, message_id, status, confidence, response, expected_context_version, proposed_group_key, proposed_reply_type_id)
        select organization_id, id, ${message_id}, 'proposed', 0.5, ${sql.json({})}, context_version, ${t.applied.group_key}, ${t.applied.id} from records where id = ${thread.recordId}`;
      return { ...thread, t, v };
    }

    it("lets an agent accept it, as the person's Accept does", async () => {
      const thread = await held();
      const answer = await agent.tool("set_reply_type", { action: "accept_pick", conversationId: thread.conversationId, expectedContextVersion: thread.v });
      expect(answer.isError).toBeFalsy();
      const [pick] = await sql`select status from reply_type_picks where record_id = ${thread.recordId} order by created_at desc limit 1`;
      expect(pick.status).toBe("accepted");
    });

    it("lets an agent override it with another type, and names the token on the event", async () => {
      const thread = await held();
      const answer = await agent.tool("set_reply_type", { action: "override_pick", conversationId: thread.conversationId, replyTypeKey: thread.t.other.key, expectedContextVersion: thread.v });
      expect(answer.isError).toBeFalsy();
      const [event] = await sql`select meta->'via'->>'tokenName' as via from events where record_id = ${thread.recordId} and event_type = 'reply_type_pick.overridden'`;
      expect(event.via).toBeTruthy();
    });

    it("refuses a pick on a closed record", async () => {
      const thread = await held();
      await agent.tool("update_conversation", { action: "close", recordId: thread.recordId, reason: "done" });
      const [{ v }] = await sql<{ v: number }[]>`select context_version as v from records where id = ${thread.recordId}`;
      const answer = await agent.tool("set_reply_type", { action: "override_pick", conversationId: thread.conversationId, replyTypeKey: thread.t.other.key, expectedContextVersion: v });
      expect(answer.isError).toBe(true);
    });
  });

  it("refuses an agent's accept of a held stop request, and an override leaves the gate closed", async () => {
    const thread = await conversation();
    const { t } = await seedPick(thread, "proposed_role");
    const [{ v }] = await sql<{ v: number }[]>`select context_version as v from records where id = ${thread.recordId}`;
    const accept = await agent.tool("set_reply_type", { action: "accept_pick", conversationId: thread.conversationId, expectedContextVersion: v });
    expect(accept.isError).toBe(true);
    expect(await agent.tool("set_reply_type", { action: "override_pick", conversationId: thread.conversationId, replyTypeKey: t.other.key, expectedContextVersion: v })).toMatchObject({ isError: false });
    expect(await sendCode(thread.conversationId)).toBe("agent_stop_requested");
  });

  it("refuses a reply whose own words ask to stop before any pick read it", async () => {
    const thread = await conversation();
    expect(await sendCode(thread.conversationId)).toBe("agent_stop_requested");
  });

  it("lets an agent send once a person changed the type, and leaves the row out of the queue", async () => {
    const thread = await conversation();
    const { t } = await seedPick(thread, "proposed");
    const { replyHandlingDeps } = await import("@/contexts/conversations/infrastructure/reply-handling-composition");
    const { changeReplyType } = await import("@/contexts/conversations/application/reply-handling");
    const [{ v }] = await sql<{ v: number }[]>`select context_version as v from records where id = ${thread.recordId}`;
    await changeReplyType(replyHandlingDeps(), { userId: org.userId, organizationId: org.organizationId, role: "owner" }, thread.recordId, { groupKey: t.other.group_key, replyTypeId: t.other.id, expectedContextVersion: v, confirmUnlock: false });
    expect(await sendCode(thread.conversationId)).toBe("sent");
    expect(await queued(thread.recordId)).toBe(false);
  });

  it("lets an agent send once a person looked at the applied pick", async () => {
    const thread = await conversation();
    const { pick } = await seedPick(thread, "auto_applied");
    const { replyHandlingDeps } = await import("@/contexts/conversations/infrastructure/reply-handling-composition");
    const { acknowledgeReplyTypePick } = await import("@/contexts/conversations/application/reply-handling");
    await acknowledgeReplyTypePick(replyHandlingDeps(), { userId: org.userId, organizationId: org.organizationId, role: "owner" }, pick);
    expect(await sendCode(thread.conversationId)).toBe("sent");
  });
});
