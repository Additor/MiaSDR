import { afterAll, beforeAll, expect, it } from "vitest";
import type { GridDeps } from "../../application/ports";
import type { Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("grid campaign hand-off behind a verification column", () => {
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let rowsUc: typeof import("../../application/row-management");
  let io: typeof import("../../application/import-export");
  let handoffUc: typeof import("../../application/campaign-handoff");
  let parseUpload: typeof import("../parse-upload").parseUpload;

  useTestEnv();

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    rowsUc = await import("../../application/row-management");
    io = await import("../../application/import-export");
    handoffUc = await import("../../application/campaign-handoff");
    parseUpload = (await import("../parse-upload")).parseUpload;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  /** A table of four addresses with a verify-email column that marked them valid, invalid, catch-all and nothing. */
  async function fixture() {
    const { organizationId: id, userId } = await gridOrg(sql, orgs, "member", "vp");
    const actor = { userId, organizationId: id, role: "member" } as Actor;
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    const csv = "Email,Other\nok@vp.test,a\nbad@vp.test,b\nall@vp.test,c\nnew@vp.test,d\n";
    const sheet = await parseUpload({ name: "v.csv", bytes: Buffer.from(csv, "utf8") });
    const preview = await io.previewImport(deps, actor, table.id, sheet, "v.csv");
    await io.runImport(deps, actor, table.id, sheet, preview.mapping);
    let page = await rowsUc.getTablePage(deps, actor, table.id);
    const email = page.columns.find((c) => c.name === "Email")!.key;
    const other = page.columns.find((c) => c.name === "Other")!.key;
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, config, position) values (${id}, ${table.id}, 'check', 'Verify email', 'enrichment', ${sql.json({ actionKey: "verify-email", providerKey: "x", inputs: { email } })}, 99)`;
    const verdicts: Record<string, string> = { "ok@vp.test": "valid", "bad@vp.test": "invalid", "all@vp.test": "catch_all" };
    for (const [address, verdict] of Object.entries(verdicts)) {
      await sql`update grid_rows set cells = cells || ${sql.json({ check: verdict })} where table_id = ${table.id} and cells->>${email} = ${address}`;
    }
    page = await rowsUc.getTablePage(deps, actor, table.id);
    return { id, actor, table: table.id, email, other, rowIds: page.rows.map((r) => r.id) };
  }

  it("counts the verdicts of the chosen rows without pushing anything", async () => {
    const f = await fixture();
    const preview = await handoffUc.previewVerifiedPush(deps, f.actor, f.table, { rowIds: f.rowIds, columnKey: "check" });
    expect(preview).toEqual({ rows: 4, verdicts: { valid: 1, invalid: 1, catch_all: 1, unverified: 1 } });
    expect(await sql`select 1 from people where organization_id = ${f.id}`).toHaveLength(0);
  });

  it("enrolls only the allowed verdicts and lists the rest as skipped", async () => {
    const f = await fixture();
    const report = await handoffUc.pushToCampaign(deps, f.actor, f.table, { rowIds: f.rowIds, target: { newCampaignName: "Verified" }, fields: { email: f.email }, verifiedBy: { columnKey: "check", allow: ["valid", "catch_all"] } });
    expect(report.enrolled).toBe(2);
    expect(report.failures.map((x) => x.reason).sort()).toEqual(["Not verified yet by Verify email", "Verified Invalid by Verify email"]);
    const people = await sql`select email from people where organization_id = ${f.id} order by email`;
    expect(people.map((p) => p.email)).toEqual(["all@vp.test", "ok@vp.test"]);
  });

  it("refuses a check that verified another column than the mapped email, and a push the check empties", async () => {
    const f = await fixture();
    await expect(handoffUc.pushToCampaign(deps, f.actor, f.table, { rowIds: f.rowIds, target: { newCampaignName: "X" }, fields: { email: f.other }, verifiedBy: { columnKey: "check", allow: ["valid"] } })).rejects.toThrow(/checked the Email column, not the email you mapped/);
    const bad = f.rowIds.slice(1, 2);
    await expect(handoffUc.pushToCampaign(deps, f.actor, f.table, { rowIds: bad, target: { newCampaignName: "Y" }, fields: { email: f.email }, verifiedBy: { columnKey: "check", allow: ["valid"] } })).rejects.toThrow(/None of the selected rows passed/);
  });
});
