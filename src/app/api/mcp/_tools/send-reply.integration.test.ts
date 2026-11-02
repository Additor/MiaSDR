import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

const SEND = ["mcp:read", "mcp:write", "mcp:send"];

describeDb("MCP send_reply: agent email replies", () => {
  useTestEnv({ AI_PROVIDER: "fake", MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  let org: TestOrg;
  let mailbox: string;
  let mailboxId: string;
  let agent: McpCaller;
  let n = 0;

  const setMcp = (values: Record<string, unknown>) =>
    sql`update channel_settings set values = values || ${sql.json(values as never)} where organization_id = ${org.organizationId} and channel = 'mcp'`;

  /**
   * An inbound reply on its own thread. With `campaign`, a campaign email reached the lead in that thread first; with
   * `failedCampaign`, the lead was enrolled and the only send failed; with `enrolledOnly`, nothing was sent at all.
   */
  async function conversation(opts: { campaign?: boolean; failedCampaign?: boolean; enrolledOnly?: boolean } = {}) {
    n += 1;
    const email = `lead${n}-${randomBytes(3).toString("hex")}@acme.test`;
    const threadId = `t-${org.organizationId}-${n}`;
    if (opts.campaign || opts.failedCampaign || opts.enrolledOnly) {
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org.organizationId}, 'email', ${`c${n}`}, 'active', ${sql.json([])}) returning id`;
      const [{ id: person }] = await sql`insert into people (organization_id, email, full_name) values (${org.organizationId}, ${email}, 'Lena Lead') returning id`;
      const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${org.organizationId}, ${campaign}, ${person}, 'email') returning id`;
      if (!opts.enrolledOnly) {
        await sql`
          insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, subject, body, thread_id, sent_at)
          values (${org.organizationId}, ${enrollment}, 1, 'email', ${opts.campaign ? "sent" : "failed"}, ${mailboxId}, 'Hello', 'Opening pitch', ${threadId}, now() - interval '2 hours')`;
      }
    }
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
      bodyText: "Can you send pricing?",
      receivedAt: new Date(Date.now() - 3_600_000),
      autoReply: false,
    });
    const [{ record_id }] = await sql<{ record_id: string }[]>`select record_id from conversations where id = ${result.conversationId}`;
    return { conversationId: result.conversationId, recordId: record_id };
  }

  /** A typed draft the agent wrote on the conversation. */
  async function draftOn(conversationId: string) {
    const created = await agent.tool("write_reply_draft", { action: "create_manual", conversationId, subject: "Re: Hello", bodyText: "Pricing attached." });
    expect(created.isError, created.text).toBe(false);
    return created.structured.draft as { draftId: string; revision: number };
  }

  const send = (conversationId: string, draft: { draftId: string; revision: number }, key = `key-${randomBytes(8).toString("hex")}`) =>
    agent.tool("send_reply", { conversationId, draftId: draft.draftId, revision: draft.revision, idempotencyKey: key });

  const codeOf = (result: { structured: Record<string, unknown> }) => (result.structured.error as { code?: string } | undefined)?.code;
  const listed = async (token: string) =>
    ((await callMcp(POST, { era: "modern", token, method: "tools/list" })).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    org = await createTestOrg(sql, "Agent sends");
    orgs.push(org);
    await enableMcp(sql, org.organizationId);
    mailbox = `sdr-${org.organizationId.slice(0, 8)}@corp.test`;
    [{ id: mailboxId }] = await sql<{ id: string }[]>`insert into mailboxes (organization_id, email_address, status) values (${org.organizationId}, ${mailbox}, 'connected') returning id`;
    await setMcp({ agentSendMode: "replies", agentSendEpoch: 0 });
    agent = await mcpCaller(sql, POST, org, SEND);
  });

  // Each test writes more drafts than one minute's write limit allows across the file.
  beforeEach(() => sql`delete from mcp_rate_limits where token_id = ${agent.tokenId}`);

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("sends a reply in a campaign thread as the agent, records who sent it, and replays the same key", async () => {
    const thread = await conversation({ campaign: true });
    const draft = await draftOn(thread.conversationId);
    const key = `key-${randomBytes(8).toString("hex")}`;
    const sent = await send(thread.conversationId, draft, key);
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.structured).toMatchObject({ status: "sent", replayed: false, retryable: false, appUrl: `http://localhost:3000/inbox/${thread.conversationId}` });

    const [attempt] = await sql`select origin, mcp_token_id, status, actor_user_id from send_attempts where draft_id = ${draft.draftId}`;
    expect(attempt).toMatchObject({ origin: "agent", mcp_token_id: agent.tokenId, status: "sent", actor_user_id: org.userId });
    const [event] = await sql<{ meta: Record<string, unknown> }[]>`select meta from events where record_id = ${thread.recordId} and event_type = 'draft.sent'`;
    expect(event.meta).toMatchObject({ via: { tokenId: agent.tokenId, tokenName: "Test agent" } });
    const [message] = await sql<{ raw: Record<string, unknown> }[]>`select raw from messages where conversation_id = ${thread.conversationId} and direction = 'outbound'`;
    expect(message.raw.sentVia).toBe("Test agent");
    expect(await sql`select 1 from mcp_tool_calls where token_id = ${agent.tokenId} and tool = 'send_reply' and error_code is null`).toHaveLength(1);

    const again = await send(thread.conversationId, draft, key);
    expect(again.structured).toMatchObject({ status: "sent", replayed: true });
    expect(await sql`select 1 from send_attempts where draft_id = ${draft.draftId}`).toHaveLength(1);
  });

  it("refuses a stranger, a lead whose campaign email failed, and a draft with CC", async () => {
    const stranger = await conversation();
    expect(codeOf(await send(stranger.conversationId, await draftOn(stranger.conversationId)))).toBe("agent_unverified_recipient");
    const failed = await conversation({ failedCampaign: true });
    expect(codeOf(await send(failed.conversationId, await draftOn(failed.conversationId)))).toBe("agent_unverified_recipient");

    const reached = await conversation({ campaign: true });
    const draft = await draftOn(reached.conversationId);
    await sql`update drafts set cc = array['boss@acme.test'] where id = ${draft.draftId}`;
    expect(codeOf(await send(reached.conversationId, draft))).toBe("agent_cc_not_allowed");
    expect(await sql`select 1 from send_attempts where organization_id = ${org.organizationId} and status = 'sending'`).toHaveLength(0);
  });

  it("refuses a lead who was only enrolled, one reached only on LinkedIn, and a thread whose person changed in a merge", async () => {
    const enrolled = await conversation({ enrolledOnly: true });
    expect(codeOf(await send(enrolled.conversationId, await draftOn(enrolled.conversationId)))).toBe("agent_unverified_recipient");

    const linkedinOnly = await conversation();
    const [{ person_id: personId }] = await sql<{ person_id: string }[]>`select person_id from records where id = ${linkedinOnly.recordId}`;
    const [{ id: account }] = await sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status) values (${org.organizationId}, ${`a-${randomBytes(4).toString("hex")}`}, ${`ACo-${randomBytes(4).toString("hex")}`}, 'Jo', 'connected') returning id`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org.organizationId}, 'linkedin', ${`li${n}`}, 'active', ${sql.json([])}) returning id`;
    const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${org.organizationId}, ${campaign}, ${personId}, 'linkedin') returning id`;
    await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, body, sent_at) values (${org.organizationId}, ${enrollment}, 1, 'linkedin', 'sent', ${account}, 'Hi', now() - interval '1 day')`;
    expect(codeOf(await send(linkedinOnly.conversationId, await draftOn(linkedinOnly.conversationId)))).toBe("agent_unverified_recipient");

    const merged = await conversation({ campaign: true });
    const [{ id: other }] = await sql`insert into people (organization_id, email, full_name) values (${org.organizationId}, ${`merged-${n}@acme.test`}, 'Someone Else') returning id`;
    const draft = await draftOn(merged.conversationId);
    await sql`update records set person_id = ${other} where id = ${merged.recordId}`;
    expect(codeOf(await send(merged.conversationId, draft))).toBe("agent_unverified_recipient");
  });

  it("holds an agent's reply under PAUSE_OUTBOUND and lets a person's through", async () => {
    const thread = await conversation({ campaign: true });
    const draft = await draftOn(thread.conversationId);
    vi.stubEnv("PAUSE_OUTBOUND", "true");
    try {
      expect(codeOf(await send(thread.conversationId, draft))).toBe("agent_send_paused");
      const { approveAndSendDraft } = await import("@/contexts/conversations/application/reply-management");
      const { replySendDeps } = await import("@/contexts/conversations/infrastructure/reply-send-composition");
      const person = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
      expect((await approveAndSendDraft(replySendDeps(), person, draft.draftId, { revision: draft.revision, idempotencyKey: `person-${randomBytes(6).toString("hex")}` })).status).toBe("sent");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stops at the mailbox limit", async () => {
    await setMcp({ agentReplyCaps: { org: 100, user: 50, mailbox: 0 } });
    try {
      const thread = await conversation({ campaign: true });
      expect(codeOf(await send(thread.conversationId, await draftOn(thread.conversationId)))).toBe("agent_daily_cap");
    } finally {
      await setMcp({ agentReplyCaps: { org: 100, user: 50, mailbox: 30 } });
    }
  });

  it("does not count a definite failure against the day's gap: a new key sends, and the same key replays the failure", async () => {
    const thread = await conversation({ campaign: true });
    const draft = await draftOn(thread.conversationId);
    const { approveAndSendDraft } = await import("@/contexts/conversations/application/reply-management");
    const { replySendDeps } = await import("@/contexts/conversations/infrastructure/reply-send-composition");
    const { ReplySendError } = await import("@/contexts/conversations/application/reply-ports");
    const real = replySendDeps();
    let calls = 0;
    const deps = {
      ...real,
      mailer: {
        ...real.mailer,
        send: (request: Parameters<typeof real.mailer.send>[0]) => {
          calls += 1;
          if (calls === 1) throw new ReplySendError("The mailbox refused it.", "definite");
          return real.mailer.send(request);
        },
      },
    };
    const actor = { userId: org.userId, organizationId: org.organizationId, role: "owner", via: { kind: "agent" as const, tokenId: agent.tokenId, tokenName: "Test agent", clientName: null } };
    const firstKey = `first-${randomBytes(6).toString("hex")}`;
    expect((await approveAndSendDraft(deps, actor, draft.draftId, { revision: draft.revision, idempotencyKey: firstKey })).status).toBe("failed");
    expect(await approveAndSendDraft(deps, actor, draft.draftId, { revision: draft.revision, idempotencyKey: firstKey })).toMatchObject({ status: "failed", replayed: true });
    const [{ revision }] = await sql<{ revision: number }[]>`select revision from drafts where id = ${draft.draftId}`;
    expect((await approveAndSendDraft(deps, actor, draft.draftId, { revision, idempotencyKey: `second-${randomBytes(6).toString("hex")}` })).status).toBe("sent");
    expect(calls).toBe(2);
  });

  it("makes a policy save wait for an agent reply or start that holds the lock", async () => {
    const { updateMcpSettings } = await import("@/contexts/tenancy/application/mcp-tokens");
    const { mcpTokenDeps } = await import("@/contexts/tenancy/infrastructure/mcp-composition");
    const owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    for (const [take, mailbox] of [["pg_advisory_xact_lock", 31], ["pg_advisory_xact_lock_shared", 30]] as const) {
      const lock = await sql.reserve();
      try {
        await lock`begin`;
        await lock.unsafe(`select ${take}(hashtextextended($1, 0))`, [`agent-send:${org.organizationId}`]);
        let saved = false;
        const save = updateMcpSettings(mcpTokenDeps(), owner, { agentReplyCaps: { org: 100, user: 50, mailbox } }).then(() => {
          saved = true;
        });
        await waitForLockWaiters(sql, 1, 10_000, "%pg_advisory_xact_lock%");
        expect(saved).toBe(false);
        await lock`commit`;
        await save;
        expect(saved).toBe(true);
      } finally {
        lock.release();
      }
    }
  });

  it("refuses a draft longer than an answer shows, so the agent sends only text it read whole", async () => {
    const thread = await conversation({ campaign: true });
    const draft = await draftOn(thread.conversationId);
    await sql`update drafts set edited_body_text = ${"Long text. ".repeat(1200)} where id = ${draft.draftId}`;
    expect(codeOf(await send(thread.conversationId, draft))).toBe("draft_not_read");
    expect(await sql`select 1 from send_attempts where draft_id = ${draft.draftId}`).toHaveLength(0);
  });

  it("sends where a person already replied, and waits a day before the agent replies there again", async () => {
    const thread = await conversation();
    const { approveAndSendDraft } = await import("@/contexts/conversations/application/reply-management");
    const { replySendDeps } = await import("@/contexts/conversations/infrastructure/reply-send-composition");
    const first = await draftOn(thread.conversationId);
    const person = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    expect((await approveAndSendDraft(replySendDeps(), person, first.draftId, { revision: first.revision, idempotencyKey: `person-${randomBytes(6).toString("hex")}` })).status).toBe("sent");

    const sent = await send(thread.conversationId, await draftOn(thread.conversationId));
    expect(sent.structured.status, sent.text).toBe("sent");
    const gap = await send(thread.conversationId, await draftOn(thread.conversationId));
    expect(codeOf(gap)).toBe("agent_reply_gap");
    expect((gap.structured.error as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(23 * 3600);
  });

  it("refuses while the organization's sending is paused", async () => {
    const thread = await conversation({ campaign: true });
    const draft = await draftOn(thread.conversationId);
    await sql`insert into channel_settings (organization_id, channel, values) values (${org.organizationId}, 'general', ${sql.json({ sendingPaused: { at: new Date().toISOString(), byName: "Jo" } })})
      on conflict (organization_id, channel) do update set values = channel_settings.values || excluded.values`;
    try {
      expect(codeOf(await send(thread.conversationId, draft))).toBe("agent_send_paused");
    } finally {
      await sql`update channel_settings set values = values - 'sendingPaused' where organization_id = ${org.organizationId} and channel = 'general'`;
    }
  });

  it("lets one of two agent replies through at the organization's daily limit, the other waiting on the lock", async () => {
    const used = (await sql<{ n: number }[]>`select count(*)::int as n from send_attempts where organization_id = ${org.organizationId} and origin = 'agent' and status <> 'failed'`)[0].n;
    await setMcp({ agentReplyCaps: { org: used + 1, user: 50, mailbox: 30 } });
    try {
      const a = await conversation({ campaign: true });
      const b = await conversation({ campaign: true });
      const [draftA, draftB] = [await draftOn(a.conversationId), await draftOn(b.conversationId)];
      const lock = await sql.reserve();
      try {
        await lock`begin`;
        await lock`select pg_advisory_xact_lock(hashtextextended(${`agent-send:${org.organizationId}`}, 0))`;
        const both = Promise.all([send(a.conversationId, draftA), send(b.conversationId, draftB)]);
        await waitForLockWaiters(sql, 2);
        await lock`commit`;
        const results = await both;
        expect(results.map((r) => r.structured.status ?? codeOf(r)).sort()).toEqual(["agent_daily_cap", "sent"]);
        const capped = results.find((r) => codeOf(r) === "agent_daily_cap")!;
        expect((capped.structured.error as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
      } finally {
        lock.release();
      }
    } finally {
      await setMcp({ agentReplyCaps: { org: 100, user: 50, mailbox: 30 } });
    }
  });

  it("hides send_reply while agent sending is off, and a token from before it went off stays unable to send", async () => {
    const writer = await mcpCaller(sql, POST, org, ["mcp:read", "mcp:write"]);
    expect(await listed(agent.token)).toContain("send_reply");
    expect(await listed(writer.token)).not.toContain("send_reply");

    const { updateMcpSettings } = await import("@/contexts/tenancy/application/mcp-tokens");
    const { mcpTokenDeps } = await import("@/contexts/tenancy/infrastructure/mcp-composition");
    const owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    const off = await updateMcpSettings(mcpTokenDeps(), owner, { agentSendMode: "off" });
    expect(off.agentSendEpoch).toBe(1);
    expect(await listed(agent.token)).not.toContain("send_reply");
    await updateMcpSettings(mcpTokenDeps(), owner, { agentSendMode: "replies" });
    expect(await listed(agent.token)).not.toContain("send_reply");
    const [audit] = await sql<{ meta: Record<string, unknown> }[]>`select meta from audit_log where organization_id = ${org.organizationId} and action = 'mcp.agent_send_mode' order by created_at limit 1`;
    expect(audit.meta).toEqual({ from: "replies", to: "off" });

    // The store reads the policy again under the lock, so a send that reached it with the old token is refused too.
    const thread = await conversation({ campaign: true });
    const draft = await draftOn(thread.conversationId);
    const { approveAndSendDraft } = await import("@/contexts/conversations/application/reply-management");
    const { replySendDeps } = await import("@/contexts/conversations/infrastructure/reply-send-composition");
    const viaOld = { ...owner, via: { kind: "agent" as const, tokenId: agent.tokenId, tokenName: "Test agent", clientName: null } };
    await expect(approveAndSendDraft(replySendDeps(), viaOld, draft.draftId, { revision: draft.revision, idempotencyKey: `old-${randomBytes(6).toString("hex")}` })).rejects.toMatchObject({
      details: { code: "agent_send_off" },
    });
  });
});
