import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callRoute, createWorld, type World } from "@/test-support/route-client";
import { describeDb, dropOrgs, TEST_DATABASE_URL, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * `POST /api/leads/import` and its dry run `summary` answer through `withActor`: a refused archived field is the
 * wrapper's 409 and an upload the importer cannot use is its 422. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("lead import routes", () => {
  useTestEnv();
  let world: World;

  beforeAll(async () => {
    world = await createWorld(TEST_DATABASE_URL ?? "");
  }, 120_000);

  afterAll(async () => {
    if (!world) return;
    // Throws on a failed delete; world.close() then finds nothing left of the two organizations.
    await dropOrgs(world.sql, [{ organizationId: world.orgA.id }, { organizationId: world.orgB.id }]);
    await world.close();
  });

  const upload = (csv: string, mapping: Record<string, string> | null) => {
    const form = new FormData();
    form.set("file", new File([csv], "leads.csv", { type: "text/csv" }));
    if (mapping) form.set("mapping", JSON.stringify(mapping));
    return form;
  };
  const leads = async () => (await world.sql`select count(*)::int as n from people where organization_id = ${world.orgA.id} and email like '%@import-route.test'`)[0].n as number;

  it("answers a member who maps a header to an archived field with the wrapper's 409 and imports nothing", async () => {
    await world.sql`insert into entity_columns (organization_id, entity, key, name, type, position, archived_at) values (${world.orgA.id}, 'people', 'x_import_plan', 'Plan', 'text', 1, now())`;
    const file = () => upload("Email,Plan\na@import-route.test,Pro\n", { Email: "email", Plan: "custom:Plan" });
    for (const route of ["leads/import/route.ts", "leads/import/summary/route.ts"]) {
      const refused = await callRoute(route, "POST", { form: file(), as: world.member });
      expect(refused.status, route).toBe(409);
      expect(refused.headers.get("content-type"), route).toContain("application/json");
      expect(refused.body, route).toEqual({ error: "A field named Plan is archived. Ask an owner or admin to restore it first.", code: "conflict" });
    }
    expect(await leads()).toBe(0);
    expect((await world.sql`select archived_at from entity_columns where organization_id = ${world.orgA.id} and key = 'x_import_plan'`)[0].archived_at).not.toBeNull();
  });

  it("answers 422 with the message for a missing file, a broken mapping, an empty file and a mapping the file cannot make", async () => {
    const noFile = new FormData();
    noFile.set("mapping", JSON.stringify({ Email: "email" }));
    const cases: Array<[string, FormData, string]> = [
      ["leads/import/route.ts", noFile, "Attach a CSV or XLSX file."],
      ["leads/import/route.ts", upload("Email\na@import-route.test\n", null), "The column mapping is missing or invalid."],
      ["leads/import/summary/route.ts", upload("", { Email: "email" }), "The file is empty."],
      ["leads/import/preview/route.ts", upload("", null), "The file is empty."],
      ["leads/import/route.ts", upload("Email,Name\na@import-route.test,A\n", { Email: "skip", Name: "first_name" }), "Map a column to Email or LinkedIn. Each lead needs one of them to be identified."],
    ];
    for (const [route, form, error] of cases) {
      const refused = await callRoute(route, "POST", { form, as: world.admin });
      expect(refused.status, `${route}: ${refused.text}`).toBe(422);
      expect((refused.body as { error: string }).error, route).toBe(error);
    }
    expect(await leads()).toBe(0);
  });
});
