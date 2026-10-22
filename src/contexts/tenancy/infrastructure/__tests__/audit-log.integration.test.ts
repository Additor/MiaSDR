import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { ForbiddenError, type Actor } from "@/shared/errors";

describeDb("audit log", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/audit-log");
  let store: import("../../application/audit-log").AuditLogStore;
  const orgs: string[] = [];

  async function org() {
    const [{ id }] = await sql`insert into organizations (name, slug) values ('A', ${"audit-" + uniqueKey()}) returning id`;
    orgs.push(id);
    return { id, actor: { userId: null as unknown as string, organizationId: id, role: "admin" } as Actor };
  }

  beforeAll(async () => {
    uc = await import("../../application/audit-log");
    store = (await import("../drizzle-audit-log-store")).drizzleAuditLogStore;
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("lists the organization's rows newest first, filters by area and refuses members", async () => {
    const t = await org();
    const other = await org();
    await sql`insert into audit_log (organization_id, action, meta, created_at) values
      (${t.id}, 'deal_stage.renamed', ${sql.json({ from: "New", to: "Inbound" })}, now() - interval '2 minutes'),
      (${t.id}, 'deal.created', '{}', now() - interval '1 minute'),
      (${t.id}, 'organization.renamed', '{}', now()),
      (${other.id}, 'organization.renamed', '{}', now())`;
    const all = await uc.listAuditLog(store, t.actor, { limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.action)).toEqual(["organization.renamed", "deal.created", "deal_stage.renamed"]);
    // `deal` does not catch `deal_stage`: the area ends at the dot.
    expect((await uc.listAuditLog(store, t.actor, { area: "deal", limit: 10, offset: 0 })).rows.map((r) => r.action)).toEqual(["deal.created"]);
    expect((await uc.listAuditLog(store, t.actor, { area: "deal_stage", limit: 10, offset: 0 })).rows[0].meta).toEqual({ from: "New", to: "Inbound" });
    // An unknown area lists everything rather than nothing.
    expect((await uc.listAuditLog(store, t.actor, { area: "nope", limit: 10, offset: 0 })).total).toBe(3);
    expect(() => uc.listAuditLog(store, { ...t.actor, role: "member" }, { limit: 10, offset: 0 })).toThrow(ForbiddenError);
  });
});
