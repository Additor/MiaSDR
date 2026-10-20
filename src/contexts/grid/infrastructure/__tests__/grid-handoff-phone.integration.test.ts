import { afterAll, beforeAll, expect, it } from "vitest";
import type { GridDeps } from "../../application/ports";
import type { Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("grid campaign hand-off phone country", () => {
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
    delete process.env.DEFAULT_PHONE_COUNTRY;
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

  async function push(country: string | null) {
    const { organizationId: id, userId } = await gridOrg(sql, orgs, "member", "ph");
    if (country) await sql`insert into channel_settings (organization_id, channel, values) values (${id}, 'general', ${sql.json({ defaultPhoneCountry: country })})`;
    const actor = { userId, organizationId: id, role: "member" } as Actor;
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    const sheet = await parseUpload({ name: "p.csv", bytes: Buffer.from("Email,Phone\nkim@ph.test,010-1234-5678\n", "utf8") });
    const preview = await io.previewImport(deps, actor, table.id, sheet, "p.csv");
    await io.runImport(deps, actor, table.id, sheet, preview.mapping);
    const page = await rowsUc.getTablePage(deps, actor, table.id);
    const key = (name: string) => page.columns.find((c) => c.name === name)!.key;
    await handoffUc.pushToCampaign(deps, actor, table.id, {
      rowIds: page.rows.map((r) => r.id),
      target: { newCampaignName: "Phones" },
      fields: { email: key("Email"), phone: key("Phone") },
    });
    const [person] = await sql`select phone from people where organization_id = ${id} and email = 'kim@ph.test'`;
    return person.phone as string | null;
  }

  it("keeps a local-format number when the organization country is KR", async () => {
    expect(await push("KR")).toBe("+821012345678");
  });

  it("drops a local-format number when no country is set", async () => {
    expect(await push(null)).toBeNull();
  });
});
