import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ForbiddenError, ValidationError } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Lives apart from the credential tests because env() caches AI_PROVIDER. */
describeDb("organization AI model", () => {
  useTestEnv({ AI_PROVIDER: "anthropic" });
  const sql = testSql({ max: 3 });
  let model: typeof import("../../application/ai-model");
  let modelStore: typeof import("../drizzle-ai-model-store");
  let uc: typeof import("../../application/integration-management");
  let store: typeof import("../drizzle-integration-store");
  let cipher: typeof import("../credential-cipher").credentialCipher;
  let resolver: typeof import("@/contexts/conversations/ai/infrastructure/ai-composition");
  const orgs: string[] = [];
  const users: string[] = [];
  const ids = ["claude-sonnet-5-5", "claude-live-only"];

  async function org(role = "owner") {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('M', ${"mod-" + tag}) returning id`;
    orgs.push(id);
    const [{ id: userId }] = await sql`insert into users (name, email, email_verified) values ('M', ${`mod-${tag}@test.local`}, true) returning id`;
    users.push(userId);
    const actor: Actor = { userId, organizationId: id, role };
    return { id, actor, member: { ...actor, role: "member" } as Actor };
  }
  const deps = (list: import("../../application/ai-model").ModelListResult = { ok: true, ids }) => ({
    store: modelStore.drizzleAiModelStore,
    catalog: { list: async () => list },
    decrypt: (e: string) => cipher.decrypt(e),
    skipLive: false,
  });
  const save = (organizationId: string, actor: Actor) =>
    uc.saveIntegrationCredential({ integrations: store.drizzleIntegrationStore, cipher: { encrypt: (p: string) => cipher.encrypt(p) }, verifier: { verify: async () => ({ ok: true }) } }, actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-one" } });

  beforeAll(async () => {
    model = await import("../../application/ai-model");
    modelStore = await import("../drizzle-ai-model-store");
    uc = await import("../../application/integration-management");
    store = await import("../drizzle-integration-store");
    cipher = (await import("../credential-cipher")).credentialCipher;
    resolver = await import("@/contexts/conversations/ai/infrastructure/ai-composition");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("stores the model in config, keeps it through a key rotation, audits the change, and the resolver uses it", async () => {
    const t = await org();
    const account = await save(t.id, t.actor);
    await sql`update integration_accounts set config = ${sql.json({ keep: "me" })} where id = ${account.id}`;
    await model.setAiModel(deps(), t.actor, { model: "claude-live-only" });
    const [row] = await sql`select config from integration_accounts where id = ${account.id}`;
    expect(row.config).toEqual({ keep: "me", model: "claude-live-only" });
    const audit = await sql`select actor_user_id, meta from audit_log where organization_id = ${t.id} and action = 'integration.ai_model_changed'`;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(t.actor.userId);
    expect(audit[0].meta).toEqual({ providerKey: "anthropic", from: null, to: "claude-live-only" });
    expect(JSON.stringify(audit[0].meta)).not.toContain("sk-ant");

    await save(t.id, t.actor);
    const [rotated] = await sql`select config from integration_accounts where id = ${account.id}`;
    expect(rotated.config).toEqual({ keep: "me", model: "claude-live-only" });

    const provider = await resolver.aiResolver.forOrganization(t.id);
    expect((provider as unknown as { model: string }).model).toBe("claude-live-only");

    await model.setAiModel(deps(), t.actor, { model: null });
    const [cleared] = await sql`select config from integration_accounts where id = ${account.id}`;
    expect(cleared.config).toEqual({ keep: "me" });
    expect(await sql`select 1 from audit_log where organization_id = ${t.id} and action = 'integration.ai_model_changed'`).toHaveLength(2);
  });

  it("refuses a member and a model outside the live list, and writes nothing", async () => {
    const t = await org();
    const account = await save(t.id, t.actor);
    await expect(model.setAiModel(deps(), t.member, { model: "claude-live-only" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(model.setAiModel(deps(), t.actor, { model: "claude-nope" })).rejects.toBeInstanceOf(ValidationError);
    await expect(model.setAiModel(deps({ ok: false, reason: "unreachable" }), t.actor, { model: "claude-live-only" })).rejects.toBeInstanceOf(ValidationError);
    const [row] = await sql`select config from integration_accounts where id = ${account.id}`;
    expect(row.config).toEqual({});
    expect(await sql`select 1 from audit_log where organization_id = ${t.id} and action = 'integration.ai_model_changed'`).toHaveLength(0);
  });
});
