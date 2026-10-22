import { afterAll, beforeAll } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import type { FakeMailboxProvider } from "@/contexts/outreach/email/infrastructure/fake-mailbox-provider";
import type { Actor } from "@/shared/errors";
import type { Job } from "@/platform/jobs/types";
import { createTestOrg, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

export interface ReplyModules {
  composition: typeof import("../composition");
  mgmt: typeof import("../../application/reply-management");
  aiJobsApp: typeof import("../../ai/application/ai-jobs");
  stores: { jobs: typeof import("../../ai/infrastructure/drizzle-ai-job-store").drizzleAiJobStore; replies: typeof import("../drizzle-reply-store").drizzleReplyStore };
  FakeAi: typeof import("../../ai/infrastructure/fake-reply-ai").FakeReplyAi;
  createReplyMailer: typeof import("../reply-mailer").createReplyMailer;
  mailbox: FakeMailboxProvider;
}

/**
 * The email reply setup: the test environment with the fake mailbox, a client, the app modules, and an organization with a
 * connected mailbox, an AI tick and reply deps per `fixture()`. Call it at the top of a `describeDb` block; it drops the
 * organizations after the file. Read `modules` inside tests or hooks, after its `beforeAll` has run.
 */
export function useReplyKit() {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  const modules = {} as ReplyModules;
  const orgs: TestOrg[] = [];
  let counter = 0;

  beforeAll(async () => {
    modules.composition = await import("../composition");
    modules.mgmt = await import("../../application/reply-management");
    modules.aiJobsApp = await import("../../ai/application/ai-jobs");
    modules.stores = { jobs: (await import("../../ai/infrastructure/drizzle-ai-job-store")).drizzleAiJobStore, replies: (await import("../drizzle-reply-store")).drizzleReplyStore };
    modules.FakeAi = (await import("../../ai/infrastructure/fake-reply-ai")).FakeReplyAi;
    modules.createReplyMailer = (await import("../reply-mailer")).createReplyMailer;
    modules.mailbox = (await import("@/contexts/outreach/infrastructure/composition")).mailboxProvider() as FakeMailboxProvider;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  async function fixture(opts: { ai?: InstanceType<ReplyModules["FakeAi"]> | null } = {}) {
    const { stores, aiJobsApp, createReplyMailer } = modules;
    const created = await createTestOrg(sql, "Replies", "member");
    orgs.push(created);
    const { organizationId: org, userId: user, slug: tag } = created;
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const ai = opts.ai === undefined ? new modules.FakeAi() : opts.ai;
    const state = { offsetMs: 0 };
    const clock = () => new Date(Date.now() + state.offsetMs);
    const jobDeps = {
      jobs: stores.jobs,
      replies: stores.replies,
      // Only this fixture's organization has AI, so jobs for rows other tests left behind are released untouched.
      ai: { forOrganization: async (o: string) => (o === org ? ai : null) },
      now: clock,
      workerId: "test",
      leaseMs: aiJobsApp.AI_JOB_LEASE_MS,
      notConfiguredDelayMs: 60_000,
    };
    const [tick] = aiJobsApp.createAiJobs(jobDeps) as [Job];
    const replyDeps = {
      store: stores.replies,
      ai: jobDeps.ai,
      mailer: createReplyMailer(() => modules.mailbox),
      now: clock,
      newToken: () => `tok-${Math.random().toString(36).slice(2)}`,
    };
    const run = () => tick.run({ deadline: Date.now() + 60_000, now: clock });
    return { org, user, actor, address, ai, state, run, replyDeps, tag };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const mail = (f: Fx, partial: Partial<InboundEmailInput> = {}): InboundEmailInput => {
    const n = ++counter;
    return {
      organizationId: f.org,
      accountRef: f.address,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@lead.test>`,
      inReplyTo: null,
      from: { email: `lead${n}-${f.tag}@acme.test`, name: "Lena Lead" },
      to: [f.address],
      subject: "Re: hello",
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
      ...partial,
    };
  };

  const one = async (query: string, params: unknown[]) => (await sql.unsafe(query, params as never[]))[0];
  const count = async (table: string, org: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1 and ${where}`, [org]))[0].n);

  /** Ingests a reply and runs one AI tick. Returns the ids the tests need. */
  async function receive(f: Fx, partial: Partial<InboundEmailInput> = {}) {
    const input = mail(f, partial);
    const result = await modules.composition.ingestInbound(input);
    const detail = await f.run();
    return { ...result, input, detail };
  }
  const panel = async (f: Fx, conversationId: string) => (await modules.mgmt.getReplyPanel(f.replyDeps, f.actor, conversationId))!;
  const sendKey = () => `key-${Math.random().toString(36).slice(2)}`;

  return { sql, modules, fixture, mail, one, count, receive, panel, sendKey };
}

export type ReplyFixture = Awaited<ReturnType<ReturnType<typeof useReplyKit>["fixture"]>>;
