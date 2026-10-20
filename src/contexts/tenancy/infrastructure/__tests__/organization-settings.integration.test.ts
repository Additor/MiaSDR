import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("organization settings", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let app: typeof import("../../application/organization-settings");
  let deps: import("../../application/organization-settings").OrganizationDeps;
  const orgs: string[] = [];
  const users: string[] = [];

  async function fixture() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('Acme', ${"os-" + tag}) returning id`;
    orgs.push(org);
    const [{ id: user }] = await sql`insert into users (name, email, email_verified) values ('U', ${`o-${tag}@box.test`}, true) returning id`;
    users.push(user);
    const actor = (role: string) => ({ userId: user as string, organizationId: org as string, role });
    return { org: org as string, actor };
  }

  beforeAll(async () => {
    app = await import("../../application/organization-settings");
    deps = (await import("../organization-composition")).organizationDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  const audit = (org: string) => sql`select action, actor_user_id, entity_type, entity_id, meta from audit_log where organization_id = ${org} order by created_at, action`;

  it("lets the owner rename, keeps the slug, and writes an audit row with before and after", async () => {
    const f = await fixture();
    const before = await app.getOrganization(deps, f.actor("owner"));
    const view = await app.updateOrganization(deps, f.actor("owner"), { name: "  Acme Labs " });
    expect(view.name).toBe("Acme Labs");
    expect(view.slug).toBe(before.slug);
    const rows = await audit(f.org);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "organization.renamed", entity_type: "organization", entity_id: f.org });
    expect(rows[0].meta).toEqual({ from: "Acme", to: "Acme Labs" });
  });

  it("refuses rename for admins and members without touching the row or the audit log", async () => {
    const f = await fixture();
    await expect(app.updateOrganization(deps, f.actor("admin"), { name: "Hijack" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(app.updateOrganization(deps, f.actor("member"), { name: "Hijack" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await app.getOrganization(deps, f.actor("owner"))).name).toBe("Acme");
    expect(await audit(f.org)).toHaveLength(0);
  });

  it("rejects a blank, overlong or unchanged-by-whitespace name", async () => {
    const f = await fixture();
    await expect(app.updateOrganization(deps, f.actor("owner"), { name: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(app.updateOrganization(deps, f.actor("owner"), { name: "x".repeat(81) })).rejects.toBeInstanceOf(ValidationError);
    await app.updateOrganization(deps, f.actor("owner"), { name: " Acme " });
    expect(await audit(f.org)).toHaveLength(0);
  });

  it("lets an admin set the time zone, mirrors it to the engine's settings row and audits it", async () => {
    const f = await fixture();
    const view = await app.updateOrganization(deps, f.actor("admin"), { timeZone: "Asia/Seoul" });
    expect(view.timeZone).toBe("Asia/Seoul");
    const [col] = await sql`select timezone from organizations where id = ${f.org}`;
    expect(col.timezone).toBe("Asia/Seoul");
    const [general] = await sql`select values from channel_settings where organization_id = ${f.org} and channel = 'general'`;
    expect(general.values).toEqual({ timeZone: "Asia/Seoul" });
    expect((await audit(f.org)).map((r) => r.action)).toEqual(["organization.timezone_changed"]);
    await expect(app.updateOrganization(deps, f.actor("admin"), { timeZone: "Mars/Olympus" })).rejects.toBeInstanceOf(ValidationError);
    await expect(app.updateOrganization(deps, f.actor("member"), { timeZone: "UTC" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps other keys in the general settings row when the zone changes", async () => {
    const f = await fixture();
    await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ other: 1, timeZone: "UTC" })})`;
    await app.updateOrganization(deps, f.actor("owner"), { timeZone: "Europe/Paris" });
    const [general] = await sql`select values from channel_settings where organization_id = ${f.org} and channel = 'general'`;
    expect(general.values).toEqual({ other: 1, timeZone: "Europe/Paris" });
  });

  it("changes only the caller's organization", async () => {
    const a = await fixture();
    const b = await fixture();
    await app.updateOrganization(deps, a.actor("owner"), { name: "Only A" });
    expect((await app.getOrganization(deps, b.actor("owner"))).name).toBe("Acme");
  });
});
