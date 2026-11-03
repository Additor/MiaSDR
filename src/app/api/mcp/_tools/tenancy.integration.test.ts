import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { mcpCaller, type McpCaller, type ToolCallResult } from "@/test-support/mcp-fixture";
import { actionToken } from "@/shared/action-token";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** Every id a call could aim at in the other organization, and the matching rows of the caller's own. */
interface Ids {
  lead: string;
  contact: string;
  conversation: string;
  record: string;
  draft: string;
  pick: string;
  task: string;
  deal: string;
  dealVersion: number;
  stage: string;
  table: string;
  search: string;
  emailCampaign: string;
  linkedinCampaign: string;
  enrollment: string;
  replyType: string;
  linkedinAccount: string;
  member: string;
  own: { campaign: string; conversation: string; record: string; deal: string; dealVersion: number };
}

type Args = (ids: Ids) => Record<string, unknown>;

/**
 * One entry per tool, so a new tool fails the suite until someone says how an id of another organization reaches it.
 * `refused` calls name the other organization's row and answer not_found.
 * `filtered` calls take an id as a filter, or no id at all, and answer without the other organization's data.
 * `crossed` calls mix the caller's row with another organization's id, and write nothing to either organization.
 */
const SPEC: Record<string, { refused?: Args[]; filtered?: Args[]; crossed?: Args[] }> = {
  get_workspace: { filtered: [() => ({})] },
  get_work_queue: { filtered: [() => ({}), (i) => ({ campaignId: i.emailCampaign }), (i) => ({ replyTypeId: i.replyType })] },
  list_inbox: { filtered: [() => ({}), (i) => ({ personIds: [i.contact] }), (i) => ({ campaignIds: [i.emailCampaign] })] },
  get_conversation: { refused: [(i) => ({ conversationId: i.conversation }), (i) => ({ recordId: i.record })] },
  search_people: { filtered: [() => ({}), (i) => ({ campaign: i.emailCampaign }), (i) => ({ notInCampaignId: i.emailCampaign })] },
  get_person: { refused: [(i) => ({ personId: i.lead }), (i) => ({ personId: i.contact })] },
  list_campaigns: { filtered: [() => ({})] },
  get_campaign: { refused: [(i) => ({ channel: "email", campaignId: i.emailCampaign }), (i) => ({ channel: "linkedin", campaignId: i.linkedinCampaign })] },
  get_analytics: { filtered: [() => ({ view: "campaigns" }), (i) => ({ view: "campaigns", campaignId: i.emailCampaign }), (i) => ({ view: "linkedin", linkedinAccountId: i.linkedinAccount })] },
  get_pipeline: { refused: [(i) => ({ dealId: i.deal })], filtered: [() => ({}), (i) => ({ stageId: i.stage })] },
  get_sending_health: { filtered: [() => ({})] },
  list_tables: { filtered: [() => ({})] },
  get_table: { refused: [(i) => ({ tableId: i.table })] },
  list_linkedin_searches: { filtered: [() => ({})] },
  write_reply_draft: {
    refused: [
      (i) => ({ action: "request_ai", conversationId: i.conversation }),
      (i) => ({ action: "create_manual", conversationId: i.conversation, subject: "Re: Hello", bodyText: "Written across organizations." }),
      (i) => ({ action: "edit", draftId: i.draft, revision: 1, bodyText: "Edited across organizations." }),
      (i) => ({ action: "regenerate", draftId: i.draft, revision: 1 }),
      (i) => ({ action: "discard", draftId: i.draft, revision: 1 }),
    ],
  },
  set_reply_type: {
    refused: [
      (i) => ({ action: "change", recordId: i.record, groupKey: "interested", expectedContextVersion: 0 }),
      (i) => ({ action: "undo_pick", replyTypePickId: i.pick }),
    ],
    crossed: [(i) => ({ action: "change", recordId: i.own.record, replyTypeId: i.replyType, expectedContextVersion: 0 })],
  },
  update_conversation: {
    refused: [
      (i) => ({ action: "add_note", recordId: i.record, text: "Across organizations." }),
      (i) => ({ action: "assign", recordId: i.record, assignedTo: i.member, expectedAssignedTo: null }),
      (i) => ({ action: "claim", recordId: i.record }),
      (i) => ({ action: "close", recordId: i.record, reason: "done" }),
      (i) => ({ action: "reopen", recordId: i.record }),
    ],
    crossed: [(i) => ({ action: "assign", recordId: i.own.record, assignedTo: i.member, expectedAssignedTo: null })],
  },
  manage_task: {
    refused: [
      (i) => ({ action: "list", recordId: i.record }),
      (i) => ({ action: "create", recordId: i.record, name: "Across organizations" }),
      (i) => ({ action: "create", personId: i.contact, name: "Across organizations" }),
      (i) => ({ action: "update", taskId: i.task, name: "Across organizations" }),
      (i) => ({ action: "complete", taskId: i.task, completed: true }),
    ],
    crossed: [(i) => ({ action: "create", recordId: i.own.record, name: "Assigned across", assigneeId: i.member })],
  },
  pause_sending: {
    refused: [(i) => ({ target: "campaign", channel: "email", campaignId: i.emailCampaign }), (i) => ({ target: "campaign", channel: "linkedin", campaignId: i.linkedinCampaign }), (i) => ({ target: "follow_ups", recordId: i.record })],
  },
  draft_campaign: {
    refused: [
      (i) => ({ action: "update", channel: "email", campaignId: i.emailCampaign, name: "Across organizations" }),
      (i) => ({ action: "update", channel: "linkedin", campaignId: i.linkedinCampaign, name: "Across organizations" }),
      (i) => ({ action: "add_leads", channel: "email", campaignId: i.emailCampaign, query: "a" }),
      (i) => ({ action: "add_leads", channel: "email", campaignId: i.emailCampaign, personIds: [i.lead] }),
      (i) => ({ action: "remove_lead", channel: "email", campaignId: i.emailCampaign, enrollmentIds: [i.enrollment] }),
    ],
    crossed: [
      (i) => ({ action: "add_leads", channel: "email", campaignId: i.own.campaign, personIds: [i.lead] }),
      (i) => ({ action: "remove_lead", channel: "email", campaignId: i.own.campaign, enrollmentIds: [i.enrollment] }),
    ],
  },
  update_deal: {
    refused: [(i) => ({ action: "move_stage", dealId: i.deal, expectedVersion: i.dealVersion, stageId: i.stage }), (i) => ({ action: "edit", dealId: i.deal, expectedVersion: i.dealVersion, title: "Across organizations" })],
    crossed: [(i) => ({ action: "move_stage", dealId: i.own.deal, expectedVersion: i.own.dealVersion, stageId: i.stage }), (i) => ({ action: "edit", dealId: i.own.deal, expectedVersion: i.own.dealVersion, ownerId: i.member })],
  },
  // Takes a CSV and a preview token, which name no row.
  import_leads: {},
  stop_enrichment: { refused: [(i) => ({ tableId: i.table })] },
  cancel_linkedin_search: { refused: [(i) => ({ searchId: i.search })] },
  send_reply: {
    refused: [(i) => ({ conversationId: i.conversation, draftId: i.draft, revision: 1, idempotencyKey: randomUUID() })],
    crossed: [(i) => ({ conversationId: i.own.conversation, draftId: i.draft, revision: 1, idempotencyKey: randomUUID() })],
  },
  preview_campaign_launch: { refused: [(i) => ({ channel: "email", campaignId: i.emailCampaign, purpose: "start" }), (i) => ({ channel: "linkedin", campaignId: i.linkedinCampaign, purpose: "start" })] },
  launch_campaign: { refused: [(i) => ({ channel: "email", campaignId: i.emailCampaign, action: "start", launchToken: "made-up" })] },
  run_enrichment: { refused: [(i) => ({ tableId: i.table, columnKey: "name", firstN: 1, dryRun: true }), (i) => ({ tableId: i.table, columnKey: "name", firstN: 1, actionToken: "made-up" })] },
  // Takes a name and a search URL, and starts a search in the caller's organization.
  create_linkedin_search: {},
  preview_irreversible: {
    refused: [
      (i) => ({ kind: "complete_campaign", channel: "email", campaignId: i.emailCampaign }),
      (i) => ({ kind: "delete_draft_campaign", channel: "email", campaignId: i.emailCampaign }),
      (i) => ({ kind: "delete_lead", personId: i.lead }),
      (i) => ({ kind: "delete_contact", personId: i.contact }),
      (i) => ({ kind: "delete_deal", dealId: i.deal }),
    ],
  },
  apply_irreversible: {
    refused: [
      (i) => ({ kind: "complete_campaign", channel: "email", campaignId: i.emailCampaign, actionToken: "made-up" }),
      (i) => ({ kind: "delete_draft_campaign", channel: "email", campaignId: i.emailCampaign, actionToken: "made-up" }),
      (i) => ({ kind: "delete_lead", personId: i.lead, actionToken: "made-up" }),
      // These two read the token before the row, so a token built for the row is what reaches the row's check.
      (i) => ({ kind: "delete_contact", personId: i.contact, actionToken: actionToken("delete_contact", i.contact, { deals: 0, notes: 0, tasks: 0, events: 0, conversations: 0, messages: 0, sends: 0 }) }),
      (i) => ({ kind: "delete_deal", dealId: i.deal, actionToken: actionToken("delete_deal", i.deal, { version: i.dealVersion }) }),
    ],
  },
};

const MARKER = "Zzforeignmarker";
const ALL_SCOPES = ["mcp:read", "mcp:write", "mcp:send", "mcp:spend", "mcp:irreversible"];

const allCases = (key: "refused" | "filtered" | "crossed") => Object.entries(SPEC).flatMap(([tool, spec]) => (spec[key] ?? []).map((args, n) => ({ label: `${tool} #${n + 1}`, tool, args })));

describeDb("MCP tools across organizations", () => {
  useTestEnv({ AI_PROVIDER: "fake", MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];
  let POST: (request: Request) => Promise<Response>;
  let TOOL_LIST: typeof import("./registry").TOOLS;
  let org: TestOrg;
  let other: TestOrg;
  let agent: McpCaller;
  let ids: Ids;

  /** A hash of every row with an organization_id in the organization, so a write to any table shows. */
  async function rowsOf(organizationId: string, leaveOut: string[] = []): Promise<Record<string, string>> {
    const tables = await sql<{ table_name: string }[]>`select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name) where c.column_name = 'organization_id' and c.table_schema = 'public' and t.table_type = 'BASE TABLE'`;
    const union = tables
      .filter((t) => !leaveOut.includes(t.table_name))
      .map((t) => `select '${t.table_name}' as t, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from "${t.table_name}" x where organization_id = $1`)
      .join(" union all ");
    const rows = await sql.unsafe<{ t: string; h: string }[]>(union, [organizationId]);
    return Object.fromEntries(rows.map((r) => [r.t, r.h]));
  }

  /** Names that give the other organization's rows away in an answer. The caller's own rows go by another name. */
  const nameIn = (target: TestOrg) => (target === other ? MARKER : "Home");

  async function seedThread(target: TestOrg, tag: string) {
    const { ingestInbound } = await import("@/contexts/conversations/infrastructure/composition");
    const key = randomUUID();
    const email = `${tag}-${key.slice(0, 6)}@acme.test`;
    await ingestInbound({
      organizationId: target.organizationId,
      accountRef: "sdr@corp.test",
      providerThreadId: `t-${key}`,
      providerMessageId: `m-${key}`,
      rfcMessageId: `<${key}@x.test>`,
      inReplyTo: null,
      from: { email, name: `${nameIn(target)} ${tag}` },
      to: ["sdr@corp.test"],
      subject: "Re: Hello",
      bodyText: `${nameIn(target)} wrote this.`,
      receivedAt: new Date(Date.now() - 3_600_000),
      attachments: [],
    } as never);
    const [row] = await sql<{ person: string; conversation: string; record: string; message: string }[]>`
      select p.id as person, c.id as conversation, c.record_id as record, m.id as message
      from people p join records r on r.person_id = p.id join conversations c on c.record_id = r.id join messages m on m.conversation_id = c.id
      where p.organization_id = ${target.organizationId} and p.email = ${email}`;
    await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${row.person}`;
    return row;
  }

  const campaign = async (target: TestOrg, channel: string, status = "draft") => {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into campaigns (organization_id, channel, name, status, steps) values (${target.organizationId}, ${channel}, ${`${nameIn(target)} ${channel}`}, ${status}, ${sql.json([])}) returning id`;
    return id;
  };

  async function seedDeal(target: TestOrg, contact: string) {
    const { createDealForContact } = await import("@/contexts/deals/application/deal-create");
    const { dealsDeps } = await import("@/composition/deals");
    const owner = { userId: target.userId, organizationId: target.organizationId, role: "owner" };
    const { dealId } = await createDealForContact(dealsDeps(), owner, contact, { title: `${nameIn(target)} deal`, idempotencyKey: randomUUID() });
    const [{ version }] = await sql<{ version: number }[]>`select version from deals where id = ${dealId}`;
    return { dealId, version };
  }

  async function seed(): Promise<Ids> {
    const o = other.organizationId;
    const [{ id: lead }] = await sql<{ id: string }[]>`insert into people (organization_id, email, full_name, lifecycle) values (${o}, ${`lead-${randomUUID().slice(0, 6)}@acme.test`}, ${`${MARKER} Lead`}, 'lead') returning id`;
    const thread = await seedThread(other, "contact");
    const otherAgent = await mcpCaller(sql, POST, other, ["mcp:read", "mcp:write"]);
    const drafted = await otherAgent.tool("write_reply_draft", { action: "create_manual", conversationId: thread.conversation, subject: "Re: Hello", bodyText: `${MARKER} draft.` });
    expect(drafted.isError, drafted.text).toBe(false);
    const [{ id: draft }] = await sql<{ id: string }[]>`select id from drafts where organization_id = ${o} and conversation_id = ${thread.conversation} order by created_at desc limit 1`;
    await sql`update drafts set revision = 1 where id = ${draft}`;
    const [{ id: pick }] = await sql<{ id: string }[]>`
      insert into reply_type_picks (organization_id, record_id, message_id, expected_context_version, status, error) values (${o}, ${thread.record}, ${thread.message}, 0, 'failed', 'The model did not answer.') returning id`;
    const taskDone = await otherAgent.tool("manage_task", { action: "create", recordId: thread.record, name: `${MARKER} task` });
    expect(taskDone.isError, taskDone.text).toBe(false);
    const deal = await seedDeal(other, thread.person);
    const [{ id: stage }] = await sql<{ id: string }[]>`select id from deal_stages where organization_id = ${o} and kind <> 'won' and kind <> 'lost' order by position desc limit 1`;
    const [{ id: workbook }] = await sql<{ id: string }[]>`insert into grid_workbooks (organization_id, name) values (${o}, ${`${MARKER} book`}) returning id`;
    const [{ id: table }] = await sql<{ id: string }[]>`insert into grid_tables (organization_id, workbook_id, name, position) values (${o}, ${workbook}, ${`${MARKER} table`}, 1) returning id`;
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${o}, ${table}, 'name', 'name', 'text', 1)`;
    const [{ id: batch }] = await sql<{ id: string }[]>`insert into linkedin_search_batches (organization_id, name) values (${o}, ${`${MARKER} batch`}) returning id`;
    const [{ id: search }] = await sql<{ id: string }[]>`insert into linkedin_search_queries (organization_id, batch_id, url) values (${o}, ${batch}, 'https://www.linkedin.com/search/results/people/?keywords=x') returning id`;
    const emailCampaign = await campaign(other, "email");
    const linkedinCampaign = await campaign(other, "linkedin");
    const [{ id: enrollment }] = await sql<{ id: string }[]>`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${o}, ${emailCampaign}, ${lead}, 'email', 'pending') returning id`;
    const [{ id: replyType }] = await sql<{ id: string }[]>`select id from reply_types where organization_id = ${o} limit 1`.then((rows) => (rows.length > 0 ? rows : [{ id: randomUUID() }]));
    const [{ id: linkedinAccount }] = await sql<{ id: string }[]>`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status) values (${o}, ${`acc-${randomUUID().slice(0, 6)}`}, ${`ACo-${randomUUID().slice(0, 6)}`}, 'other', ${`${MARKER} account`}, 'connected') returning id`;

    const ownThread = await seedThread(org, "own");
    const ownDeal = await seedDeal(org, ownThread.person);
    const [{ id: task }] = await sql<{ id: string }[]>`select id from tasks where organization_id = ${o} limit 1`;
    return {
      lead,
      contact: thread.person,
      conversation: thread.conversation,
      record: thread.record,
      draft,
      pick,
      task,
      deal: deal.dealId,
      dealVersion: deal.version,
      stage,
      table,
      search,
      emailCampaign,
      linkedinCampaign,
      enrollment,
      replyType,
      linkedinAccount,
      member: other.userId,
      own: { campaign: await campaign(org, "email"), conversation: ownThread.conversation, record: ownThread.record, deal: ownDeal.dealId, dealVersion: ownDeal.version },
    };
  }

  const setPolicies = (organizationId: string) =>
    sql`insert into channel_settings (organization_id, channel, values)
        values (${organizationId}, 'mcp', ${sql.json({ enabled: true, agentSendMode: "replies_and_campaigns", agentSendEpoch: 0, agentEnrollCap: 200, agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 100, agentIrreversiblePerDay: 50 })})
        on conflict (organization_id, channel) do update set values = channel_settings.values || excluded.values`;

  const listed = async (caller: McpCaller) =>
    ((await callMcp(POST, { era: "modern", token: caller.token, method: "tools/list", params: {} })).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name).sort();

  /** A call to a tool the token cannot see, or a refusal, ends as an error either way. */
  const callAs = (caller: McpCaller, tool: string, args: Record<string, unknown>): Promise<ToolCallResult> =>
    caller.tool(tool, args).catch((error: Error) => ({ isError: true, text: error.message, structured: {} }));
  /** A token of its own for each call: one token's write budget would run out long before the list does. */
  const call = async (tool: string, args: Record<string, unknown>) => callAs(await mcpCaller(sql, POST, org, ALL_SCOPES), tool, args);

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    TOOL_LIST = (await import("./registry")).TOOLS;
    org = await createTestOrg(sql, "Tenancy here");
    other = await createTestOrg(sql, "Tenancy there");
    orgs.push(org, other);
    await setPolicies(org.organizationId);
    await setPolicies(other.organizationId);
    agent = await mcpCaller(sql, POST, org, ALL_SCOPES);
    ids = await seed();
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("names every tool, and the token under test sees every one of them", async () => {
    const names = TOOL_LIST.map((t) => t.name).sort();
    expect(Object.keys(SPEC).sort()).toEqual(names);
    expect(await listed(agent)).toEqual(names);
  });

  it.each(allCases("refused"))("$label answers not found for another organization's id and writes nothing", async ({ tool, args }) => {
    const before = await rowsOf(other.organizationId);
    const result = await call(tool, args(ids));
    expect(result.isError, result.text).toBe(true);
    expect((result.structured.error as { code?: string } | undefined)?.code, result.text).toBe("not_found");
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(await rowsOf(other.organizationId)).toEqual(before);
  });

  it.each(allCases("filtered"))("$label shows nothing of another organization", async ({ tool, args }) => {
    const before = await rowsOf(other.organizationId);
    const result = await call(tool, args(ids));
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(await rowsOf(other.organizationId)).toEqual(before);
  });

  it.each(allCases("crossed"))("$label refuses to tie the caller's row to another organization's id", async ({ tool, args }) => {
    const before = await rowsOf(other.organizationId);
    const result = await call(tool, args(ids));
    expect(await rowsOf(other.organizationId)).toEqual(before);
    expect(result.isError || JSON.stringify(result.structured).includes('"added":0') || JSON.stringify(result.structured).includes('"removed":0'), result.text).toBe(true);
  });

  it("shows a token only the tools of its scopes, and refuses a call to any other", async () => {
    const before = await rowsOf(other.organizationId);
    for (const scopes of [["mcp:read"], ["mcp:read", "mcp:write"], ["mcp:read", "mcp:write", "mcp:send"], ["mcp:read", "mcp:write", "mcp:spend"], ["mcp:read", "mcp:write", "mcp:irreversible"]]) {
      const caller = await mcpCaller(sql, POST, org, scopes);
      const visible = TOOL_LIST.filter((t) => scopes.includes(t.scope)).map((t) => t.name).sort();
      expect(await listed(caller)).toEqual(visible);
      for (const hidden of TOOL_LIST.filter((t) => !scopes.includes(t.scope))) {
        const result = await callAs(caller, hidden.name, {});
        expect(result.isError, `${hidden.name} with ${scopes.join(" ")}`).toBe(true);
        expect(result.text, `${hidden.name} with ${scopes.join(" ")}`).toMatch(/not found|unknown|disabled/i);
      }
    }
    expect(await rowsOf(other.organizationId)).toEqual(before);
  });
});
