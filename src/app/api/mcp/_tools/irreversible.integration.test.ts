import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { issuedCaller, type McpCaller } from "@/test-support/mcp-fixture";
import type { Actor } from "@/shared/errors";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * The actions no one can undo, through the route with tokens the token API issued. Each refusal is asserted by its code
 * and by the row it leaves behind. An import is the realistic way back in: after a delete the person would look new.
 */
describeDb("MCP actions that cannot be undone", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  const orgs: TestOrg[] = [];
  let POST: (request: Request) => Promise<Response>;
  let org: TestOrg;
  let owner: Actor;
  let agent: McpCaller;
  let tokens: typeof import("@/contexts/tenancy/application/mcp-tokens");
  let deps: import("@/contexts/tenancy/application/mcp-tokens").McpTokenDeps;
  let n = 0;

  const codeOf = (result: { structured: Record<string, unknown> }) => (result.structured.error as { code?: string } | undefined)?.code;
  const tag = () => `${(n += 1)}-${randomBytes(3).toString("hex")}`;
  const used = async () => (await sql<{ amount: number }[]>`select amount from mcp_agent_usage where organization_id = ${org.organizationId} and kind = 'irreversible'`)[0]?.amount ?? 0;
  const exists = async (table: string, id: string) => (await sql.unsafe(`select 1 from ${table} where id = $1`, [id])).length > 0;

  const person = async (values: { email?: string | null; lifecycle?: "lead" | "contact" } = {}) => {
    const email = values.email === undefined ? `p${tag()}@acme.test` : values.email;
    const lifecycle = values.lifecycle ?? "lead";
    const [{ id }] = await sql<{ id: string }[]>`
      insert into people (organization_id, email, full_name, lifecycle, converted_at, linkedin_url)
      values (${org.organizationId}, ${email}, 'Lena Lead', ${lifecycle}, ${lifecycle === "contact" ? new Date() : null}, ${email === null ? `https://www.linkedin.com/in/l${tag()}` : null}) returning id`;
    return id;
  };
  const markDoNotContact = (personId: string) =>
    sql`insert into contact_policies (person_id, organization_id, do_not_contact, reason, source, set_at) values (${personId}, ${org.organizationId}, true, 'asked', 'human', now())
        on conflict (person_id) do update set do_not_contact = true`;
  const suppress = (email: string) => sql`insert into suppression_list (organization_id, email, reason) values (${org.organizationId}, ${email.toLowerCase()}, 'manual')`;
  const campaign = async (status = "draft", extra: { personPaused?: boolean } = {}) => {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into campaigns (organization_id, channel, name, status, steps, person_paused)
      values (${org.organizationId}, 'email', ${`C ${tag()}`}, ${status}, ${sql.json([])}, ${extra.personPaused ?? false}) returning id`;
    return id;
  };
  const removedEnrollment = async (personId: string) => {
    const campaignId = await campaign("active");
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${org.organizationId}, ${campaignId}, ${personId}, 'email', 'removed')`;
  };
  const inbound = async (body: string, email = `r${tag()}@acme.test`) => {
    const { ingestInbound } = await import("@/contexts/conversations/infrastructure/composition");
    const key = tag();
    await ingestInbound({
      organizationId: org.organizationId,
      accountRef: "sdr@corp.test",
      providerThreadId: `t-${key}`,
      providerMessageId: `m-${key}`,
      rfcMessageId: `<${key}@x.test>`,
      inReplyTo: null,
      from: { email, name: "Lena Lead" },
      to: ["sdr@corp.test"],
      subject: "Re: Hello",
      bodyText: body,
      receivedAt: new Date(Date.now() - 3_600_000),
      attachments: [],
    } as never);
    const [{ id }] = await sql<{ id: string }[]>`select id from people where organization_id = ${org.organizationId} and email = ${email}`;
    await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${id}`;
    return id;
  };
  const deal = async (kind: "open" | "won" = "open") => {
    const contact = await person({ lifecycle: "contact" });
    const { createDealForContact } = await import("@/contexts/deals/application/deal-create");
    const { moveDealStage } = await import("@/contexts/deals/application/deal-edit");
    const { dealsDeps } = await import("@/composition/deals");
    const { dealId: id } = await createDealForContact(dealsDeps(), owner, contact, { title: "Big one", idempotencyKey: `deal-${tag()}` });
    if (kind === "won") {
      const [{ id: stageId }] = await sql<{ id: string }[]>`select id from deal_stages where organization_id = ${org.organizationId} and kind = 'won' limit 1`;
      const [{ version }] = await sql<{ version: number }[]>`select version from deals where id = ${id}`;
      await moveDealStage(dealsDeps(), owner, id, { stageId, expectedVersion: version });
    }
    return { id, contact };
  };

  const preview = (args: Record<string, unknown>) => agent.tool("preview_irreversible", args);
  const apply = (args: Record<string, unknown>, actionToken: string) => agent.tool("apply_irreversible", { ...args, actionToken });
  const tokenOf = async (args: Record<string, unknown>) => {
    const seen = await preview(args);
    expect(seen.isError, seen.text).toBe(false);
    expect(seen.structured.refusals, seen.text).toEqual([]);
    return seen.structured.actionToken as string;
  };
  const done = (result: { isError: boolean; text: string }) => expect(result.isError, result.text).toBe(false);

  const issue = async (extras: Array<"spend" | "irreversible">, access: "read" | "write" = "write") => {
    const created = await tokens.createMcpToken(deps, owner, { name: `Agent ${tag()}`, access, extras });
    return issuedCaller(POST, created);
  };
  const toolNames = async (caller: McpCaller) => {
    const listed = await callMcp(POST, { era: "modern", token: caller.token, method: "tools/list", params: {} });
    return (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
  };

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    tokens = await import("@/contexts/tenancy/application/mcp-tokens");
    deps = (await import("@/contexts/tenancy/infrastructure/mcp-composition")).mcpTokenDeps();
    org = await createTestOrg(sql, "Irreversible");
    orgs.push(org);
    owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    await tokens.updateMcpSettings(deps, owner, { enabled: true });
  });

  beforeEach(async () => {
    await sql`delete from mcp_agent_usage where organization_id = ${org.organizationId}`;
    await sql`update mcp_tokens set revoked_at = now() where organization_id = ${org.organizationId} and revoked_at is null`;
    await tokens.updateMcpSettings(deps, owner, { agentIrreversiblePerDay: 50 });
    agent = await issue(["irreversible"]);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("offers the tools only to a token with the scope, while the limit is above 0", async () => {
    expect(await toolNames(agent)).toEqual(expect.arrayContaining(["apply_irreversible", "preview_irreversible"]));
    const plain = await issue([]);
    expect(await toolNames(plain)).not.toContain("apply_irreversible");
    const called = await plain.tool("apply_irreversible", { kind: "delete_lead", personId: await person(), actionToken: "x" }).catch((error: Error) => error);
    expect(called instanceof Error ? called.message : called.isError).toBeTruthy();

    await tokens.updateMcpSettings(deps, owner, { agentIrreversiblePerDay: 0 });
    expect(await toolNames(agent)).not.toContain("apply_irreversible");
  });

  it("deletes a lead with the preview's token, and records who asked", async () => {
    const id = await person();
    const args = { kind: "delete_lead", personId: id };
    const seen = await preview(args);
    expect(seen.structured).toMatchObject({ kind: "delete_lead", targetId: id, refusals: [] });
    expect(seen.structured.name).toContain("<untrusted_");
    expect(await exists("people", id)).toBe(true);
    expect(await used()).toBe(0);
    done(await apply(args, seen.structured.actionToken as string));
    expect(await exists("people", id)).toBe(false);
    expect(await used()).toBe(1);
    const [audit] = await sql<{ meta: { via?: { tokenId: string } } }[]>`select meta from audit_log where organization_id = ${org.organizationId} and action = 'person.deleted' and entity_id = ${id}`;
    expect(audit.meta.via?.tokenId).toBe(agent.tokenId);
    const [call] = await sql<{ target: Record<string, string>; error_code: string | null; kind: string }[]>`select target, error_code, kind from mcp_tool_calls where token_id = ${agent.tokenId} and tool = 'apply_irreversible'`;
    expect(call).toEqual({ target: { personId: id }, error_code: null, kind: "write" });
  });

  it("refuses a broken token and gives the reservation back", async () => {
    const id = await person();
    expect(codeOf(await apply({ kind: "delete_lead", personId: id }, "at1.nonsense"))).toBe("action_token_stale");
    expect(codeOf(await apply({ kind: "delete_lead", personId: id }, await tokenOf({ kind: "delete_lead", personId: await person() })))).toBe("action_token_stale");
    expect(await exists("people", id)).toBe(true);
    expect(await used()).toBe(0);
  });

  it("stops at the daily limit, one of two at the boundary, and gives back what a refusal took", async () => {
    await tokens.updateMcpSettings(deps, owner, { agentIrreversiblePerDay: 1 });
    const [a, b] = [await person(), await person()];
    const [tokenA, tokenB] = [await tokenOf({ kind: "delete_lead", personId: a }), await tokenOf({ kind: "delete_lead", personId: b })];
    const results = await Promise.all([apply({ kind: "delete_lead", personId: a }, tokenA), apply({ kind: "delete_lead", personId: b }, tokenB)]);
    expect(results.map((result) => codeOf(result)).filter((code) => code === "agent_irreversible_cap")).toHaveLength(1);
    expect((await exists("people", a)) !== (await exists("people", b))).toBe(true);
    expect(await used()).toBe(1);
    const over = results.find((result) => codeOf(result) === "agent_irreversible_cap");
    expect((over?.structured.error as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("stops an old token once the limit went to 0 and back, and a new token works", async () => {
    const id = await person();
    const token = await tokenOf({ kind: "delete_lead", personId: id });
    const old = agent;
    await tokens.updateMcpSettings(deps, owner, { agentIrreversiblePerDay: 0 });
    await tokens.updateMcpSettings(deps, owner, { agentIrreversiblePerDay: 5 });
    expect(await toolNames(old)).not.toContain("apply_irreversible");
    const fresh = await issue(["irreversible"]);
    done(await fresh.tool("apply_irreversible", { kind: "delete_lead", personId: id, actionToken: token }));
  });

  for (const kind of ["delete_lead", "delete_contact"] as const) {
    const lifecycle = kind === "delete_lead" ? "lead" : "contact";

    it(`${kind}: keeps a person marked do not contact, with no address to fall back on`, async () => {
      const id = await person({ email: null, lifecycle });
      await markDoNotContact(id);
      const seen = await preview({ kind, personId: id });
      expect((seen.structured.refusals as Array<{ code: string }>).map((r) => r.code)).toContain("agent_delete_protected");
      expect(seen.structured.actionToken).toBeNull();
      expect(codeOf(await apply({ kind, personId: id }, "at1.x"))).toBe("action_token_stale");
      expect(await exists("people", id)).toBe(true);
      expect(await sql`select 1 from contact_policies where person_id = ${id} and do_not_contact`).toHaveLength(1);
    });

    it(`${kind}: keeps a person whose address is suppressed, whatever its case`, async () => {
      const email = `Mixed${tag()}@Acme.test`;
      const id = await person({ email, lifecycle });
      await suppress(email);
      const seen = await preview({ kind, personId: id });
      expect((seen.structured.refusals as Array<{ code: string }>).map((r) => r.code)).toContain("agent_delete_protected");
      expect(await exists("people", id)).toBe(true);
    });

    it(`${kind}: keeps a person a person removed from a campaign`, async () => {
      const id = await person({ lifecycle });
      await removedEnrollment(id);
      const seen = await preview({ kind, personId: id });
      expect((seen.structured.refusals as Array<{ code: string }>).map((r) => r.code)).toContain("agent_delete_protected");
      expect(await sql`select 1 from campaign_enrollments where person_id = ${id} and status = 'removed'`).toHaveLength(1);
    });

    it(`${kind}: refuses under the lock when the mark came after the preview, and gives the reservation back`, async () => {
      const id = await person({ lifecycle });
      const token = await tokenOf({ kind, personId: id });
      await markDoNotContact(id);
      expect(codeOf(await apply({ kind, personId: id }, token))).toBe("agent_delete_protected");
      expect(await exists("people", id)).toBe(true);
      expect(await used()).toBe(0);
    });

    it(`${kind}: waits for a mark in progress, then refuses and keeps the mark`, async () => {
      const id = await person({ lifecycle });
      await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at, cleared_at) values (${id}, ${org.organizationId}, false, 'human', now(), now())`;
      const token = await tokenOf({ kind, personId: id });
      const marking = await sql.reserve();
      try {
        await marking`begin`;
        await marking`update contact_policies set do_not_contact = true, cleared_at = null where person_id = ${id}`;
        const applying = apply({ kind, personId: id }, token);
        await waitForLockWaiters(sql, 1, 10_000);
        await marking`commit`;
        expect(codeOf(await applying)).toBe("agent_delete_protected");
      } finally {
        marking.release();
      }
      expect(await sql`select 1 from contact_policies where person_id = ${id} and do_not_contact`).toHaveLength(1);
      expect(await used()).toBe(0);
    });
  }

  it("keeps a contact who asked to stop, and one whose words did before any AI pick", async () => {
    const id = await inbound("Please stop emailing me.");
    const seen = await preview({ kind: "delete_contact", personId: id });
    expect((seen.structured.refusals as Array<{ code: string }>).map((r) => r.code)).toContain("agent_delete_protected");
    expect(await exists("people", id)).toBe(true);
  });

  it("deletes a contact, conversations included, after stating what goes, and goes stale when they change", async () => {
    const id = await inbound("Can you send pricing?");
    const args = { kind: "delete_contact", personId: id };
    const seen = await preview(args);
    expect(seen.structured.refusals).toEqual([]);
    expect(seen.structured.erases).toMatchObject({ threads: 1, messages: 1 });
    expect(seen.structured.effect).toContain("1 conversations with 1 messages");
    await sql`insert into notes (organization_id, person_id, body) values (${org.organizationId}, ${id}, 'New note')`;
    expect(codeOf(await apply(args, seen.structured.actionToken as string))).toBe("action_token_stale");
    expect(await used()).toBe(0);
    expect(await exists("people", id)).toBe(true);

    done(await apply(args, await tokenOf(args)));
    expect(await exists("people", id)).toBe(false);
    expect(await sql`select 1 from conversations where person_id = ${id}`).toHaveLength(0);
    const [audit] = await sql<{ meta: { lifecycle: string; via?: { tokenId: string } } }[]>`select meta from audit_log where organization_id = ${org.organizationId} and action = 'person.deleted' and entity_id = ${id}`;
    expect(audit.meta).toMatchObject({ lifecycle: "contact", via: { tokenId: agent.tokenId } });
  });

  it("leaves a person's own delete of a marked contact alone, and asks no reservation", async () => {
    const { deleteContact, previewContactDelete, flatten } = await import("@/contexts/people/application/contact-delete");
    const { contactDeleteDeps } = await import("@/composition/person-lifecycle");
    const id = await person({ email: `human${tag()}@acme.test`, lifecycle: "contact" });
    await markDoNotContact(id);
    const seen = await previewContactDelete(contactDeleteDeps, owner, id);
    expect(seen.agentProtected).toBe(false);
    await deleteContact(contactDeleteDeps, owner, id, { expected: flatten(seen.counts) });
    expect(await exists("people", id)).toBe(false);
    expect(await used()).toBe(0);
  });

  it("deletes an open deal, records who asked, refuses a closed one, and goes stale on an edit", async () => {
    const open = await deal();
    const args = { kind: "delete_deal", dealId: open.id };
    const token = await tokenOf(args);
    await sql`update deals set version = version + 1 where id = ${open.id}`;
    expect(codeOf(await apply(args, token))).toBe("action_token_stale");
    expect(await used()).toBe(0);
    done(await apply(args, await tokenOf(args)));
    expect(await exists("deals", open.id)).toBe(false);
    expect(await exists("people", open.contact)).toBe(true);
    const [event] = await sql<{ meta: { via?: { tokenId: string } } }[]>`select meta from events where organization_id = ${org.organizationId} and event_type = 'deal.deleted' and person_id = ${open.contact}`;
    expect(event.meta.via?.tokenId).toBe(agent.tokenId);

    const won = await deal("won");
    const seen = await preview({ kind: "delete_deal", dealId: won.id });
    expect(seen.structured.refusals).toEqual([expect.objectContaining({ code: "deal_closed" })]);
    expect(seen.structured.actionToken).toBeNull();
  });

  it("completes a campaign with a token, once, and repeats without counting", async () => {
    const id = await campaign("active");
    const args = { kind: "complete_campaign", channel: "email", campaignId: id };
    done(await apply(args, await tokenOf(args)));
    expect((await sql`select status from campaigns where id = ${id}`)[0].status).toBe("completed");
    expect(await used()).toBe(1);
    const again = await apply(args, "at1.lost");
    expect(again.structured).toMatchObject({ alreadyDone: true });
    expect(await used()).toBe(1);
    expect((await preview(args)).structured).toMatchObject({ alreadyDone: true, actionToken: null });
  });

  it("refuses to complete a campaign a person paused, a draft, or one that changed since the preview", async () => {
    const paused = await campaign("paused", { personPaused: true });
    const seen = await preview({ kind: "complete_campaign", channel: "email", campaignId: paused });
    expect(seen.structured.refusals).toEqual([expect.objectContaining({ code: "agent_complete_person_paused" })]);
    expect((await sql`select status from campaigns where id = ${paused}`)[0].status).toBe("paused");

    const draft = await campaign("draft");
    expect((await preview({ kind: "complete_campaign", channel: "email", campaignId: draft })).structured.refusals).toEqual([expect.objectContaining({ code: "campaign_not_started" })]);

    const moved = await campaign("active");
    const args = { kind: "complete_campaign", channel: "email", campaignId: moved };
    const token = await tokenOf(args);
    await sql`update campaigns set status = 'paused' where id = ${moved}`;
    expect(codeOf(await apply(args, token))).toBe("action_token_stale");
    expect(await used()).toBe(0);
  });

  it("deletes a draft campaign, records who asked, and refuses one that started", async () => {
    const id = await campaign("draft");
    const args = { kind: "delete_draft_campaign", channel: "email", campaignId: id };
    done(await apply(args, await tokenOf(args)));
    expect(await exists("campaigns", id)).toBe(false);
    const [audit] = await sql<{ meta: { via?: { tokenId: string } } }[]>`select meta from audit_log where organization_id = ${org.organizationId} and action = 'campaign.deleted' and entity_id = ${id}`;
    expect(audit.meta.via?.tokenId).toBe(agent.tokenId);

    const running = await campaign("active");
    const seen = await preview({ kind: "delete_draft_campaign", channel: "email", campaignId: running });
    expect(seen.structured.refusals).toEqual([expect.objectContaining({ code: "campaign_not_draft" })]);
    expect(await exists("campaigns", running)).toBe(true);
  });

  it("names what a kind needs, and answers another channel's id as unknown", async () => {
    expect(codeOf(await preview({ kind: "delete_deal" }))).toBe("validation");
    expect(codeOf(await preview({ kind: "complete_campaign", channel: "linkedin", campaignId: await campaign("active") }))).toBe("not_found");
  });
});
