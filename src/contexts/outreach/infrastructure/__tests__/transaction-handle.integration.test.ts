import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

describeDb("transaction handle through stores", () => {
  useTestEnv();
  const sql = testSql({ max: 2 });
  let org = "";
  let user = "";
  let mods: {
    db: typeof import("@/platform/db/client").db;
    importLeads: typeof import("@/contexts/leads/application/import-leads").importLeads;
    leadStore: typeof import("@/contexts/leads/infrastructure/drizzle-lead-store").drizzleLeadStore;
    campaigns: typeof import("../drizzle-management-stores").drizzleCampaignStore;
    liCampaigns: typeof import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
    enrollEmailPeople: typeof import("../drizzle-management-stores").enrollEmailPeople;
    enrollPeople: typeof import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store").enrollPeople;
  };

  beforeAll(async () => {
    const [client, leads, leadStore, email, linkedin] = await Promise.all([
      import("@/platform/db/client"),
      import("@/contexts/leads/application/import-leads"),
      import("@/contexts/leads/infrastructure/drizzle-lead-store"),
      import("../drizzle-management-stores"),
      import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store"),
    ]);
    mods = {
      db: client.db,
      importLeads: leads.importLeads,
      leadStore: leadStore.drizzleLeadStore,
      campaigns: email.drizzleCampaignStore,
      liCampaigns: linkedin.drizzleLinkedInCampaignStore,
      enrollEmailPeople: email.enrollEmailPeople,
      enrollPeople: linkedin.enrollPeople,
    };
    const s = uniqueKey();
    [{ id: org }] = await sql`insert into organizations (name, slug) values ('Tx', ${"tx-" + s}) returning id`;
    [{ id: user }] = await sql`insert into users (name, email) values ('U', ${s + "@tx.test"}) returning id`;
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, [{ organizationId: org, userId: user }]);
    } finally {
      await sql.end();
    }
  });

  const counts = async () => ({
    campaigns: (await sql`select 1 from campaigns where organization_id = ${org}`).length,
    people: (await sql`select 1 from people where organization_id = ${org}`).length,
    enrollments: (await sql`select 1 from campaign_enrollments where organization_id = ${org}`).length,
  });

  for (const channel of ["email", "linkedin"] as const) {
    it(`rolls back ${channel} campaign create, lead import and enrollment together`, async () => {
      const before = await counts();
      const rollback = new Error("rollback");
      const row: Record<string, string> = channel === "email" ? { Email: "tx1@acme.io" } : { Link: "https://www.linkedin.com/in/tx-person-1" };
      const mapping = channel === "email" ? { Email: "email" } : { Link: "linkedin" };
      await expect(
        mods.db.transaction(async (tx) => {
          const store = channel === "email" ? mods.campaigns : mods.liCampaigns;
          const id = await store.create(org, { name: "Atomic", createdBy: user, steps: [] as never }, tx);
          await mods.importLeads({ store: mods.leadStore }, { tx, organizationId: org, userId: user, filename: "t.csv", headers: Object.keys(row), rows: [row], mapping: mapping as never });
          // The new campaign is visible inside the transaction only.
          expect(await store.get(org, id, tx)).not.toBeNull();
          const [person] = await tx.execute<{ id: string }>(`select id from people where organization_id = '${org}'` as never);
          const added = channel === "email" ? await mods.enrollEmailPeople(org, id, [person.id], tx) : await mods.enrollPeople(org, id, [person.id], tx);
          expect(added).toBe(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await counts()).toEqual(before);
    });
  }

  it("commits all of it when the transaction completes", async () => {
    const before = await counts();
    await mods.db.transaction(async (tx) => {
      const id = await mods.campaigns.create(org, { name: "Kept", createdBy: user, steps: [] }, tx);
      await mods.importLeads({ store: mods.leadStore }, { tx, organizationId: org, userId: user, filename: "t.csv", headers: ["Email"], rows: [{ Email: "tx2@acme.io" }], mapping: { Email: "email" } });
      const [person] = await tx.execute<{ id: string }>(`select id from people where organization_id = '${org}' and email = 'tx2@acme.io'` as never);
      await mods.enrollEmailPeople(org, id, [person.id], tx);
    });
    expect(await counts()).toEqual({ campaigns: before.campaigns + 1, people: before.people + 1, enrollments: before.enrollments + 1 });
  });
});
