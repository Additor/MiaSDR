import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { EngineDeps } from "../../application/send-next-email";
import { FakeMailboxProvider } from "../fake-mailbox-provider";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [{ stepNumber: 1, kind: "email", subject: "Hi", body: "Hello", waitDays: 0 }];

describeDb("send-time mailbox domain policy", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let store: typeof import("../drizzle-outreach-store").drizzleOutreachStore;
  let send: typeof import("../../application/send-next-email");
  let jobs: typeof import("../../application/email-jobs");
  const orgs: string[] = [];
  const now = new Date("2026-10-14T10:00:00Z");

  async function fixture(domains: string[]) {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('P', ${"pol-" + tag}) returning id`;
    orgs.push(org);
    const ids: Record<string, string> = {};
    for (const domain of domains) {
      const [{ id }] = await sql`
        insert into mailboxes (organization_id, email_address, display_name, status, working_hours)
        values (${org}, ${`s-${tag}@${domain}`}, 'S', 'connected', ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`;
      ids[domain] = id;
    }
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'email', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    const [{ id: person }] = await sql`insert into people (organization_id, email, first_name) values (${org}, ${`lead-${tag}@acme.test`}, 'L') returning id`;
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${org}, ${campaign}, ${person}, 'email')`;
    return { org, ids };
  }

  beforeAll(async () => {
    send = await import("../../application/send-next-email");
    jobs = await import("../../application/email-jobs");
    ({ drizzleOutreachStore: store } = await import("../drizzle-outreach-store"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  const mine = (f: { ids: Record<string, string> }, listed: string[]) => listed.filter((id) => Object.values(f.ids).includes(id));

  it("excludes a mailbox outside the list and counts it; inside the list is unaffected", async () => {
    const f = await fixture(["inside.test", "outside.test"]);
    const { ids, blockedByDomainPolicy } = await store.listSendableMailboxIds(now, { allowedDomains: ["inside.test"], openSignup: false });
    expect(mine(f, ids)).toEqual([f.ids["inside.test"]]);
    expect(blockedByDomainPolicy).toBeGreaterThanOrEqual(1);
  });

  it("lists everything with no list on an invite-only instance", async () => {
    const f = await fixture(["a.test", "b.test"]);
    const { ids } = await store.listSendableMailboxIds(now, { allowedDomains: null, openSignup: false });
    expect(mine(f, ids).sort()).toEqual(Object.values(f.ids).sort());
  });

  it("sends from no mailbox under open sign-up without a list", async () => {
    const f = await fixture(["a.test"]);
    const { ids, blockedByDomainPolicy } = await store.listSendableMailboxIds(now, { allowedDomains: null, openSignup: true });
    expect(ids).toEqual([]);
    expect(blockedByDomainPolicy).toBeGreaterThanOrEqual(1);
    expect(f.ids["a.test"]).toBeDefined();
  });

  it("claim refuses an outside mailbox and still serves an inside one", async () => {
    const f = await fixture(["inside.test", "outside.test"]);
    const provider = new FakeMailboxProvider();
    const deps: EngineDeps = {
      store, provider, clock: { now: () => now }, random: () => 0, appUrl: "https://app.test", unsubscribeSecret: "u".repeat(40),
      domainPolicy: { allowedDomains: ["inside.test"], openSignup: false },
    };
    expect((await send.sendNextEmail(deps, f.ids["outside.test"])).kind).toBe("idle");
    expect(provider.delivered).toHaveLength(0);
    expect((await send.sendNextEmail(deps, f.ids["inside.test"])).kind).toBe("sent");
  });

  it("reports blocked_by_domain_policy in the email.send job detail", async () => {
    await fixture(["outside.test"]);
    const deps: EngineDeps = {
      store, provider: new FakeMailboxProvider(), clock: { now: () => now }, random: () => 0, appUrl: "https://app.test", unsubscribeSecret: "u".repeat(40),
      domainPolicy: { allowedDomains: ["inside.test"], openSignup: false },
    };
    const job = jobs.createEmailJobs(deps).find((j) => j.name === "email.send")!;
    const result = await job.run({ now: () => now, deadline: Date.now() + 60_000 } as never);
    expect(result.detail?.blocked_by_domain_policy).toBeGreaterThanOrEqual(1);
  });
});
