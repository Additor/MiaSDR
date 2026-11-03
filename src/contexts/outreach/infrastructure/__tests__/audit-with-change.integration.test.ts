import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

vi.mock("server-only", () => ({}));

/** A change and its audit row commit together. A row that cannot be written, here for a user who does not exist, undoes the change. */
describeDb("audit rows commit with the change", () => {
  useTestEnv({ AI_PROVIDER: "fake", MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });
  const newOrg = async () => {
    const org = await createTestOrg(sql, "Audit");
    orgs.push(org);
    return org;
  };

  it("keeps a suppression when its audit row fails", async () => {
    const { drizzleSuppressionListStore } = await import("../drizzle-suppression-list-store");
    const org = await newOrg();
    const [{ id }] = await sql<{ id: string }[]>`insert into suppression_list (organization_id, email, reason, added_in_settings) values (${org.organizationId}, 'a@acme.test', 'manual', true) returning id`;
    await expect(drizzleSuppressionListStore.remove(org.organizationId, id, { organizationId: org.organizationId, actorUserId: randomUUID(), action: "suppression.removed", entityId: id, meta: {} })).rejects.toThrow();
    expect(await sql`select 1 from suppression_list where id = ${id}`).toHaveLength(1);
  });

  it("keeps the sending pause as it was when its audit row fails", async () => {
    const { sendPauseDeps } = await import("../composition");
    const org = await newOrg();
    await expect(sendPauseDeps().savePause(org.organizationId, { at: new Date().toISOString(), byName: "A" }, org.userId, { organizationId: org.organizationId, actorUserId: randomUUID(), action: "organization.sending_paused" })).rejects.toThrow();
    const [row] = await sql`select values->'sendingPaused' as paused from channel_settings where organization_id = ${org.organizationId} and channel = 'general'`;
    expect(row?.paused ?? null).toBeNull();
  });

  it("keeps a draft campaign when its audit row fails", async () => {
    const { drizzleCampaignStore } = await import("../drizzle-management-stores");
    const org = await newOrg();
    const [{ id }] = await sql<{ id: string }[]>`insert into campaigns (organization_id, channel, name, status, steps) values (${org.organizationId}, 'email', 'Draft', 'draft', ${sql.json([])}) returning id`;
    await expect(drizzleCampaignStore.delete(org.organizationId, id, { organizationId: org.organizationId, actorUserId: randomUUID(), action: "campaign.deleted" })).rejects.toThrow();
    expect(await sql`select 1 from campaigns where id = ${id}`).toHaveLength(1);
  });
});
