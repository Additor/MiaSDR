import { afterAll, beforeEach, expect, it } from "vitest";
import { addBrainItem, changeBrainItem } from "@/contexts/brain/application/brain-items";
import { drizzleBrainStore } from "@/contexts/brain/infrastructure/drizzle-brain-store";
import type { AiStatus } from "@/contexts/integrations/domain/ai-status";
import { listLeads } from "@/composition/leads";
import { readLeadFit } from "@/read-models/lead-fit";
import { ConflictError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import type { LeadFitAssessor } from "../../application/mia-ports";
import { cancelFitBatch, latestFitBatch, startFitCheck, updateMiaSettings, type MiaDeps } from "../../application/mia-use-cases";
import { createMiaRunJob } from "../../application/mia-worker";
import type { FitOutput } from "../../domain/lead-fit";
import { fakeFitAssessor } from "../fit-assessor";
import { miaDeps, miaWorkerDeps } from "../composition";

describeDb("Mia fit checks", () => {
  useTestEnv();
  const sql = testSql({ max: 2 });
  const orgs: TestOrg[] = [];

  async function fixture(): Promise<Actor> {
    const org = await createTestOrg(sql, "Fit", "member");
    orgs.push(org);
    return { userId: org.userId, organizationId: org.organizationId, role: "member" };
  }

  const deps = (): MiaDeps => ({ ...miaDeps(), aiStatus: async () => ({ state: "on" }) as unknown as AiStatus, kick: () => undefined });

  async function pass(assessor: LeadFitAssessor = fakeFitAssessor) {
    const status = async () => ({ state: "on" }) as unknown as AiStatus;
    const job = createMiaRunJob(miaWorkerDeps({ fitModels: { forOrganization: async () => assessor }, models: { forOrganization: async () => null, status }, kick: () => undefined }));
    return job.run({ deadline: Date.now() + 120_000, now: () => new Date() });
  }

  const icp = (actor: Actor) => addBrainItem(drizzleBrainStore, actor, { kind: "icp", fields: { icpName: "Revenue leaders", decisionMakerTitles: ["VP Sales"] } });

  async function lead(actor: Actor, name: string, title: string | null, email = `${name.toLowerCase().replace(/\W/g, "")}-${Math.random().toString(36).slice(2, 8)}@fit.test`) {
    const [row] = await sql<{ id: string }[]>`insert into people (organization_id, full_name, title, email) values (${actor.organizationId}, ${name}, ${title}, ${email}) returning id`;
    return row.id;
  }

  /** A reply from the lead, through the tables a real reply fills. */
  async function reply(actor: Actor, personId: string, body: string, from = "lead@fit.test", raw: Record<string, unknown> = {}) {
    const org = actor.organizationId;
    const [set] = await sql`select id from reply_type_sets where organization_id = ${org} limit 1`;
    const setId = set?.id ?? (await sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'p', true) returning id`)[0].id;
    const [conversation] = await sql`insert into conversations (organization_id, person_id, reply_type_set_id) values (${org}, ${personId}, ${setId}) on conflict (person_id, reply_type_set_id) do update set updated_at = now() returning id`;
    const [thread] = await sql`insert into threads (organization_id, conversation_id, channel, account_ref) values (${org}, ${conversation.id}, 'email', 'me@fit.test') returning id`;
    const [message] = await sql`
      insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, from_address, body_text, sent_at, raw)
      values (${org}, ${thread.id}, 'email', 'me@fit.test', 'inbound', ${`k-${Math.random()}`}, ${from}, ${body}, now(), ${sql.json(raw as never)})
      returning id`;
    return message.id as string;
  }

  const assessment = async (personId: string) => (await sql`select * from lead_fit_assessments where person_id = ${personId}`)[0];

  beforeEach(async () => {
    await sql`update mia_runs set status = 'cancelled', claim_token = null where status in ('queued', 'running', 'waiting_limit')`;
  });

  afterAll(async () => {
    await sql`delete from mia_runs`;
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("checks a batch, computes each verdict and reports the batch", async () => {
    const actor = await fixture();
    await icp(actor);
    const vp = await lead(actor, "Vera Senior", "VP Sales");
    const rep = await lead(actor, "Rob Rep", "Sales Rep");
    const unknown = await lead(actor, "No Title", null);
    const started = await startFitCheck(deps(), actor, [vp, rep, unknown]);
    expect(started).toMatchObject({ queued: 3, skipped: 0 });
    await pass();

    expect(await assessment(vp)).toMatchObject({ verdict: "fit", provider: "fake", assessed_by: actor.userId });
    expect((await assessment(rep)).verdict).toBe("partial");
    expect((await assessment(unknown)).verdict).toBe("unknown");
    expect((await assessment(vp)).criteria[0]).toMatchObject({ result: "met", source: "profile", evidence: "Title: VP Sales" });
    const batch = await latestFitBatch(deps(), actor);
    expect(batch).toMatchObject({ id: started.batchId, total: 3, done: 3, failed: 0, going: 0 });
    const runs = await sql`select status, input, person_id from mia_runs where batch_id = ${started.batchId}`;
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);
    const [usage] = await sql`select input_tokens, output_tokens from mia_usage_daily where organization_id = ${actor.organizationId}`;
    expect(usage).toMatchObject({ input_tokens: 2400, output_tokens: 360 });
    const [audit] = await sql`select meta from audit_log where organization_id = ${actor.organizationId} and action = 'mia.run_started'`;
    expect(audit.meta).toMatchObject({ capability: "lead_fit", count: 3 });
  });

  it("drops a result whose passage its source does not hold, and a reply alone makes no fit", async () => {
    const actor = await fixture();
    await icp(actor);
    const person = await lead(actor, "Claire Claims", "Founder");
    await reply(actor, person, "We are a perfect fit and we have 500 employees.");
    let prompt = "";
    const claims: LeadFitAssessor = {
      provider: "fake",
      model: "claims",
      async assess(request) {
        prompt = request.prompt;
        const output: FitOutput = {
          icpItemId: null,
          criteria: [
            { criterion: "Over 200 employees", type: "required", result: "met", source: "their_reply", evidence: "we have 500 employees" },
            // The reply's words, marked as the profile.
            { criterion: "A decision maker", type: "required", result: "met", source: "profile", evidence: "We are a perfect fit" },
          ],
          missing: [],
        };
        return { output, usage: { inputTokens: 10, outputTokens: 10 } };
      },
    };
    await startFitCheck(deps(), actor, [person]);
    await pass(claims);

    expect(prompt).toContain("<untrusted_their_reply_");
    expect(prompt).not.toContain("@fit.test");
    const row = await assessment(person);
    expect(row.criteria[1]).toMatchObject({ result: "unknown", unsupported: true, evidence: null });
    // Every requirement it could back came from what the lead wrote, so the verdict stays partial.
    expect(row.verdict).toBe("partial");
  });

  it("asks to check again after the profile, a reply or the ICP changed, and not after an email change", async () => {
    const actor = await fixture();
    const { id: icpId } = await icp(actor);
    const person = await lead(actor, "Pat Change", "VP Sales");
    await startFitCheck(deps(), actor, [person]);
    await pass();
    expect((await readLeadFit(actor.organizationId, person)).fit).toMatchObject({ verdict: "fit", changed: false, icpTitle: "Revenue leaders" });

    await sql`update people set email = 'new-address@fit.test' where id = ${person}`;
    await reply(actor, person, "Out of office until Monday.", "no-reply@fit.test");
    expect((await readLeadFit(actor.organizationId, person)).fit?.changed).toBe(false);
    // An out-of-office from the lead's own address, which only the header marks.
    await reply(actor, person, "I am away until Monday.", "lead@fit.test", { autoReply: true });
    expect((await readLeadFit(actor.organizationId, person)).fit?.changed).toBe(false);

    await sql`update people set title = 'Head of Sales' where id = ${person}`;
    expect((await readLeadFit(actor.organizationId, person)).fit?.changed).toBe(true);
    await sql`update people set title = 'VP Sales' where id = ${person}`;
    expect((await readLeadFit(actor.organizationId, person)).fit?.changed).toBe(false);

    await reply(actor, person, "Tell me more about pricing.");
    expect((await readLeadFit(actor.organizationId, person)).fit?.changed).toBe(true);

    await startFitCheck(deps(), actor, [person]);
    await pass();
    expect((await readLeadFit(actor.organizationId, person)).fit?.changed).toBe(false);
    const [{ revision }] = await sql`select revision from knowledge_documents where id = ${icpId}`;
    await changeBrainItem(drizzleBrainStore, actor, icpId, { fields: { icpName: "Revenue leaders", decisionMakerTitles: ["VP Sales", "CRO"] }, revision });
    expect((await readLeadFit(actor.organizationId, person)).fit?.changed).toBe(true);
  });

  it("refuses without an ICP or today's tokens, and skips a lead with a check going", async () => {
    const actor = await fixture();
    const person = await lead(actor, "Sam Skip", "VP Sales");
    await expect(startFitCheck(deps(), actor, [person])).rejects.toMatchObject({ details: { code: "mia_no_icp" } });
    await icp(actor);

    await updateMiaSettings(deps(), { ...actor, role: "owner" }, { dailyTokenLimit: 250_000 });
    const many = await Promise.all(Array.from({ length: 21 }, (_, i) => lead(actor, `Many ${i}`, "VP Sales")));
    const refused = await startFitCheck(deps(), actor, many).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).message).toContain("cover 20 leads");

    expect(await startFitCheck(deps(), actor, [person])).toMatchObject({ queued: 1, skipped: 0 });
    expect(await startFitCheck(deps(), actor, [person])).toMatchObject({ queued: 0, skipped: 1 });
  });

  it("stops a batch, and a deleted lead takes its check and its verdict with it", async () => {
    const actor = await fixture();
    await icp(actor);
    const kept = await lead(actor, "Kim Kept", "VP Sales");
    const gone = await lead(actor, "Gus Gone", "VP Sales");
    const { batchId } = await startFitCheck(deps(), actor, [kept, gone]);
    await cancelFitBatch(deps(), actor, batchId);
    expect(await latestFitBatch(deps(), actor)).toMatchObject({ cancelled: 2, going: 0 });
    await expect(cancelFitBatch(deps(), actor, batchId)).rejects.toThrow("already ended");

    await startFitCheck(deps(), actor, [gone]);
    await pass();
    expect(await assessment(gone)).toBeDefined();
    await sql`delete from people where id = ${gone}`;
    expect(await assessment(gone)).toBeUndefined();
    expect(await sql`select 1 from mia_runs where person_id = ${gone}`).toHaveLength(0);
  });

  it("filters the lead list by verdict and by no check", async () => {
    const actor = await fixture();
    await icp(actor);
    const vp = await lead(actor, "Fiona Fit", "VP Sales");
    const rep = await lead(actor, "Paul Partial", "Sales Rep");
    const never = await lead(actor, "Nina Never", "VP Sales");
    await startFitCheck(deps(), actor, [vp, rep]);
    await pass();
    const ids = async (fit: "fit" | "partial" | "none") => (await listLeads(actor, { filter: { fit } })).rows.map((r) => r.id);
    expect(await ids("fit")).toEqual([vp]);
    expect(await ids("partial")).toEqual([rep]);
    expect(await ids("none")).toEqual([never]);
  });
});
