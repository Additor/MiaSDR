import { afterAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql } from "./db";
import { seedWorld } from "./full-world";

describeDb("dropOrgs", () => {
  const sql = testSql();
  afterAll(() => sql.end());
  it("removes a fully populated organization and its user", async () => {
    const w = await seedWorld(sql);
    await dropOrgs(sql, [{ organizationId: w.org, userId: w.user }]);
    expect((await sql`select 1 from organizations where id = ${w.org}`).length).toBe(0);
    expect((await sql`select 1 from users where id = ${w.user}`).length).toBe(0);
  });
});
