import postgres from "postgres";
import type { Actor } from "@/shared/errors";
import type { Job } from "@/platform/jobs/types";
import type { InboundEmailInput } from "@/contexts/conversations/application/ports";
import { createCampaign, FLOW_STEPS, recordSentEmail } from "@/contexts/conversations/after-reply/infrastructure/after-reply-test-kit";
import { dropOrgs, testEnv } from "@/test-support/db";

export { waitForLockWaiters } from "@/test-support/db";

/*
 * Fixtures for the deals integration tests: organizations with members, leads with a reply record, a running After a reply
 * follow-up with its draft, and live enrollments. Everything goes through the real ingest and sequence code where a test
 * needs that state. Needs TEST_DATABASE_URL pointing at a migrated Postgres; `bootDealsKit` sets the environment first and
 * `cleanup` puts it back.
 */

export async function bootDealsKit(url: string) {
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(testEnv({ DATABASE_URL: url, MAILBOX_PROVIDER: "fake" }))) {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const sql = postgres(url, { max: 10, onnotice: () => undefined });
  const conversations = await import("@/contexts/conversations/infrastructure/composition");
  const aiJobsApp = await import("@/contexts/conversations/ai/application/ai-jobs");
  const arApp = await import("@/contexts/conversations/after-reply/application/after-reply");
  const seqJobsApp = await import("@/contexts/conversations/after-reply/application/sequence-jobs");
  const seqStore = await import("@/contexts/conversations/after-reply/infrastructure/drizzle-sequence-store");
  const jobs = (await import("@/contexts/conversations/ai/infrastructure/drizzle-ai-job-store")).drizzleAiJobStore;
  const replies = (await import("@/contexts/conversations/infrastructure/drizzle-reply-store")).drizzleReplyStore;
  const engine = (await import("@/contexts/conversations/after-reply/infrastructure/drizzle-sequence-engine")).drizzleSequenceEngine;
  const FakeAi = (await import("@/contexts/conversations/ai/infrastructure/fake-ai-provider")).FakeAiProvider;
  const orgs: string[] = [];
  const users: string[] = [];
  let counter = 0;

  async function organization() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('Deals', ${"deals-" + tag}) returning id`;
    orgs.push(org);
    const user = async (name: string, role: string) => {
      const [{ id }] = await sql`insert into users (name, email) values (${name}, ${`${name.toLowerCase().replace(/\s+/g, "-")}-${tag}@deals.test`}) returning id`;
      users.push(id);
      if (role) await sql`insert into members (organization_id, user_id, role) values (${org}, ${id}, ${role})`;
      return id as string;
    };
    const ownerId = await user("Owner", "owner");
    const memberId = await user("Member", "member");
    const creatorId = await user("Creator", "member");
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const owner: Actor = { userId: ownerId, organizationId: org, role: "owner" };
    const member: Actor = { userId: memberId, organizationId: org, role: "member" };
    const creator: Actor = { userId: creatorId, organizationId: org, role: "member" };

    const ai = new FakeAi();
    const clock = () => new Date();
    const resolver = { forOrganization: async (o: string) => (o === org ? ai : null) };
    const [aiTick] = aiJobsApp.createAiJobs({ jobs, replies, ai: resolver, now: clock, workerId: "ai", leaseMs: aiJobsApp.AI_JOB_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const [seqTick] = seqJobsApp.createSequenceJobs({ engine, runs: seqStore.drizzleRunStore, replies, ai: resolver, now: clock, workerId: "w1", leaseMs: seqJobsApp.SEQUENCE_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const ctx = () => ({ deadline: Date.now() + 60_000, now: clock });

    const mail = (partial: Partial<InboundEmailInput> = {}): InboundEmailInput => {
      const n = ++counter;
      return {
        organizationId: org,
        accountRef: address,
        providerThreadId: `thread-${tag}-${n}`,
        providerMessageId: `msg-${tag}-${n}`,
        rfcMessageId: `<m${n}-${tag}@lead.test>`,
        inReplyTo: null,
        from: { email: `lead${n}-${tag}@acme.test`, name: "Lena Lead" },
        to: [address],
        subject: "Re: hello",
        bodyText: "Could we book a demo next week?",
        receivedAt: new Date(Date.now() - 1000),
        autoReply: false,
        ...partial,
      };
    };

    return {
      org,
      tag,
      owner,
      member,
      creator,
      address,
      mail,
      /** A plain lead without a record. */
      async person(over: { name?: string | null; email?: string | null; companyId?: string | null; contact?: boolean } = {}) {
        const n = ++counter;
        const [{ id }] = await sql`
          insert into people (organization_id, full_name, email, company_id, lifecycle, converted_at)
          values (${org}, ${over.name === undefined ? `Person ${n}` : over.name}, ${over.email === undefined ? `p${n}-${tag}@acme.test` : over.email}, ${over.companyId ?? null},
                  ${over.contact ? "contact" : "lead"}, ${over.contact ? new Date() : null})
          returning id`;
        return id as string;
      },
      async company(name: string, domain = `${name.toLowerCase().replace(/\W+/g, "")}-${tag}.test`) {
        const [{ id }] = await sql`insert into companies (organization_id, domain, name) values (${org}, ${domain}, ${name}) returning id`;
        return id as string;
      },
      /** A personal campaign is a LinkedIn campaign (`campaigns_personal_linkedin_ck`). */
      campaign: (over: { type?: "regular" | "personal"; createdBy?: string; name?: string } = {}) =>
        createCampaign(sql, { organizationId: org, type: over.type, name: over.name, channel: over.type === "personal" ? "linkedin" : "email" }).then(async (id) => {
          if (over.createdBy) await sql`update campaigns set created_by = ${over.createdBy} where id = ${id}`;
          return id;
        }),
      async enrollment(campaignId: string, personId: string, status = "active", channel: "email" | "linkedin" = "email") {
        const [{ id }] = await sql`
          insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, next_send_at)
          values (${org}, ${campaignId}, ${personId}, ${channel}, ${status}, ${status === "active" ? new Date() : null}) returning id`;
        return id as string;
      },
      /** An unknown sender writes in: a lead with a reply record and a public conversation. */
      async ingest(partial: Partial<InboundEmailInput> = {}) {
        const input = mail(partial);
        const result = await conversations.ingestInbound(input);
        const [p] = await sql`select id from people where organization_id = ${org} and lower(email) = ${input.from.email.toLowerCase()}`;
        const [r] = await sql`select id from records where person_id = ${p.id}`;
        return { input, personId: p.id as string, recordId: r.id as string, conversationId: result.conversationId };
      },
      /** The person replied to a regular campaign that drafts follow-ups; after `cycle` the person has an active run and its reply draft. */
      async emailedBy(personId: string) {
        const campaignId = await createCampaign(sql, { organizationId: org });
        const sent = await recordSentEmail(sql, { organizationId: org, campaignId, personId, sentAt: new Date(Date.now() - 3_600_000) });
        await arApp.saveCampaignAfterReply({ flows: seqStore.drizzleAfterReplyStore, now: clock }, owner, campaignId, { mode: "ai_drafts", steps: FLOW_STEPS });
        return { campaignId, repliedEnrollmentId: sent.enrollmentId };
      },
      cycle: async () => {
        await aiTick.run(ctx());
        return seqTick.run(ctx());
      },
    };
  }

  const one = async (query: string, params: unknown[] = []) => (await sql.unsafe(query, params as never[]))[0];
  const count = async (table: string, org: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1 and ${where}`, [org]))[0].n);

  /** Deletes what the kit made and restores the environment. A failed delete throws, so leftovers show up in this file. */
  async function cleanup() {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    } finally {
      await sql.end();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  return { sql, organization, one, count, cleanup };
}

export type DealsKit = Awaited<ReturnType<typeof bootDealsKit>>;
export type DealsOrg = Awaited<ReturnType<DealsKit["organization"]>>;

/** A transaction on its own connection that holds whatever `take` locks until `release`. */
export async function holdLocks(url: string, take: (tx: postgres.TransactionSql) => Promise<unknown>) {
  const conn = postgres(url, { max: 1, onnotice: () => undefined });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let ready!: () => void;
  const taken = new Promise<void>((resolve) => (ready = resolve));
  const done = conn
    .begin(async (tx) => {
      await take(tx);
      ready();
      await released;
    })
    .finally(() => conn.end());
  await taken;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

/** The SQLSTATE of a driver error, or of its cause. */
export function sqlState(error: unknown): string | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && current; i += 1) {
    if (typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}
