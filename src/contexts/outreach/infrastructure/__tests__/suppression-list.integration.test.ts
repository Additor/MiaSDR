import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { suppressionStore } from "@/test-support/suppression";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";

describeDb("suppression list", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/suppression-list");
  let deps: import("../../application/suppression-list").SuppressionListDeps;
  const orgs: string[] = [];

  async function org(role = "owner") {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('S', ${"supp-" + tag}) returning id`;
    orgs.push(id);
    return { id, actor: { userId: null as unknown as string, organizationId: id, role } as Actor };
  }

  beforeAll(async () => {
    uc = await import("../../application/suppression-list");
    const { drizzleSuppressionListStore } = await import("../drizzle-suppression-list-store");
    deps = { list: drizzleSuppressionListStore, suppress: await suppressionStore() };
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("adds pasted addresses once, keeps the first reason, and finds them by search", async () => {
    const t = await org();
    await sql`insert into suppression_list (organization_id, email, reason) values (${t.id}, 'gone@acme.test', 'unsubscribed')`;
    const result = await uc.addSuppressions(deps, t.actor, { text: "Ada@Acme.test, gone@acme.test\nada@acme.test;  bo@acme.test", note: "Asked by phone" });
    expect(result).toEqual({ added: 2, alreadyListed: 1, stopped: 0 });
    const listed = await uc.listSuppressions(deps, t.actor, { q: "ACME", limit: 25, offset: 0 });
    expect(listed.total).toBe(3);
    expect(listed.rows.find((r) => r.email === "gone@acme.test")?.reason).toBe("unsubscribed");
    expect(listed.rows.find((r) => r.email === "ada@acme.test")).toMatchObject({ reason: "manual", note: "Asked by phone" });
    expect((await uc.listSuppressions(deps, t.actor, { q: "bo@", limit: 25, offset: 0 })).rows.map((r) => r.email)).toEqual(["bo@acme.test"]);
    const [audit] = await sql`select action, meta from audit_log where organization_id = ${t.id}`;
    expect(audit).toMatchObject({ action: "suppression.added", meta: { count: 2, stopped: 0 } });
  });

  it("refuses members, bad addresses and an empty paste without writing", async () => {
    const t = await org();
    await expect(uc.addSuppressions(deps, { ...t.actor, role: "member" }, { text: "a@acme.test" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.addSuppressions(deps, t.actor, { text: "a@acme.test, not-an-address" })).rejects.toThrow(/not-an-address/);
    await expect(uc.addSuppressions(deps, t.actor, { text: " , " })).rejects.toBeInstanceOf(ValidationError);
    expect(await sql`select 1 from suppression_list where organization_id = ${t.id}`).toHaveLength(0);
  });

  it("removes only an address added by hand, and only in its own organization", async () => {
    const t = await org();
    const other = await org();
    await uc.addSuppressions(deps, t.actor, { text: "hand@acme.test" });
    const [hand] = await sql`select id from suppression_list where organization_id = ${t.id} and email = 'hand@acme.test'`;
    const [bounce] = await sql`insert into suppression_list (organization_id, email, reason) values (${t.id}, 'bounce@acme.test', 'bounced') returning id`;
    await expect(uc.removeSuppression(deps, t.actor, bounce.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(uc.removeSuppression(deps, other.actor, hand.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.removeSuppression(deps, { ...t.actor, role: "member" }, hand.id)).rejects.toBeInstanceOf(ForbiddenError);
    await uc.removeSuppression(deps, t.actor, hand.id);
    expect((await sql`select email from suppression_list where organization_id = ${t.id}`).map((r) => r.email)).toEqual(["bounce@acme.test"]);
  });
});
