import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import type { TestSendDeps } from "../../application/send-test-email";
import { FakeMailboxProvider } from "../fake-mailbox-provider";

const OPEN = { allowedDomains: null, openSignup: false };

describeDb("mailbox test send", () => {
  useTestEnv({ BETTER_AUTH_SECRET: "x".repeat(40), INTEGRATION_CREDENTIALS_KEY: "x".repeat(40), UNSUBSCRIBE_SECRET: "x".repeat(40) });
  const sql = testSql({ max: 6 });
  let app: typeof import("../../application/send-test-email");
  let store: typeof import("../drizzle-test-send-store").drizzleTestSendStore;
  const orgs: TestOrg[] = [];
  let at = new Date("2026-10-15T10:00:00Z");

  async function fixture(domain = "box.test", status = "connected") {
    const testOrg = await createTestOrg(sql, "T");
    orgs.push(testOrg);
    const { organizationId: org, userId: user, slug: tag } = testOrg;
    const [{ id: mailbox }] = await sql`
      insert into mailboxes (organization_id, email_address, display_name, status)
      values (${org}, ${`s-${tag}@${domain}`}, 'S', ${status}) returning id`;
    const provider = new FakeMailboxProvider();
    const deps: TestSendDeps = { store, provider, clock: { now: () => at }, appUrl: "https://app.test", unsubscribeSecret: "u".repeat(40), domainPolicy: OPEN };
    const actor = (role = "admin") => ({ userId: user, organizationId: org, role });
    return { org, user, mailbox: mailbox as string, provider, deps, actor, tag };
  }

  const rows = (mailbox: string) => sql`select kind, status, to_address, enrollment_id, step_number, requested_by, rfc_message_id from sends where mailbox_id = ${mailbox} order by claimed_at`;

  beforeAll(async () => {
    app = await import("../../application/send-test-email");
    ({ drizzleTestSendStore: store } = await import("../drizzle-test-send-store"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("claims a kind=test row, sends once and audits", async () => {
    const f = await fixture();
    const result = await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "  Dev@Example.com " });
    expect(result.status).toBe("sent");
    expect(f.provider.delivered).toHaveLength(1);
    expect(f.provider.delivered[0].to).toBe("dev@example.com");
    expect(f.provider.delivered[0].mailbox.emailAddress).toContain("@box.test");
    expect(f.provider.delivered[0].listUnsubscribeUrl).toContain("/api/outreach/unsubscribe?token=");
    const [row] = await rows(f.mailbox);
    expect(row).toMatchObject({ kind: "test", status: "sent", to_address: "dev@example.com", enrollment_id: null, step_number: null, requested_by: f.user });
    expect(row.rfc_message_id).toBe(f.provider.delivered[0].rfcMessageId);
    const audit = await sql`select action, entity_id, meta from audit_log where organization_id = ${f.org}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "mailbox.test_sent", entity_id: f.mailbox });
    expect(audit[0].meta).toMatchObject({ status: "sent", to: "dev@example.com" });
  });

  it("blocks a mailbox outside the allow-list before any row or provider call", async () => {
    const f = await fixture("outside.test");
    const result = await app.sendTestEmail({ ...f.deps, domainPolicy: { allowedDomains: ["inside.test"], openSignup: false } }, f.actor(), f.mailbox, { to: "dev@example.com" });
    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/not an allowed mailbox domain/);
    expect(await rows(f.mailbox)).toHaveLength(0);
    expect(f.provider.delivered).toHaveLength(0);
  });

  it("blocks under open sign-up without a list", async () => {
    const f = await fixture();
    const result = await app.sendTestEmail({ ...f.deps, domainPolicy: { allowedDomains: null, openSignup: true } }, f.actor(), f.mailbox, { to: "dev@example.com" });
    expect(result.status).toBe("blocked");
    expect(f.provider.delivered).toHaveLength(0);
  });

  it("blocks a mailbox that is not connected", async () => {
    const f = await fixture("box.test", "failed");
    expect((await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" })).status).toBe("blocked");
    expect(await rows(f.mailbox)).toHaveLength(0);
  });

  it("allows 3 per mailbox per hour, then reports when the next slot opens; the window slides", async () => {
    const f = await fixture();
    at = new Date("2026-10-15T10:00:00Z");
    for (let i = 0; i < 3; i++) {
      expect((await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" })).status).toBe("sent");
      at = new Date(at.getTime() + 5 * 60_000);
    }
    const fourth = await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" });
    expect(fourth).toMatchObject({ status: "rate_limited", retryAfterMinutes: 45 });
    expect(f.provider.delivered).toHaveLength(3);
    expect(await rows(f.mailbox)).toHaveLength(3);
    // A second mailbox is not affected.
    const g = await fixture();
    expect((await app.sendTestEmail(g.deps, g.actor(), g.mailbox, { to: "dev@example.com" })).status).toBe("sent");
    at = new Date("2026-10-15T11:01:00Z");
    expect((await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" })).status).toBe("sent");
  });

  it("counts a refused attempt toward the limit", async () => {
    const f = await fixture();
    at = new Date("2026-10-15T10:00:00Z");
    f.provider.behavior = () => "refuse";
    for (let i = 0; i < 3; i++) {
      const r = await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" });
      expect(r.status).toBe("failed");
      expect(r.message).toMatch(/Recipient address rejected/);
    }
    expect((await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" })).status).toBe("rate_limited");
    expect((await rows(f.mailbox)).map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
  });

  it("two simultaneous requests claim once: one sends, the other sees it in flight", async () => {
    const f = await fixture();
    at = new Date("2026-10-15T10:00:00Z");
    // Hold the provider call open so the second request reaches the claim while the first is still sending.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const send = f.provider.send.bind(f.provider);
    f.provider.send = async (email) => {
      await gate;
      return send(email);
    };
    const settled: Awaited<ReturnType<typeof app.sendTestEmail>>[] = [];
    const requests = [0, 1].map(() => app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" }).then((r) => (settled.push(r), r)));
    // With a double claim both requests wait at the gate and none settles here.
    await vi.waitFor(() => expect(settled).toHaveLength(1), { timeout: 5_000 });
    release();
    const results = await Promise.all(requests);

    expect(settled[0]).toMatchObject({ status: "blocked", message: expect.stringMatching(/already being sent/) });
    expect(results.map((r) => r.status).sort()).toEqual(["blocked", "sent"]);
    expect(f.provider.delivered).toHaveLength(1);
    expect((await rows(f.mailbox)).map((r) => r.status)).toEqual(["sent"]);
  });

  it("does not send to a suppressed address or a do-not-contact lead", async () => {
    const f = await fixture();
    await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, 'sup@example.com', 'manual')`;
    expect((await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "SUP@example.com" })).status).toBe("blocked");
    const [{ id: person }] = await sql`insert into people (organization_id, email) values (${f.org}, 'dnc@example.com') returning id`;
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${f.org}, ${person}, true, 'human', now())`;
    expect((await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dnc@example.com" })).status).toBe("blocked");
    expect(f.provider.delivered).toHaveLength(0);
    expect(await rows(f.mailbox)).toHaveLength(0);
    await sql`delete from contact_policies where organization_id = ${f.org}`;
    await sql`delete from people where organization_id = ${f.org}`;
  });

  it("rejects members, bad addresses and another organization's mailbox", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(app.sendTestEmail(f.deps, f.actor("member"), f.mailbox, { to: "dev@example.com" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "not an address" })).rejects.toThrow(/valid recipient/);
    await expect(app.sendTestEmail(f.deps, f.actor(), other.mailbox, { to: "dev@example.com" })).rejects.toBeInstanceOf(NotFoundError);
    expect(other.provider.delivered).toHaveLength(0);
    expect(await rows(other.mailbox)).toHaveLength(0);
  });

  it("ends an unconfirmed send as unknown, never retries it, and reconcile settles it from the mailbox", async () => {
    const f = await fixture();
    at = new Date("2026-10-15T10:00:00Z");
    f.provider.behavior = () => "timeout-after-accept";
    const r = await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" });
    expect(r.status).toBe("unknown");
    expect(r.message).toMatch(/do not send another/);
    expect(f.provider.delivered).toHaveLength(1);
    expect((await rows(f.mailbox))[0].status).toBe("unknown");

    // Too young: left alone.
    expect((await app.reconcileTestSends(f.deps)).checked).toBe(0);
    at = new Date(at.getTime() + 11 * 60_000);
    const report = await app.reconcileTestSends(f.deps);
    expect(report.foundSent).toBeGreaterThanOrEqual(1);
    expect((await rows(f.mailbox))[0].status).toBe("sent");
    expect(f.provider.delivered).toHaveLength(1);
  });

  it("settles a send the mailbox does not hold as failed after the grace period, and keeps it when inconclusive", async () => {
    const f = await fixture();
    at = new Date("2026-10-15T10:00:00Z");
    f.provider.behavior = () => "timeout-lost";
    expect((await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" })).status).toBe("unknown");
    at = new Date(at.getTime() + 15 * 60_000);
    f.provider.findInconclusive = "window too old";
    await app.reconcileTestSends(f.deps);
    expect((await rows(f.mailbox))[0].status).toBe("unknown");
    f.provider.findInconclusive = null;
    await app.reconcileTestSends(f.deps);
    expect((await rows(f.mailbox))[0].status).toBe("unknown"); // inside the grace period
    at = new Date(at.getTime() + 20 * 60_000);
    await app.reconcileTestSends(f.deps);
    const [row] = await rows(f.mailbox);
    expect(row.status).toBe("failed");
    expect(f.provider.delivered).toHaveLength(0);
  });

  it("the campaign reconcile and campaign claim ignore test rows", async () => {
    const f = await fixture();
    at = new Date("2026-10-15T10:00:00Z");
    f.provider.behavior = () => "timeout-lost";
    await app.sendTestEmail(f.deps, f.actor(), f.mailbox, { to: "dev@example.com" });
    const { drizzleOutreachStore } = await import("../../../infrastructure/drizzle-outreach-store");
    const uncertain = await drizzleOutreachStore.listUncertain(new Date(at.getTime() + 3600_000), 100);
    expect(uncertain.filter((u) => u.organizationId === f.org)).toHaveLength(0);
  });
});
