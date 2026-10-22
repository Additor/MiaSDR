import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callRoute, createWorld, type World } from "@/test-support/route-client";
import { describeDb, dropOrgs, TEST_DATABASE_URL, useTestEnv } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * `POST /api/leads/delete` by filter: the strict schema takes every filter key the Leads list sends, and a lifecycle other
 * than `lead` answers 422. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("lead delete route by filter", () => {
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

  const person = async (email: string) => (await world.sql`insert into people (organization_id, email, full_name) values (${world.orgA.id}, ${email}, 'Del Route') returning id`)[0].id as string;
  const remaining = async () => (await world.sql`select count(*)::int as n from people where organization_id = ${world.orgA.id} and email like '%@del-route.test'`)[0].n as number;
  const clean = () => world.sql`delete from people where organization_id = ${world.orgA.id} and email like '%@del-route.test'`;
  const del = (filter: Record<string, unknown>, confirmCount: number) => callRoute("leads/delete/route.ts", "POST", { json: { filter, confirmCount }, as: world.admin });

  it("takes hasConversation, replied, the last-contact dates and lifecycle lead, and deletes what they match", async () => {
    await clean();
    await person("a@del-route.test");
    await person("b@del-route.test");
    // Nobody here has a conversation, a reply or a contact date: the filter parses and matches none (422 from the use case, not 400).
    for (const filter of [{ hasConversation: true }, { replied: true }, { lastContactFrom: "2026-01-01", lastContactTo: "2026-12-31" }]) {
      expect(await del({ query: "del-route.test", ...filter }, 0)).toMatchObject({ status: 422, body: { error: "No leads match this filter." } });
    }
    expect(await remaining()).toBe(2);
    const gone = await del({ query: "del-route.test", hasConversation: false, replied: false, lifecycle: "lead" }, 2);
    expect(gone).toMatchObject({ status: 200, body: { deleted: 2, blockedCount: 0 } });
    expect(await remaining()).toBe(0);
  });

  it("answers 422 for a lifecycle other than lead and 400 for a key the list never sends", async () => {
    await clean();
    await person("c@del-route.test");
    for (const lifecycle of ["contact", "all"]) {
      const refused = await del({ query: "del-route.test", lifecycle }, 1);
      expect(refused.status).toBe(422);
      expect((refused.body as { error: string }).error).toBe("Delete all matching works on leads only. Switch the list to leads first.");
    }
    expect((await del({ query: "del-route.test", lifecycle: "everyone" }, 1)).status).toBe(400);
    expect((await del({ query: "del-route.test", ids: ["00000000-0000-4000-8000-000000000001"] }, 1)).status).toBe(400);
    expect(await remaining()).toBe(1);
  });
});
