import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { ForbiddenError, type Actor } from "@/shared/errors";

describeDb("organization sending pause", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/send-pause");
  let deps: import("../../application/send-pause").SendPauseDeps;
  const orgs: string[] = [];

  async function org() {
    const [{ id }] = await sql`insert into organizations (name, slug) values ('P', ${"pause-" + uniqueKey()}) returning id`;
    orgs.push(id);
    return { id, actor: { userId: null as unknown as string, organizationId: id, role: "admin" } as Actor };
  }

  beforeAll(async () => {
    uc = await import("../../application/send-pause");
    deps = (await import("../composition")).sendPauseDeps();
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("pauses once, resumes once, and writes an audit row for each change", async () => {
    const t = await org();
    const at = new Date("2026-10-22T01:00:00.000Z");
    expect(await uc.setSendPause(deps, t.actor, { paused: true, byName: "Ada", now: at })).toEqual({ at: at.toISOString(), byName: "Ada" });
    // Pausing again keeps the first time and name, and writes nothing.
    expect(await uc.setSendPause(deps, t.actor, { paused: true, byName: "Bo", now: new Date() })).toEqual({ at: at.toISOString(), byName: "Ada" });
    expect(await uc.setSendPause(deps, t.actor, { paused: false, byName: "Bo", now: new Date() })).toBeNull();
    expect(await uc.setSendPause(deps, t.actor, { paused: false, byName: "Bo", now: new Date() })).toBeNull();
    const audit = await sql`select action, meta from audit_log where organization_id = ${t.id} order by created_at, action`;
    expect(audit).toEqual([
      { action: "organization.sending_paused", meta: {} },
      { action: "organization.sending_resumed", meta: { pausedAt: at.toISOString() } },
    ]);
    await expect(uc.setSendPause(deps, { ...t.actor, role: "member" }, { paused: true, byName: null, now: new Date() })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
