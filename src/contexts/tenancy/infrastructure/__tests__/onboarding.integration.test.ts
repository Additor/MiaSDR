import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("onboarding store", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let store: typeof import("../drizzle-onboarding-store").drizzleOnboardingStore;
  const orgs: string[] = [];
  const tag = Math.random().toString(36).slice(2, 8);

  async function org(name: string) {
    const [{ id }] = await sql`insert into organizations (name, slug) values (${name}, ${`onb-${name}-${tag}`}) returning id`;
    orgs.push(id);
    return id as string;
  }

  beforeAll(async () => {
    store = (await import("../drizzle-onboarding-store")).drizzleOnboardingStore;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  it("reports an empty organization as all zero", async () => {
    const a = await org("empty");
    expect(await store.facts(a)).toEqual({
      timeZoneSaved: false,
      connectedMailboxes: 0,
      totalMailboxes: 0,
      connectedLinkedInAccounts: 0,
      leads: 0,
      campaigns: 0,
      activeCampaigns: 0,
      draftsAwaiting: 0,
      messagesApproved: 0,
    });
  });

  it("counts leads only: a contact is not a lead", async () => {
    const a = await org("lifecycle");
    await sql`insert into people (organization_id, email) values (${a}, ${`l1-${tag}@onb.test`}), (${a}, ${`l2-${tag}@onb.test`})`;
    await sql`insert into people (organization_id, email, lifecycle, converted_at) values (${a}, ${`c1-${tag}@onb.test`}, 'contact', now())`;
    expect((await store.facts(a)).leads).toBe(2);
    await sql`update people set lifecycle = 'contact', converted_at = now() where organization_id = ${a} and email = ${`l1-${tag}@onb.test`}`;
    expect((await store.facts(a)).leads).toBe(1);
  });

  it("counts only the organization's own rows", async () => {
    const a = await org("a");
    const b = await org("b");
    await sql`insert into channel_settings (organization_id, channel, values) values (${a}, 'general', '{"timeZone":"Asia/Seoul"}')`;
    await sql`insert into mailboxes (organization_id, email_address, status) values (${a}, ${`ok-${tag}@onb.test`}, 'connected'), (${a}, ${`bad-${tag}@onb.test`}, 'failed'), (${b}, ${`other-${tag}@onb.test`}, 'connected')`;
    await sql`insert into people (organization_id, email) values (${a}, ${`p1-${tag}@onb.test`}), (${a}, ${`p2-${tag}@onb.test`}), (${b}, ${`p3-${tag}@onb.test`})`;
    await sql`insert into campaigns (organization_id, channel, name, status) values (${a}, 'email', 'One', 'active'), (${a}, 'email', 'Two', 'draft'), (${b}, 'email', 'Other', 'active')`;

    const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name, is_default) values (${a}, 'default', true) returning id`;
    const [{ id: person }] = await sql`select id from people where organization_id = ${a} limit 1`;
    const [{ id: record }] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${a}, ${person}, ${pipeline}) returning id`;
    const [{ id: conversation }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${a}, ${record}, 'email', 'a@sender.test') returning id`;
    await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, subject, status)
      values (${a}, ${record}, ${conversation}, 0, 'email', 'One', 'awaiting_review'),
             (${a}, ${record}, ${conversation}, 0, 'email', 'Two', 'awaiting_review'),
             (${a}, ${record}, ${conversation}, 0, 'email', 'Three', 'sent'),
             (${a}, ${record}, ${conversation}, 0, 'email', 'Four', 'discarded')`;

    expect(await store.facts(a)).toEqual({
      timeZoneSaved: true,
      connectedMailboxes: 1,
      totalMailboxes: 2,
      connectedLinkedInAccounts: 0,
      leads: 2,
      campaigns: 2,
      activeCampaigns: 1,
      draftsAwaiting: 2,
      messagesApproved: 1,
    });
  });

  it("stores dismissal per organization and keeps it idempotent", async () => {
    const a = await org("dis-a");
    const b = await org("dis-b");
    const [{ id: user }] = await sql`insert into users (name, email) values ('D', ${`d-${tag}@onb.test`}) returning id`;
    try {
      expect(await store.isDismissed(a)).toBe(false);
      await store.dismiss(a, user);
      await store.dismiss(a, user);
      expect(await store.isDismissed(a)).toBe(true);
      expect(await store.isDismissed(b)).toBe(false);
    } finally {
      await sql`delete from users where id = ${user}`;
    }
  });
});
