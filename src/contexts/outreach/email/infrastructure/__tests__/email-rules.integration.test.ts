import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import { ForbiddenError, ValidationError } from "@/shared/errors";

describeDb("email rules", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/email-rules");
  let store: typeof import("../../../infrastructure/drizzle-channel-settings-store");
  let policy: typeof import("../../../domain/send-policy");
  const orgs: string[] = [];

  async function org(role = "owner") {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('E', ${"rules-" + tag}) returning id`;
    orgs.push(id);
    return { id, actor: { userId: null as unknown as string, organizationId: id, role } as Actor };
  }
  const deps = () => ({ settings: store.drizzleChannelSettingsStore });

  beforeAll(async () => {
    uc = await import("../../application/email-rules");
    store = await import("../../../infrastructure/drizzle-channel-settings-store");
    policy = await import("../../../domain/send-policy");
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("reads defaults, then saves the gap and zone in the shape the send engine reads", async () => {
    const t = await org();
    expect(await uc.getEmailRules(deps(), t.actor)).toEqual({ sendGapMinutes: [18, 24], takeoverAfterHours: 24, timeZone: "UTC" });
    await uc.updateEmailRules(deps(), t.actor, { minGapMinutes: 5, maxGapMinutes: 9, timeZone: "Asia/Seoul" });
    expect(await uc.getEmailRules(deps(), { ...t.actor, role: "member" })).toEqual({ sendGapMinutes: [5, 9], takeoverAfterHours: 24, timeZone: "Asia/Seoul" });
    const [email] = await sql`select values from channel_settings where organization_id = ${t.id} and channel = 'email'`;
    expect(policy.emailRules(email.values).sendGapMinutes).toEqual([5, 9]);
  });

  it("keeps unrelated stored keys when saving", async () => {
    const t = await org();
    await sql`insert into channel_settings (organization_id, channel, values) values (${t.id}, 'email', ${sql.json({ other: "keep" })})`;
    await uc.updateEmailRules(deps(), t.actor, { minGapMinutes: 10, maxGapMinutes: 10, timeZone: "UTC" });
    const [email] = await sql`select values from channel_settings where organization_id = ${t.id} and channel = 'email'`;
    expect(email.values).toEqual({ other: "keep", sendGapMinutes: [10, 10] });
  });

  it("rejects members and invalid input without writing", async () => {
    const t = await org("member");
    await expect(uc.updateEmailRules(deps(), t.actor, { minGapMinutes: 5, maxGapMinutes: 9, timeZone: "UTC" })).rejects.toBeInstanceOf(ForbiddenError);
    const admin = { ...t.actor, role: "admin" };
    await expect(uc.updateEmailRules(deps(), admin, { minGapMinutes: 0, maxGapMinutes: 9, timeZone: "UTC" })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.updateEmailRules(deps(), admin, { minGapMinutes: 9, maxGapMinutes: 5, timeZone: "UTC" })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.updateEmailRules(deps(), admin, { minGapMinutes: 5, maxGapMinutes: 9, timeZone: "Mars/Base" })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.updateEmailRules(deps(), admin, { minGapMinutes: 5, maxGapMinutes: 9, timeZone: "UTC", takeoverAfterHours: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.updateEmailRules(deps(), admin, { minGapMinutes: 5, maxGapMinutes: 9, timeZone: "UTC", takeoverAfterHours: 169 })).rejects.toBeInstanceOf(ValidationError);
    expect(await sql`select 1 from channel_settings where organization_id = ${t.id}`).toHaveLength(0);
  });

  it("saves the takeover delay", async () => {
    const t = await org();
    await uc.updateEmailRules(deps(), t.actor, { minGapMinutes: 5, maxGapMinutes: 9, timeZone: "UTC", takeoverAfterHours: 48 });
    expect((await uc.getEmailRules(deps(), t.actor)).takeoverAfterHours).toBe(48);
  });
});
