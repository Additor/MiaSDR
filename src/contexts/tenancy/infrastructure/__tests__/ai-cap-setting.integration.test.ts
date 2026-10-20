import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("unknown-sender AI cap setting", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let app: typeof import("../../application/organization-settings");
  let deps: import("../../application/organization-settings").OrganizationDeps;
  const orgs: TestOrg[] = [];

  async function fixture() {
    const created = await createTestOrg(sql, "Cap");
    orgs.push(created);
    const org = created.organizationId;
    return { org, actor: (role: string) => ({ userId: created.userId, organizationId: org, role }) };
  }

  beforeAll(async () => {
    app = await import("../../application/organization-settings");
    deps = (await import("../organization-composition")).organizationDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("defaults to 50", async () => {
    const f = await fixture();
    expect((await app.getOrganization(deps, f.actor("member"))).unknownSenderAiDailyCap).toBe(50);
  });

  it("lets an owner and an admin change it, keeps the time zone, and audits the change", async () => {
    const f = await fixture();
    await app.updateOrganization(deps, f.actor("owner"), { timeZone: "Europe/Berlin" });
    const view = await app.updateOrganization(deps, f.actor("admin"), { unknownSenderAiDailyCap: 120 });
    expect(view.unknownSenderAiDailyCap).toBe(120);
    expect(view.timeZone).toBe("Europe/Berlin");
    const [row] = await sql`select values from channel_settings where organization_id = ${f.org} and channel = 'general'`;
    expect(row.values).toEqual({ timeZone: "Europe/Berlin", unknownSenderAiDailyCap: 120 });
    const rows = await sql`select action, meta from audit_log where organization_id = ${f.org} and action = 'organization.ai_cap_changed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ from: 50, to: 120 });
    // Setting the same value again writes no audit row.
    await app.updateOrganization(deps, f.actor("admin"), { unknownSenderAiDailyCap: 120 });
    expect(await sql`select 1 from audit_log where organization_id = ${f.org} and action = 'organization.ai_cap_changed'`).toHaveLength(1);
  });

  it("refuses a member and leaves the value alone", async () => {
    const f = await fixture();
    await expect(app.updateOrganization(deps, f.actor("member"), { unknownSenderAiDailyCap: 5 })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await app.getOrganization(deps, f.actor("owner"))).unknownSenderAiDailyCap).toBe(50);
    expect(await sql`select 1 from channel_settings where organization_id = ${f.org}`).toHaveLength(0);
  });

  // The value rules are unit tests in domain/ai-cap.test.ts.
  it("refuses an invalid value without writing it, and stores 0", async () => {
    const f = await fixture();
    await expect(app.updateOrganization(deps, f.actor("owner"), { unknownSenderAiDailyCap: -1 })).rejects.toBeInstanceOf(ValidationError);
    expect(await sql`select 1 from channel_settings where organization_id = ${f.org}`).toHaveLength(0);
    await app.updateOrganization(deps, f.actor("owner"), { unknownSenderAiDailyCap: 0 });
    expect((await app.getOrganization(deps, f.actor("member"))).unknownSenderAiDailyCap).toBe(0);
  });
});
