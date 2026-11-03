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

    expect(await store.facts(a)).toEqual({
      timeZoneSaved: true,
      connectedMailboxes: 1,
      totalMailboxes: 2,
      connectedLinkedInAccounts: 0,
      leads: 2,
    });
    const { onboardingCampaignFacts } = await import("@/contexts/outreach/infrastructure/composition");
    expect(await onboardingCampaignFacts(a)).toEqual({ campaigns: 2, activeCampaigns: 1 });
  });

  it("counts a running campaign only when a person started it", async () => {
    const a = await org("agent-started");
    const [{ id: user }] = await sql`insert into users (name, email) values ('S', ${`s-${tag}@onb.test`}) returning id`;
    try {
      const [{ id: token }] = await sql`insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes) values (${a}, ${user}, 'pat', 'T', ${`hs-${tag}`}, 'abcd', ${["mcp:read"]}) returning id`;
      await sql`insert into campaigns (organization_id, channel, name, status, started_via_token_id) values (${a}, 'email', 'Agent', 'active', ${token}), (${a}, 'email', 'Person', 'active', null)`;
      const { onboardingCampaignFacts } = await import("@/contexts/outreach/infrastructure/composition");
      expect(await onboardingCampaignFacts(a)).toEqual({ campaigns: 2, activeCampaigns: 1 });
    } finally {
      await dropOrgs(sql, [{ organizationId: a }]);
      orgs.splice(orgs.indexOf(a), 1);
      await sql`delete from users where id = ${user}`;
    }
  });

  it("counts waiting drafts and the replies a person sent, not an agent's", async () => {
    const a = await org("replies");
    const [{ id: user }] = await sql`insert into users (name, email) values ('R', ${`r-${tag}@onb.test`}) returning id`;
    try {
      const [{ id: person }] = await sql`insert into people (organization_id, email) values (${a}, ${`rp-${tag}@onb.test`}) returning id`;
      const [{ id: pipeline }] = await sql`insert into reply_type_sets (organization_id, name, is_default) values (${a}, 'default', true) returning id`;
      const [{ id: record }] = await sql`insert into conversations (organization_id, person_id, reply_type_set_id) values (${a}, ${person}, ${pipeline}) returning id`;
      const [{ id: thread }] = await sql`insert into threads (organization_id, conversation_id, channel, account_ref) values (${a}, ${record}, 'email', 'a@sender.test') returning id`;
      const [{ id: other }] = await sql`insert into threads (organization_id, conversation_id, channel, account_ref, provider_thread_id) values (${a}, ${record}, 'email', 'a@sender.test', 'second') returning id`;
      const ids = await sql<{ id: string; subject: string }[]>`
        insert into drafts (organization_id, conversation_id, thread_id, expected_context_version, channel, subject, status)
        values (${a}, ${record}, ${thread}, 0, 'email', 'One', 'awaiting_review'),
               (${a}, ${record}, ${thread}, 0, 'email', 'Two', 'sent'),
               (${a}, ${record}, ${other}, 0, 'email', 'Three', 'sent'),
               (${a}, ${record}, ${thread}, 0, 'email', 'Four', 'discarded')
        returning id, subject`;
      const draft = (subject: string) => ids.find((d) => d.subject === subject)!.id;
      const [{ id: token }] = await sql`insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes) values (${a}, ${user}, 'pat', 'T', ${`h-${tag}`}, 'abcd', ${["mcp:read"]}) returning id`;
      await sql`
        insert into send_attempts (organization_id, draft_id, idempotency_key, status, actor_user_id, origin, mcp_token_id)
        values (${a}, ${draft("Two")}, ${`person-${tag}`}, 'sent', ${user}, 'person', null),
               (${a}, ${draft("Three")}, ${`agent-${tag}`}, 'sent', ${user}, 'agent', ${token})`;
      const { onboardingReplyFacts } = await import("@/contexts/conversations/infrastructure/composition");
      expect(await onboardingReplyFacts(a)).toEqual({ draftsAwaiting: 1, messagesApproved: 1 });
    } finally {
      await dropOrgs(sql, [{ organizationId: a }]);
      orgs.splice(orgs.indexOf(a), 1);
      await sql`delete from users where id = ${user}`;
    }
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
