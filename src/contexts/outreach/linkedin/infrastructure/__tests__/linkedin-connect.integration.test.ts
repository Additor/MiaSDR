import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors";
import type { LinkedInManagementDeps } from "../../application/linkedin-management";
import { LinkedInGatewayError } from "../../application/linkedin-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

describeDb("linkedin hosted auth, limits and operations", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let mgmt: typeof import("../../application/linkedin-management");
  let connect: typeof import("../../application/linkedin-connect");
  let ops: typeof import("../../application/linkedin-operations");
  let inboundApp: typeof import("../../application/linkedin-inbound");
  let accountStore: typeof import("../drizzle-linkedin-account-store").drizzleLinkedInAccountStore;
  let connectStore: typeof import("../drizzle-linkedin-connect-store").drizzleLinkedInConnectStore;
  let opsStore: typeof import("../drizzle-linkedin-operations-store").drizzleLinkedInOperationsStore;
  let auditSink: typeof import("@/platform/db/audit").auditSink;
  let inboundStore: ReturnType<typeof import("../drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  let parse: typeof import("../unipile-webhook").parseUnipilePayload;
  const orgs: TestOrg[] = [];
  const current = new Date("2026-10-15T10:00:00Z");

  async function org(options: { appUrl?: string; connected?: boolean } = {}) {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "H");
    orgs.push(created);
    const { organizationId: id, userId } = created;
    const gateway = new FakeLinkedInGateway();
    gateway.accounts = [{ ref: "u-" + tag, linkedinId: "ACo-" + tag, name: "Ada", username: "ada-" + tag, status: "connected" }];
    const deps: LinkedInManagementDeps = { accounts: accountStore, gatewayFor: () => gateway, appUrl: options.appUrl ?? "https://app.example.com", now: () => current, audit: auditSink, connectLinks: connectStore };
    const actor: Actor = { userId, organizationId: id, role: "owner" };
    if (options.connected !== false) await mgmt.connectLinkedIn(deps, actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
    const opsDeps: import("../../application/linkedin-operations").LinkedInOperationsDeps = {
      store: opsStore,
      inbound: { store: inboundStore, clock: { now: () => current }, parse },
      audit: auditSink,
      now: () => current,
    };
    return { id, tag, gateway, deps, opsDeps, actor, member: { ...actor, role: "member" } as Actor };
  }

  const audit = async (organizationId: string, action: string) => await sql`select * from audit_log where organization_id = ${organizationId} and action = ${action} order by created_at`;
  const linkRow = async (id: string) => (await sql`select * from linkedin_connect_links where id = ${id}`)[0];
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");

  /** The id and secret a link carries in its notify URL. */
  function notifyParts(f: { gateway: FakeLinkedInGateway }) {
    const input = f.gateway.hostedLinks.at(-1);
    const notify = new URL(input?.notifyUrl ?? "https://none.invalid/");
    return { link: notify.searchParams.get("link") ?? "", secret: notify.searchParams.get("secret") ?? "", name: input?.name ?? "" };
  }

  beforeAll(async () => {
    mgmt = await import("../../application/linkedin-management");
    connect = await import("../../application/linkedin-connect");
    ops = await import("../../application/linkedin-operations");
    inboundApp = await import("../../application/linkedin-inbound");
    ({ drizzleLinkedInAccountStore: accountStore } = await import("../drizzle-linkedin-account-store"));
    ({ drizzleLinkedInConnectStore: connectStore } = await import("../drizzle-linkedin-connect-store"));
    ({ drizzleLinkedInOperationsStore: opsStore } = await import("../drizzle-linkedin-operations-store"));
    ({ auditSink } = await import("@/platform/db/audit"));
    inboundStore = (await import("../drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    ({ parseUnipilePayload: parse } = await import("../unipile-webhook"));
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("hosted-auth link creation", () => {
    it("sends name, expiry, redirects and a notify URL that carries the link id and a secret", async () => {
      const f = await org();
      const result = await connect.createConnectLink(f.deps, f.actor);
      expect(f.gateway.hostedLinks).toHaveLength(1);
      const sent = f.gateway.hostedLinks[0];
      expect(sent.reconnectAccount).toBeNull();
      expect(sent.name).toMatch(/^mia-[\w-]{12}$/);
      expect(sent.expiresAt.getTime() - current.getTime()).toBe(15 * 60_000);
      expect(sent.successRedirectUrl).toBe(`https://app.example.com/settings/linkedin?unipile=success&link=${result.linkId}`);
      expect(sent.failureRedirectUrl).toBe(`https://app.example.com/settings/linkedin?unipile=failure&link=${result.linkId}`);
      const parts = notifyParts(f);
      expect(sent.notifyUrl).toMatch(/^https:\/\/app\.example\.com\/api\/webhooks\/unipile-account\?link=/);
      expect(parts.link).toBe(result.linkId);
      // Only the hash of the secret is stored.
      const row = await linkRow(result.linkId);
      expect(row.secret_hash).toBe(sha(parts.secret));
      expect(JSON.stringify(row)).not.toContain(parts.secret);
      expect(row).toMatchObject({ organization_id: f.id, status: "pending", provider_name: sent.name });
      expect(await audit(f.id, "linkedin.connect_link_created")).toHaveLength(1);
    });

    it("leaves the notify URL out when the app address is local, and still returns the link", async () => {
      const f = await org({ appUrl: "http://localhost:3000" });
      const result = await connect.createConnectLink(f.deps, f.actor);
      expect(result.notify).toBe(false);
      expect(f.gateway.hostedLinks[0].notifyUrl).toBeNull();
    });

    it("builds a reconnect link for an account of this organization only", async () => {
      const f = await org();
      const other = await org();
      const [mine] = await sql`select id, provider_account_id from linkedin_accounts where organization_id = ${f.id}`;
      const [theirs] = await sql`select id from linkedin_accounts where organization_id = ${other.id}`;
      await connect.createConnectLink(f.deps, f.actor, { reconnectAccountId: mine.id });
      expect(f.gateway.hostedLinks[0].reconnectAccount).toBe(mine.provider_account_id);
      expect(await audit(f.id, "linkedin.reconnect_link_created")).toHaveLength(1);
      await expect(connect.createConnectLink(f.deps, f.actor, { reconnectAccountId: theirs.id })).rejects.toThrow(NotFoundError);
    });

    it("needs an admin and a Unipile connection, and caps open links", async () => {
      const f = await org();
      await expect(connect.createConnectLink(f.deps, f.member)).rejects.toThrow(ForbiddenError);
      const bare = await org({ connected: false });
      await expect(connect.createConnectLink(bare.deps, bare.actor)).rejects.toThrow(ConflictError);
      for (let i = 0; i < connect.MAX_PENDING_LINKS; i++) await connect.createConnectLink(f.deps, f.actor);
      await expect(connect.createConnectLink(f.deps, f.actor)).rejects.toThrow(/still open/);
    });

    it("marks the link failed and gives a fixed message when the provider refuses", async () => {
      const f = await org();
      f.gateway.hostedLinkError = new LinkedInGatewayError("secret provider text", "definite", "auth");
      const error = await connect.createConnectLink(f.deps, f.actor).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.message).not.toContain("secret provider text");
      const [row] = await sql`select status from linkedin_connect_links where organization_id = ${f.id}`;
      expect(row.status).toBe("failed");
    });
  });

  describe("notify callback", () => {
    const body = (name: string, accountId: string, status = "CREATION_SUCCESS") => ({ status, account_id: accountId, name });

    it("rejects a wrong secret, an unknown link and a foreign name with 401 and changes nothing", async () => {
      const f = await org();
      await connect.createConnectLink(f.deps, f.actor);
      const parts = notifyParts(f);
      const call = (input: { linkId: string; secret: string; payload: unknown }) => connect.receiveConnectNotify(f.deps, input);
      expect(await call({ linkId: parts.link, secret: "wrong", payload: body(parts.name, "x") })).toEqual({ status: 401 });
      expect(await call({ linkId: parts.link, secret: "", payload: body(parts.name, "x") })).toEqual({ status: 401 });
      expect(await call({ linkId: "00000000-0000-4000-8000-000000000000", secret: parts.secret, payload: body(parts.name, "x") })).toEqual({ status: 401 });
      expect(await call({ linkId: "nope", secret: parts.secret, payload: body(parts.name, "x") })).toEqual({ status: 401 });
      expect(await call({ linkId: parts.link, secret: parts.secret, payload: body("mia-other", "x") })).toEqual({ status: 401 });
      expect((await linkRow(parts.link)).status).toBe("pending");
    });

    it("cannot complete another organization's link with its own secret", async () => {
      const a = await org();
      const b = await org();
      await connect.createConnectLink(a.deps, a.actor);
      await connect.createConnectLink(b.deps, b.actor);
      const pa = notifyParts(a);
      const pb = notifyParts(b);
      expect(await connect.receiveConnectNotify(a.deps, { linkId: pa.link, secret: pb.secret, payload: body(pa.name, "x") })).toEqual({ status: 401 });
      expect(await connect.receiveConnectNotify(a.deps, { linkId: pa.link, secret: pa.secret, payload: body(pb.name, "x") })).toEqual({ status: 401 });
    });

    it("syncs the new account, completes the link once and audits it", async () => {
      const f = await org();
      await connect.createConnectLink(f.deps, f.actor);
      const parts = notifyParts(f);
      f.gateway.accounts = [...f.gateway.accounts, { ref: "new-" + f.tag, linkedinId: "ACo-new-" + f.tag, name: "Bo", username: "bo-" + f.tag, status: "connected" }];

      const first = await connect.receiveConnectNotify(f.deps, { linkId: parts.link, secret: parts.secret, payload: body(parts.name, "new-" + f.tag) });
      expect(first).toEqual({ status: 200, outcome: "completed" });
      const accounts = await sql`select provider_account_id from linkedin_accounts where organization_id = ${f.id} order by created_at`;
      expect(accounts.map((a) => a.provider_account_id)).toContain("new-" + f.tag);
      const row = await linkRow(parts.link);
      expect(row).toMatchObject({ status: "completed", provider_account_id: "new-" + f.tag });
      expect(row.linkedin_account_id).not.toBeNull();
      expect(row.completed_at).not.toBeNull();

      // Unipile may deliver twice: the second one is a no-op.
      const second = await connect.receiveConnectNotify(f.deps, { linkId: parts.link, secret: parts.secret, payload: body(parts.name, "new-" + f.tag) });
      expect(second).toEqual({ status: 200, outcome: "duplicate" });
      expect(await audit(f.id, "linkedin.account_connected")).toHaveLength(1);
      const [{ n }] = await sql`select count(*)::int as n from linkedin_accounts where organization_id = ${f.id} and provider_account_id = ${"new-" + f.tag}`;
      expect(n).toBe(1);
    });

    it("records a failure status from Unipile, answers 400 for a malformed body and 410 after the grace period", async () => {
      const f = await org();
      await connect.createConnectLink(f.deps, f.actor);
      const parts = notifyParts(f);
      expect(await connect.receiveConnectNotify(f.deps, { linkId: parts.link, secret: parts.secret, payload: { nope: true } })).toEqual({ status: 400 });
      expect(await connect.receiveConnectNotify(f.deps, { linkId: parts.link, secret: parts.secret, payload: { status: "CREATION_SUCCESS", name: parts.name } })).toEqual({ status: 400 });
      expect(await connect.receiveConnectNotify(f.deps, { linkId: parts.link, secret: parts.secret, payload: body(parts.name, "x", "CREATION_FAIL") })).toEqual({ status: 200, outcome: "failed" });
      expect((await linkRow(parts.link)).status).toBe("failed");

      await connect.createConnectLink(f.deps, f.actor);
      const late = notifyParts(f);
      const later = { ...f.deps, now: () => new Date(current.getTime() + (15 + connect.CONNECT_CALLBACK_GRACE_MINUTES + 1) * 60_000) };
      expect(await connect.receiveConnectNotify(later, { linkId: late.link, secret: late.secret, payload: body(late.name, "x") })).toEqual({ status: 410 });
      expect((await linkRow(late.link)).status).toBe("failed");
    });

    it("answers 502 and keeps the link pending when the sync fails, so Unipile retries", async () => {
      const f = await org();
      await connect.createConnectLink(f.deps, f.actor);
      const parts = notifyParts(f);
      f.gateway.readOutage = true;
      f.gateway.listAccounts = async () => {
        throw new LinkedInGatewayError("down", "unknown", "unavailable");
      };
      expect(await connect.receiveConnectNotify(f.deps, { linkId: parts.link, secret: parts.secret, payload: body(parts.name, "x") })).toEqual({ status: 502 });
      const row = await linkRow(parts.link);
      expect(row.status).toBe("pending");
      expect(row.last_error).toMatch(/Unipile/);
    });
  });

  describe("limits editor", () => {
    it.each([
      [{ dailyInviteLimit: 0 }],
      [{ dailyInviteLimit: 101 }],
      [{ dailyInviteLimit: 2.5 }],
      [{ dailyMessageLimit: 0 }],
      [{ dailyMessageLimit: 201 }],
    ])("refuses %j and stores nothing", async (settings) => {
      const f = await org();
      const [account] = await sql`select id, daily_invite_limit, daily_message_limit from linkedin_accounts where organization_id = ${f.id}`;
      await expect(mgmt.updateLinkedInAccount(f.deps, f.actor, account.id, settings)).rejects.toThrow(ValidationError);
      const [after] = await sql`select daily_invite_limit, daily_message_limit from linkedin_accounts where id = ${account.id}`;
      expect(after).toEqual({ daily_invite_limit: account.daily_invite_limit, daily_message_limit: account.daily_message_limit });
    });

    it("saves values inside the bounds, warns past the safe edge, and audits the change", async () => {
      const f = await org();
      const [account] = await sql`select id from linkedin_accounts where organization_id = ${f.id}`;
      const fine = await mgmt.updateLinkedInAccount(f.deps, f.actor, account.id, { dailyInviteLimit: 8, dailyMessageLimit: 60 });
      expect(fine.warnings).toEqual([]);
      const risky = await mgmt.updateLinkedInAccount(f.deps, f.actor, account.id, { dailyInviteLimit: 40, dailyMessageLimit: 150, isPremium: true });
      expect(risky.warnings).toHaveLength(2);
      const [after] = await sql`select daily_invite_limit, daily_message_limit from linkedin_accounts where id = ${account.id}`;
      expect(after).toEqual({ daily_invite_limit: 40, daily_message_limit: 150 });
      const rows = await audit(f.id, "linkedin.limits_changed");
      expect(rows).toHaveLength(2);
      expect(rows[1].meta).toMatchObject({ dailyInviteLimit: 40, dailyMessageLimit: 150, isPremium: true });
    });

    it("keeps members out and answers 404 for another organization's account", async () => {
      const a = await org();
      const b = await org();
      const [mine] = await sql`select id from linkedin_accounts where organization_id = ${a.id}`;
      const [theirs] = await sql`select id from linkedin_accounts where organization_id = ${b.id}`;
      await expect(mgmt.updateLinkedInAccount(a.deps, a.member, mine.id, { dailyMessageLimit: 10 })).rejects.toThrow(ForbiddenError);
      await expect(mgmt.updateLinkedInAccount(a.deps, a.actor, theirs.id, { dailyMessageLimit: 10 })).rejects.toThrow(NotFoundError);
      const [untouched] = await sql`select daily_message_limit from linkedin_accounts where id = ${theirs.id}`;
      expect(untouched.daily_message_limit).toBe(50);
    });

    it("counts messages sent today in the account listing", async () => {
      const f = await org();
      const [account] = await sql`select id from linkedin_accounts where organization_id = ${f.id}`;
      const listed = await mgmt.listLinkedInAccounts(f.deps, f.actor);
      expect(listed.accounts[0]).toMatchObject({ dailyMessageLimit: 50, messagesToday: 0 });
      expect(account.id).toBe(listed.accounts[0].id);
    });
  });

  describe("jobs page actions", () => {
    async function failedEvent(f: Awaited<ReturnType<typeof org>>, attempts: number, messageId: string) {
      const payload = {
        event: "message_received",
        account_id: "u-" + f.tag,
        account_type: "LINKEDIN",
        account_info: { type: "LINKEDIN", user_id: "ACo-" + f.tag },
        chat_id: "chat-" + f.tag,
        message_id: messageId,
        message: "hello",
        sender: { attendee_provider_id: "ACo-someone" },
        attendees: [{ attendee_provider_id: "ACo-someone" }, { attendee_provider_id: "ACo-" + f.tag }],
      };
      const [{ id }] = await sql`
        insert into inbound_events (organization_id, provider, provider_event_key, event_type, account_ref, payload, status, attempts, next_attempt_at)
        values (${f.id}, 'unipile', ${"k-" + f.tag + messageId}, 'message_received', ${"u-" + f.tag}, ${sql.json(payload as never)}, 'failed', ${attempts}, ${new Date(current.getTime() + 3600_000)})
        returning id`;
      return id as string;
    }

    it("replays dead and retrying deliveries once, and a second press finds nothing to requeue", async () => {
      const f = await org();
      const g = await org();
      const dead = await failedEvent(f, 8, "m-dead");
      const retrying = await failedEvent(f, 2, "m-retry");
      const other = await failedEvent(g, 8, "m-other");

      expect(await ops.getLinkedInJobsOverview(f.opsDeps, f.actor).then((o) => o.backlog)).toEqual({ dead: 1, retrying: 1, queued: 0 });

      const first = await ops.replayFailedLinkedInWebhooks(f.opsDeps, f.actor);
      expect(first.requeued).toBe(2);
      expect(first.claimed).toBe(2);
      expect(first.done + first.failed).toBe(2);
      const rows = await sql`select id, status, replay_count, last_replayed_at from inbound_events where id in ${sql([dead, retrying])}`;
      for (const row of rows) {
        expect(row.replay_count).toBe(1);
        expect(row.last_replayed_at).not.toBeNull();
        expect(row.status).not.toBe("failed");
      }
      // Another organization's failure stays as it was.
      const [untouched] = await sql`select status, attempts, replay_count from inbound_events where id = ${other}`;
      expect(untouched).toEqual({ status: "failed", attempts: 8, replay_count: 0 });

      const second = await ops.replayFailedLinkedInWebhooks(f.opsDeps, f.actor);
      expect(second).toMatchObject({ requeued: 0, claimed: 0 });
      const [{ n }] = await sql`select count(*)::int as n from inbound_events where organization_id = ${f.id}`;
      expect(n).toBe(2);
      const logged = await audit(f.id, "linkedin.webhooks_replayed");
      expect(logged).toHaveLength(2);
      expect(logged[0].meta).toMatchObject({ requeued: 2 });
      const runs = await sql`select job, status from job_runs where organization_id = ${f.id} and job = 'linkedin.replay-webhooks'`;
      expect(runs).toHaveLength(2);
    });

    it("keeps the event key unique: a delivery that arrives again after a replay is a duplicate", async () => {
      const f = await org();
      const payload = {
        event: "new_relation",
        account_id: "u-" + f.tag,
        account_type: "LINKEDIN",
        user_full_name: "Lead",
        user_provider_id: "ACo-lead",
        user_profile_url: "https://www.linkedin.com/in/lead",
      };
      const deps = { store: inboundStore, clock: { now: () => current }, parse };
      expect((await inboundApp.receiveLinkedInWebhook(deps, { organizationId: f.id, payload })).status).not.toBe("duplicate");
      await sql`update inbound_events set status = 'failed', attempts = 8 where organization_id = ${f.id}`;
      await ops.replayFailedLinkedInWebhooks(f.opsDeps, f.actor);
      expect((await inboundApp.receiveLinkedInWebhook(deps, { organizationId: f.id, payload })).status).toBe("duplicate");
      const [{ n }] = await sql`select count(*)::int as n from inbound_events where organization_id = ${f.id}`;
      expect(n).toBe(1);
    });

    it("requeues a failed delivery once even when the replay has not run yet", async () => {
      const f = await org();
      const id = await failedEvent(f, 8, "m-twice");
      expect(await opsStore.requeueFailedWebhooks(f.id, current, 100)).toBe(1);
      // The row is queued now (zero attempts). A second press must not requeue it or count another replay.
      expect(await opsStore.requeueFailedWebhooks(f.id, current, 100)).toBe(0);
      const [row] = await sql`select replay_count, attempts, status from inbound_events where id = ${id}`;
      expect(row).toEqual({ replay_count: 1, attempts: 0, status: "failed" });
      expect(await ops.getLinkedInJobsOverview(f.opsDeps, f.actor).then((o) => o.backlog)).toEqual({ dead: 0, retrying: 0, queued: 1 });
    });

    it("does not requeue a delivery that was applied or dismissed", async () => {
      const f = await org();
      const done = await failedEvent(f, 3, "m-done");
      const dismissed = await failedEvent(f, 8, "m-dismissed");
      await sql`update inbound_events set status = 'done' where id = ${done}`;
      await sql`update inbound_events set status = 'skipped' where id = ${dismissed}`;
      expect(await opsStore.requeueFailedWebhooks(f.id, current, 100)).toBe(0);
      const rows = await sql`select replay_count from inbound_events where organization_id = ${f.id}`;
      expect(rows.every((r) => r.replay_count === 0)).toBe(true);
    });

    it("leaves the invitation and message counts alone on reset", async () => {
      const f = await org();
      const [account] = await sql`select id from linkedin_accounts where organization_id = ${f.id}`;
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.id}, 'linkedin', 'c', 'active', '[]'::jsonb) returning id`;
      for (const step of [1, 2]) {
        const [{ id: person }] = await sql`insert into people (organization_id, linkedin_slug, first_name) values (${f.id}, ${"p" + step + f.tag}, 'P') returning id`;
        const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${f.id}, ${campaign}, ${person}, 'linkedin') returning id`;
        await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, attempt, claimed_at) values (${f.id}, ${enrollment}, ${step}, 'linkedin', 'sent', ${account.id}, 1, ${current})`;
      }
      const count = async () => (await sql`select count(*)::int as n from sends where linkedin_account_id = ${account.id}`)[0].n;
      expect(await count()).toBe(2);
      await ops.resetLinkedInDailyCounters(f.opsDeps, f.actor);
      expect(await count()).toBe(2);
      expect((await mgmt.listLinkedInAccounts(f.deps, f.actor)).accounts[0].messagesToday).toBe(1);
    });

    it("lets only an admin replay or reset", async () => {
      const f = await org();
      await expect(ops.replayFailedLinkedInWebhooks(f.opsDeps, f.member)).rejects.toThrow(ForbiddenError);
      await expect(ops.resetLinkedInDailyCounters(f.opsDeps, f.member)).rejects.toThrow(ForbiddenError);
      await expect(ops.getLinkedInJobsOverview(f.opsDeps, f.member)).rejects.toThrow(ForbiddenError);
      expect(await audit(f.id, "linkedin.daily_counters_reset")).toHaveLength(0);
    });

    it("resets the pause and the search counter of this organization only, keeps send counts, and writes an audit row", async () => {
      const f = await org();
      const g = await org();
      const future = new Date(current.getTime() + 3600_000);
      await sql`update linkedin_accounts set limit_reached_until = ${future}, search_leads_today = 120 where organization_id in (${f.id}, ${g.id})`;
      const outcome = await ops.resetLinkedInDailyCounters(f.opsDeps, f.actor);
      expect(outcome).toEqual({ accounts: 1, pausesCleared: 1, searchCountersCleared: 1 });
      const [mine] = await sql`select limit_reached_until, search_leads_today from linkedin_accounts where organization_id = ${f.id}`;
      expect(mine).toEqual({ limit_reached_until: null, search_leads_today: 0 });
      const [theirs] = await sql`select limit_reached_until, search_leads_today from linkedin_accounts where organization_id = ${g.id}`;
      expect(theirs.search_leads_today).toBe(120);
      expect(theirs.limit_reached_until).not.toBeNull();

      const [entry] = await audit(f.id, "linkedin.daily_counters_reset");
      expect(entry.actor_user_id).toBe(f.actor.userId);
      expect(entry.meta).toEqual(outcome);
      expect(await audit(g.id, "linkedin.daily_counters_reset")).toHaveLength(0);
      const overview = await ops.getLinkedInJobsOverview(f.opsDeps, f.actor);
      expect(overview.runs.map((r) => r.job)).toContain("linkedin.reset-daily-counters");
      expect(overview.audit.map((a) => a.action)).toContain("linkedin.daily_counters_reset");
    });
  });
});
