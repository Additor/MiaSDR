import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("organization default phone country", () => {
  useTestEnv({ DEFAULT_PHONE_COUNTRY: undefined });
  const sql = testSql({ max: 3 });
  let importLeads: typeof import("../../application/import-leads").importLeads;
  let store: typeof import("../drizzle-lead-store").drizzleLeadStore;
  let uc: typeof import("../../application/lead-management");
  let deps: import("../../application/lead-ports").LeadDeps;
  let defaultPhoneCountry: typeof import("../default-phone-country").defaultPhoneCountry;
  let settings: typeof import("@/contexts/tenancy/application/organization-settings");
  let orgDeps: import("@/contexts/tenancy/application/organization-settings").OrganizationDeps;
  const orgs: string[] = [];
  const users: string[] = [];

  async function org() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('P', ${"pc-" + tag}) returning id`;
    const [{ id: userId }] = await sql`insert into users (name, email) values ('U', ${tag + "@pc.test"}) returning id`;
    users.push(userId);
    orgs.push(id);
    const actor = (role: string): Actor => ({ userId, organizationId: id, role });
    return { id: id as string, actor };
  }

  const file = { headers: ["Email", "Phone"], rows: [{ Email: "kim@acme.test", Phone: "010-1234-5678" }], mapping: { Email: "email", Phone: "phone" } as never };
  const run = (orgId: string, userId: string, withDeps: boolean, extra: { defaultCountry?: string } = {}) =>
    importLeads(withDeps ? { store, defaultPhoneCountry } : { store }, { organizationId: orgId, userId, filename: "k.csv", ...file, ...extra });
  const phoneOf = async (orgId: string) => (await sql`select phone from people where organization_id = ${orgId} and email = 'kim@acme.test'`)[0]?.phone ?? null;

  beforeAll(async () => {
    importLeads = (await import("../../application/import-leads")).importLeads;
    store = (await import("../drizzle-lead-store")).drizzleLeadStore;
    uc = await import("../../application/lead-management");
    deps = (await import("../composition")).leadDeps();
    defaultPhoneCountry = (await import("../default-phone-country")).defaultPhoneCountry;
    settings = await import("@/contexts/tenancy/application/organization-settings");
    orgDeps = (await import("@/contexts/tenancy/infrastructure/organization-composition")).organizationDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("drops a local-format number with a warning when no country is set", async () => {
    const o = await org();
    const report = await run(o.id, o.actor("owner").userId, true);
    expect(report.issues.warnings.map((w) => w.reason).join(" ")).toMatch(/not valid and was ignored/);
    expect(await phoneOf(o.id)).toBeNull();
  });

  it("keeps the local-format number once an admin sets the country", async () => {
    const o = await org();
    await settings.updateOrganization(orgDeps, o.actor("admin"), { defaultPhoneCountry: "kr" });
    const report = await run(o.id, o.actor("owner").userId, true);
    expect(report.issues.warnings).toHaveLength(0);
    expect(await phoneOf(o.id)).toBe("+821012345678");
  });

  it("a country sent with the import wins over the setting", async () => {
    const o = await org();
    await settings.updateOrganization(orgDeps, o.actor("owner"), { defaultPhoneCountry: "KR" });
    await run(o.id, o.actor("owner").userId, true, { defaultCountry: "US" });
    expect(await phoneOf(o.id)).toBeNull();
  });

  it("falls back to DEFAULT_PHONE_COUNTRY while the setting is empty", async () => {
    const o = await org();
    process.env.DEFAULT_PHONE_COUNTRY = "kr";
    try {
      await run(o.id, o.actor("owner").userId, true);
      expect(await phoneOf(o.id)).toBe("+821012345678");
      await settings.updateOrganization(orgDeps, o.actor("owner"), { defaultPhoneCountry: "US" });
      expect(await defaultPhoneCountry(o.id)).toBe("US");
    } finally {
      delete process.env.DEFAULT_PHONE_COUNTRY;
    }
  });

  it("the lead edit reads the setting", async () => {
    const o = await org();
    const [{ id: p }] = await sql`insert into people (organization_id, email, full_name) values (${o.id}, 'ed@acme.test', 'Ed') returning id`;
    await expect(uc.updateLead(deps, o.actor("member"), p, { phone: "010-1234-5678" })).rejects.toBeInstanceOf(ValidationError);
    await settings.updateOrganization(orgDeps, o.actor("owner"), { defaultPhoneCountry: "KR" });
    await uc.updateLead(deps, o.actor("member"), p, { phone: "010-1234-5678" });
    expect((await uc.getLead(deps, o.actor("member"), p)).person.phone).toBe("+821012345678");
  });

  it("refuses a member, rejects an unknown country, audits a change once and clears on empty", async () => {
    const o = await org();
    await expect(settings.updateOrganization(orgDeps, o.actor("member"), { defaultPhoneCountry: "KR" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await sql`select 1 from channel_settings where organization_id = ${o.id}`).toHaveLength(0);
    await expect(settings.updateOrganization(orgDeps, o.actor("owner"), { defaultPhoneCountry: "ZZ" })).rejects.toBeInstanceOf(ValidationError);
    const view = await settings.updateOrganization(orgDeps, o.actor("admin"), { defaultPhoneCountry: "KR" });
    expect(view.defaultPhoneCountry).toBe("KR");
    await settings.updateOrganization(orgDeps, o.actor("admin"), { defaultPhoneCountry: "KR" });
    const rows = await sql`select meta, actor_user_id from audit_log where organization_id = ${o.id} and action = 'organization.phone_country_changed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ from: null, to: "KR" });
    expect(rows[0].actor_user_id).toBe(o.actor("admin").userId);
    expect((await settings.updateOrganization(orgDeps, o.actor("admin"), { defaultPhoneCountry: "" })).defaultPhoneCountry).toBeNull();
  });
});
