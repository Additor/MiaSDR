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
    await sql`insert into mailboxes (organization_id, email_address, status) values (${a}, ${`ok-${tag}@onb.test`}, 'connected'), (${a}, ${`bad-${tag}@onb.test`}, 'failed'), (${b}, ${`other-${tag}@onb.test`}, 'connected')`;
    await sql`insert into people (organization_id, email) values (${a}, ${`p1-${tag}@onb.test`}), (${a}, ${`p2-${tag}@onb.test`}), (${b}, ${`p3-${tag}@onb.test`})`;
    await sql`insert into campaigns (organization_id, channel, name, status) values (${a}, 'email', 'One', 'active'), (${a}, 'email', 'Two', 'draft'), (${b}, 'email', 'Other', 'active')`;

    expect(await store.facts(a)).toEqual({
      connectedMailboxes: 1,
      totalMailboxes: 2,
      connectedLinkedInAccounts: 0,
      leads: 2,
    });
    const { onboardingCampaignFacts } = await import("@/contexts/outreach/infrastructure/composition");
    expect(await onboardingCampaignFacts(a)).toEqual({ campaigns: 2, startedCampaigns: 1, emailsSent: 0 });
  });

  it("counts a campaign past draft as started, whoever started it", async () => {
    const a = await org("started");
    const [{ id: user }] = await sql`insert into users (name, email) values ('S', ${`s-${tag}@onb.test`}) returning id`;
    try {
      const [{ id: token }] = await sql`insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes) values (${a}, ${user}, 'pat', 'T', ${`hs-${tag}`}, 'abcd', ${["mcp:read"]}) returning id`;
      await sql`insert into campaigns (organization_id, channel, name, status, started_via_token_id) values (${a}, 'email', 'Agent', 'active', ${token}), (${a}, 'email', 'Paused', 'paused', null), (${a}, 'email', 'Done', 'completed', null), (${a}, 'email', 'Draft', 'draft', null)`;
      const { onboardingCampaignFacts } = await import("@/contexts/outreach/infrastructure/composition");
      expect(await onboardingCampaignFacts(a)).toEqual({ campaigns: 4, startedCampaigns: 3, emailsSent: 0 });
    } finally {
      await dropOrgs(sql, [{ organizationId: a }]);
      orgs.splice(orgs.indexOf(a), 1);
      await sql`delete from users where id = ${user}`;
    }
  });

  it("counts only sent campaign emails, and a demo send only on an install that runs the fake provider", async () => {
    const a = await org("sends");
    const [{ id: mailbox }] = await sql`insert into mailboxes (organization_id, email_address, status) values (${a}, ${`s-${tag}@onb.test`}, 'connected') returning id`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${a}, 'email', 'C', 'active') returning id`;
    const send = async (status: string, providerMessageId: string | null) => {
      const [{ id: person }] = await sql`insert into people (organization_id, email) values (${a}, ${`p-${Math.random().toString(36).slice(2)}@onb.test`}) returning id`;
      const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${a}, ${campaign}, ${person}, 'email') returning id`;
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, provider_message_id) values (${a}, ${enrollment}, 1, 'email', ${status}, ${mailbox}, ${providerMessageId})`;
    };
    await send("sent", `gmail-${tag}`);
    await send("sent", `fake-0-${tag}`);
    await send("sent", null);
    await send("failed", null);
    await send("unknown", null);
    await sql`insert into sends (organization_id, kind, channel, status, mailbox_id, to_address) values (${a}, 'test', 'email', 'sent', ${mailbox}, 'me@onb.test')`;
    const { onboardingCampaignFacts } = await import("@/contexts/outreach/infrastructure/composition");
    expect((await onboardingCampaignFacts(a, false)).emailsSent).toBe(2);
    expect((await onboardingCampaignFacts(a, true)).emailsSent).toBe(3);
  });

  it("counts replies across channels, without auto-replies, and a demo reply only on an install that runs the fake provider", async () => {
    const a = await org("replies");
    const [{ id: person }] = await sql`insert into people (organization_id, email) values (${a}, ${`rp-${tag}@onb.test`}) returning id`;
    const [{ id: set }] = await sql`insert into reply_type_sets (organization_id, name, is_default) values (${a}, 'default', true) returning id`;
    const [{ id: conversation }] = await sql`insert into conversations (organization_id, person_id, reply_type_set_id) values (${a}, ${person}, ${set}) returning id`;
    const [{ id: thread }] = await sql`insert into threads (organization_id, conversation_id, channel, account_ref) values (${a}, ${conversation}, 'email', 'a@sender.test') returning id`;
    let n = 0;
    const message = async (direction: string, raw: Record<string, unknown>, providerMessageId: string | null) => {
      n += 1;
      await sql`
        insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, body_text, sent_at, raw, provider_message_id)
        values (${a}, ${thread}, 'email', 'a@sender.test', ${direction}, ${`m-${tag}-${n}`}, 'x', now(), ${sql.json(raw as never)}, ${providerMessageId})`;
    };
    await message("inbound", { autoReply: false }, `real-${tag}`);
    await message("inbound", {}, null);
    await message("inbound", { autoReply: true }, `ooo-${tag}`);
    await message("inbound", { autoReply: false }, `fake-in-0-${tag}`);
    await message("outbound", {}, `out-${tag}`);
    const { onboardingReplyFacts } = await import("@/contexts/conversations/infrastructure/composition");
    expect(await onboardingReplyFacts(a, false)).toEqual({ replies: 2 });
    expect(await onboardingReplyFacts(a, true)).toEqual({ replies: 3 });
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
