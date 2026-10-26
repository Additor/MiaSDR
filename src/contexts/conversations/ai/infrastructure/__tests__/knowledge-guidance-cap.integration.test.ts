import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailInput } from "../../../application/ports";
import { DEFAULT_REPLY_TYPES } from "../../../domain/default-reply-types";
import { ValidationError } from "@/shared/errors";
import type { Job } from "@/platform/jobs/types";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import { replyAiResolverOf } from "@/contexts/conversations/ai/application/ai-ports";

describeDb("knowledge tags, default subcategory guidance and the unknown-sender AI cap", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let composition: typeof import("../../../infrastructure/composition");
  let knowledgeApp: typeof import("../../application/knowledge");
  let knowledgeStore: typeof import("../drizzle-knowledge-store").drizzleKnowledgeStore;
  let engine: typeof import("../../../after-reply/infrastructure/drizzle-sequence-engine").drizzleSequenceEngine;
  let aiJobsApp: typeof import("../../application/ai-jobs");
  let jobStore: typeof import("../drizzle-ai-job-store").drizzleAiJobStore;
  let FakeAi: typeof import("../fake-reply-ai").FakeReplyAi;
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let counter = 0;

  async function fixture() {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "Knowledge");
    orgs.push(created);
    const org = created.organizationId;
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const actor = { userId: "00000000-0000-0000-0000-000000000001", organizationId: org, role: "admin" };
    return { org, address, tag, actor };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  async function receive(f: Fx, from?: string) {
    const n = ++counter;
    const input: InboundEmailInput = {
      organizationId: f.org,
      accountRef: f.address,
      providerThreadId: `kg-thread-${n}`,
      providerMessageId: `kg-msg-${n}`,
      rfcMessageId: `<kg${n}@lead.test>`,
      inReplyTo: null,
      from: { email: from ?? `lead${n}-${f.tag}@acme.test`, name: "Lena Lead" },
      to: [f.address],
      subject: "Re: hello",
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date(),
      autoReply: false,
    };
    return composition.ingestInbound(input);
  }

  function ticker(f: Fx, ai: InstanceType<typeof FakeAi>) {
    const deps = {
      jobs: jobStore,
      replies: undefined as never,
      ai: replyAiResolverOf(async (o: string) => (o === f.org ? ai : null)),
      now: () => new Date(),
      workerId: "kg-test",
      leaseMs: aiJobsApp.AI_JOB_LEASE_MS,
      notConfiguredDelayMs: 60_000,
    };
    return async () => {
      deps.replies = (await import("../../../infrastructure/drizzle-reply-store")).drizzleReplyStore as never;
      const [tick] = aiJobsApp.createAiJobs(deps) as [Job];
      return tick.run({ deadline: Date.now() + 120_000, now: () => new Date() });
    };
  }

  const jobsOf = (org: string) => sql`select kind, status, attempts, payload, last_error from ai_jobs where organization_id = ${org}`;

  beforeAll(async () => {
    composition = await import("../../../infrastructure/composition");
    knowledgeApp = await import("../../application/knowledge");
    knowledgeStore = (await import("../drizzle-knowledge-store")).drizzleKnowledgeStore;
    engine = (await import("../../../after-reply/infrastructure/drizzle-sequence-engine")).drizzleSequenceEngine;
    aiJobsApp = await import("../../application/ai-jobs");
    jobStore = (await import("../drizzle-ai-job-store")).drizzleAiJobStore;
    FakeAi = (await import("../fake-reply-ai")).FakeReplyAi;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs, users);
    await sql.end();
  });

  describe("knowledge tags", () => {
    it("stores normalized tags on create and update, and lists them", async () => {
      const f = await fixture();
      const { id } = await knowledgeApp.createKnowledge(knowledgeStore, f.actor, { title: "Price list", kind: "pricing", content: "Plans start at 10.", alwaysInclude: false, tags: [" Pricing ", "PRICING", "Plans"] });
      let [doc] = await knowledgeApp.listKnowledge(knowledgeStore, f.actor);
      expect(doc.tags).toEqual(["pricing", "plans"]);
      await knowledgeApp.updateKnowledge(knowledgeStore, f.actor, id, { tags: ["Security"] });
      [doc] = await knowledgeApp.listKnowledge(knowledgeStore, f.actor);
      expect(doc.tags).toEqual(["security"]);
      expect(doc.version).toBe(1);
      // A PATCH without tags leaves them alone.
      await knowledgeApp.updateKnowledge(knowledgeStore, f.actor, id, { title: "Price list 2" });
      expect((await knowledgeApp.listKnowledge(knowledgeStore, f.actor))[0].tags).toEqual(["security"]);
    });

    it("keeps the tags when a PATCH sends only alwaysInclude", async () => {
      const f = await fixture();
      const { id } = await knowledgeApp.createKnowledge(knowledgeStore, f.actor, { title: "Price list", kind: "pricing", content: "Plans start at 10.", alwaysInclude: false, tags: ["pricing"] });
      await knowledgeApp.updateKnowledge(knowledgeStore, f.actor, id, { alwaysInclude: true });
      const [doc] = await knowledgeApp.listKnowledge(knowledgeStore, f.actor);
      expect(doc).toMatchObject({ alwaysInclude: true, tags: ["pricing"] });
      // Tags sent together with the flag still replace the old ones.
      await knowledgeApp.updateKnowledge(knowledgeStore, f.actor, id, { alwaysInclude: false, tags: ["security"] });
      expect((await knowledgeApp.listKnowledge(knowledgeStore, f.actor))[0]).toMatchObject({ alwaysInclude: false, tags: ["security"] });
    });

    it("refuses 51 tags and an 81-character tag", async () => {
      const f = await fixture();
      const base = { title: "T", kind: "faq", content: "c", alwaysInclude: false };
      await expect(knowledgeApp.createKnowledge(knowledgeStore, f.actor, { ...base, tags: Array.from({ length: 51 }, (_, i) => `t${i}`) })).rejects.toBeInstanceOf(ValidationError);
      await expect(knowledgeApp.createKnowledge(knowledgeStore, f.actor, { ...base, tags: ["x".repeat(81)] })).rejects.toBeInstanceOf(ValidationError);
    });

    it("gives a step with knowledgeTags the matching and always-included documents, best overlap first", async () => {
      const f = await fixture();
      const mk = (title: string, tags: string[], content = `${title} body`, alwaysInclude = false) => knowledgeApp.createKnowledge(knowledgeStore, f.actor, { title, kind: "custom", content, alwaysInclude, tags });
      await mk("Always", [], "x".repeat(40_000), true);
      await mk("Pricing only", ["pricing"]);
      await mk("Pricing and security", ["pricing", "security"]);
      await mk("Unrelated", ["billing"]);
      await mk("Untagged", []);
      const picked = await engine.knowledgeForTags(f.org, ["Pricing", "security"]);
      expect(picked.map((p) => p.title)).toEqual(["Always", "Pricing and security", "Pricing only"]);
      // The 40,000-character always-included document is cut, so the tagged ones still arrive.
      expect(picked[0].content.length).toBeLessThan(3100);
      expect(picked[1].content).toBe("Pricing and security body");
    });

    it("finds the only matching document of 250 even when its title sorts last", async () => {
      const f = await fixture();
      const rows = Array.from({ length: 249 }, (_, i) => ({ title: `Doc ${String(i).padStart(3, "0")}`, tags: ["billing"] }));
      for (let i = 0; i < rows.length; i += 25) {
        await Promise.all(rows.slice(i, i + 25).map((r) => knowledgeApp.createKnowledge(knowledgeStore, f.actor, { title: r.title, kind: "custom", content: `${r.title} body`, alwaysInclude: false, tags: r.tags })));
      }
      await knowledgeApp.createKnowledge(knowledgeStore, f.actor, { title: "Zulu pricing sheet", kind: "pricing", content: "Plans start at 10.", alwaysInclude: false, tags: ["pricing"] });
      const picked = await engine.knowledgeForTags(f.org, ["pricing"]);
      expect(picked.map((p) => p.title)).toEqual(["Zulu pricing sheet"]);
    }, 60_000);

    it("ranks by tag overlap before the candidate limit, so the best match survives 220 weaker ones", async () => {
      const f = await fixture();
      const rows = Array.from({ length: 220 }, (_, i) => `Doc ${String(i).padStart(3, "0")}`);
      for (let i = 0; i < rows.length; i += 25) {
        await Promise.all(rows.slice(i, i + 25).map((title) => knowledgeApp.createKnowledge(knowledgeStore, f.actor, { title, kind: "custom", content: `${title} body`, alwaysInclude: false, tags: ["pricing"] })));
      }
      await knowledgeApp.createKnowledge(knowledgeStore, f.actor, { title: "Zulu both", kind: "custom", content: "both", alwaysInclude: false, tags: ["pricing", "security"] });
      const picked = await engine.knowledgeForTags(f.org, ["pricing", "security"]);
      expect(picked[0].title).toBe("Zulu both");
    }, 60_000);

    it("keeps documents out of a tagged step's prompt when they match nothing and are not always-included", async () => {
      const f = await fixture();
      await knowledgeApp.createKnowledge(knowledgeStore, f.actor, { title: "Billing", kind: "custom", content: "b", alwaysInclude: false, tags: ["billing"] });
      expect(await engine.knowledgeForTags(f.org, ["pricing"])).toEqual([]);
    });
  });

  describe("default subcategory guidance", () => {
    it("seeds a description and guidance on all 17 subcategories of a new organization", async () => {
      const f = await fixture();
      await receive(f);
      const rows = await sql`select key, description, classification_guidance from reply_types where organization_id = ${f.org}`;
      expect(rows).toHaveLength(DEFAULT_REPLY_TYPES.length);
      for (const s of DEFAULT_REPLY_TYPES) {
        const row = rows.find((r) => r.key === s.key);
        expect(row, s.key).toMatchObject({ description: s.description, classification_guidance: s.classificationGuidance });
      }
    });
  });

  describe("unknown-sender AI cap", () => {
    it("skips the 51st unknown-sender reply with reason daily_cap, runs the rest, and does not retry", async () => {
      const f = await fixture();
      for (let i = 0; i < 51; i++) await receive(f);
      await jobStore.enqueueMissing(new Date());
      const ai = new FakeAi();
      const run = ticker(f, ai);
      await run();
      const jobs = await jobsOf(f.org);
      const classification = jobs.filter((j) => j.kind === "classification");
      expect(classification).toHaveLength(51);
      expect(classification.filter((j) => j.status === "succeeded")).toHaveLength(50);
      const skipped = classification.filter((j) => j.status === "skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0].payload).toMatchObject({ skipReason: "daily_cap", cap: 50 });
      expect(skipped[0].last_error).toContain("50");
      expect(ai.classifyCalls).toBe(50);
      // Drafts of admitted replies are not charged twice.
      expect(jobs.filter((j) => j.kind === "initial_draft" && j.status === "succeeded").length).toBeGreaterThan(0);
      expect(jobs.filter((j) => j.status === "skipped" && j.kind === "initial_draft")).toHaveLength(0);
      // A second tick does not touch it, and the sweep does not requeue it.
      await run();
      expect((await jobsOf(f.org)).filter((j) => j.status === "skipped")).toHaveLength(1);
      expect(ai.classifyCalls).toBe(50);
      const listed = await jobStore.listSkipped(f.org, 10);
      expect(listed.total).toBe(1);
      expect(listed.rows[0]).toMatchObject({ kind: "classification", reason: "daily_cap" });
    }, 120_000);

    it("does not count or skip a sender the organization wrote to", async () => {
      const f = await fixture();
      await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ unknownSenderAiDailyCap: 2 })})`;
      for (let i = 0; i < 2; i++) await receive(f);
      const known = `known-${f.tag}@acme.test`;
      expect(await receive(f, known)).toMatchObject({ status: "created", personCreated: true });
      const [conv] = await sql`select c.id from conversations c join messages m on m.conversation_id = c.id where c.organization_id = ${f.org} and m.from_address = ${known}`;
      await sql`
        insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, subject, from_address, to_address, body_text, sent_at)
        values (${f.org}, ${conv.id}, 'email', ${f.address}, 'outbound', ${"kg-out-" + f.tag}, 'hello', ${f.address}, ${known}, 'Earlier outreach', now() - interval '2 days')`;
      for (let i = 0; i < 2; i++) await receive(f); // two more unknown senders, over the cap of 2
      await jobStore.enqueueMissing(new Date());
      const ai = new FakeAi();
      await ticker(f, ai)();
      const rows = await sql`
        select j.status, m.from_address from ai_jobs j join messages m on m.id = j.entity_id
        where j.organization_id = ${f.org} and j.kind = 'classification'`;
      expect(rows.filter((r) => r.from_address === known).map((r) => r.status)).toEqual(["succeeded"]);
      const unknown = rows.filter((r) => r.from_address !== known);
      expect(unknown.filter((r) => r.status === "succeeded")).toHaveLength(2);
      expect(unknown.filter((r) => r.status === "skipped")).toHaveLength(2);
    }, 120_000);

    it("never skips a draft job that a person's correction queued, and still skips machine-queued work from the same cap", async () => {
      const f = await fixture();
      const [{ id: userId }] = await sql`insert into users (name, email) values ('Member', ${`m-${f.tag}@x.test`}) returning id`;
      users.push(userId);
      await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ unknownSenderAiDailyCap: 1 })})`;
      const ai = new FakeAi();
      const run = ticker(f, ai);
      // B was classified and drafted two days ago, so today's count does not include it.
      const b = `b-${f.tag}@acme.test`;
      await receive(f, b);
      await run();
      await sql`update ai_jobs set started_at = now() - interval '2 days', completed_at = now() - interval '2 days' where organization_id = ${f.org}`;
      // Today the first unknown sender (A) takes the single place; C arrives after it.
      await receive(f, `a-${f.tag}@acme.test`);
      await run();
      const c = `c-${f.tag}@acme.test`;
      await receive(f, c);
      await run();
      const statusOf = async (kind: string, from: string) =>
        (await sql`
          select j.status, j.payload from ai_jobs j
          join messages m on m.id = case when j.kind = 'classification' then j.entity_id else (select message_id from reply_type_picks where id = j.entity_id) end
          where j.organization_id = ${f.org} and j.kind = ${kind} and m.from_address = ${from}`)[0];
      expect(await statusOf("classification", c)).toMatchObject({ status: "skipped", payload: { skipReason: "daily_cap" } });
      // A person corrects B's category: the new draft job carries the flag and runs although the cap is used up.
      const [conv] = await sql`select c.id, r.context_version from conversations c join records r on r.id = c.record_id join messages m on m.conversation_id = c.id where c.organization_id = ${f.org} and m.from_address = ${b}`;
      const replies = (await import("../../../infrastructure/drizzle-reply-store")).drizzleReplyStore;
      const corrected = await replies.applyHumanReplyTypePick({ organizationId: f.org, conversationId: conv.id, replyTypeKey: "demo_request", expectedContextVersion: conv.context_version, actorUserId: userId, wantsDraft: () => true });
      expect(corrected.draftQueued).toBe(true);
      expect((await statusOf("initial_draft", b)).payload).toMatchObject({ humanInitiated: true });
      const draftsBefore = ai.draftCalls;
      await run();
      expect((await statusOf("initial_draft", b)).status).toBe("succeeded");
      expect(ai.draftCalls).toBe(draftsBefore + 1);
      // The machine-queued job of C stays skipped.
      expect((await statusOf("classification", c)).status).toBe("skipped");
    }, 120_000);

    it("a cap of 0 skips every unknown sender", async () => {
      const f = await fixture();
      await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ unknownSenderAiDailyCap: 0 })})`;
      await receive(f);
      await jobStore.enqueueMissing(new Date());
      const ai = new FakeAi();
      await ticker(f, ai)();
      expect((await jobsOf(f.org)).map((j) => j.status)).toEqual(["skipped"]);
      expect(ai.classifyCalls).toBe(0);
    }, 60_000);

    it("starts the day at local midnight of the organization time zone", async () => {
      const f = await fixture();
      const zone = "Pacific/Kiritimati"; // UTC+14, so local midnight is far from UTC midnight
      await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ unknownSenderAiDailyCap: 1, timeZone: zone })})`;
      const midnight = (await import("@/contexts/outreach/domain/working-hours")).startOfLocalDay(new Date(), zone);
      const ai = new FakeAi();
      const run = ticker(f, ai);
      await receive(f);
      await jobStore.enqueueMissing(new Date());
      await run();
      // The first job started a minute before local midnight: it belongs to the previous local day.
      await sql`update ai_jobs set started_at = ${new Date(midnight.getTime() - 60_000).toISOString()}::timestamptz where organization_id = ${f.org} and status <> 'skipped'`;
      await receive(f);
      await jobStore.enqueueMissing(new Date());
      await run();
      const statuses = async () => (await sql`select status from ai_jobs where organization_id = ${f.org} and kind = 'classification' order by created_at`).map((r) => r.status);
      expect(await statuses()).toEqual(["succeeded", "succeeded"]);
      // Moved a minute after local midnight, the first job counts for today and the third reply is over the cap.
      await sql`update ai_jobs set started_at = ${new Date(midnight.getTime() + 60_000).toISOString()}::timestamptz where organization_id = ${f.org} and status <> 'skipped'`;
      await receive(f);
      await jobStore.enqueueMissing(new Date());
      await run();
      expect(await statuses()).toEqual(["succeeded", "succeeded", "skipped"]);
    }, 60_000);

    it("lets yesterday's jobs fall out of the count", async () => {
      const f = await fixture();
      await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ unknownSenderAiDailyCap: 1 })})`;
      await receive(f);
      await jobStore.enqueueMissing(new Date());
      const ai = new FakeAi();
      const run = ticker(f, ai);
      await run();
      await sql`update ai_jobs set started_at = now() - interval '2 days', completed_at = now() - interval '2 days' where organization_id = ${f.org}`;
      await receive(f);
      await jobStore.enqueueMissing(new Date());
      await run();
      expect((await jobsOf(f.org)).filter((j) => j.kind === "classification").map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    }, 60_000);
  });
});
