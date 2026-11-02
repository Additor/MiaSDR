import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, type TestOrg } from "@/test-support/db";

describeDb("mcp_tokens schema", () => {
  const sql = testSql({ max: 2 });
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg(sql, "MCP tokens");
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, [org]);
    } finally {
      await sql.end();
    }
  });

  const insert = (row: { kind: string; name?: string; tokenHash?: string | null; tokenHint?: string | null; oauthGrantId?: string | null; policyEpoch?: number }) =>
    sql`insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, oauth_grant_id, scopes, policy_epoch)
        values (${org.organizationId}, ${org.userId}, ${row.kind}, ${row.name ?? "Laptop"}, ${row.tokenHash ?? null}, ${row.tokenHint ?? null},
                ${row.oauthGrantId ?? null}, ${["mcp:read"]}, ${row.policyEpoch ?? 0})`;

  it("stores a personal token by its hash and an OAuth grant by its id", async () => {
    await insert({ kind: "pat", tokenHash: `hash-${uniqueKey()}`, tokenHint: "a1b2" });
    await insert({ kind: "oauth", oauthGrantId: `grant-${uniqueKey()}` });
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from mcp_tokens where organization_id = ${org.organizationId}`;
    expect(count).toBe(2);
  });

  it("refuses a token whose secret does not match its kind", async () => {
    await expect(insert({ kind: "pat" })).rejects.toMatchObject({ code: "23514", constraint_name: "mcp_tokens_secret_ck" });
    await expect(insert({ kind: "pat", tokenHash: `hash-${uniqueKey()}`, oauthGrantId: "grant" })).rejects.toMatchObject({ constraint_name: "mcp_tokens_secret_ck" });
    await expect(insert({ kind: "oauth" })).rejects.toMatchObject({ constraint_name: "mcp_tokens_secret_ck" });
    await expect(insert({ kind: "oauth", oauthGrantId: `grant-${uniqueKey()}`, tokenHint: "a1b2" })).rejects.toMatchObject({ constraint_name: "mcp_tokens_secret_ck" });
    await expect(insert({ kind: "session", tokenHash: `hash-${uniqueKey()}` })).rejects.toMatchObject({ constraint_name: "mcp_tokens_kind_ck" });
  });

  it("refuses a blank or long name, a negative epoch and a reused secret", async () => {
    await expect(insert({ kind: "pat", tokenHash: `hash-${uniqueKey()}`, name: "  " })).rejects.toMatchObject({ constraint_name: "mcp_tokens_name_ck" });
    await expect(insert({ kind: "pat", tokenHash: `hash-${uniqueKey()}`, name: "x".repeat(101) })).rejects.toMatchObject({ constraint_name: "mcp_tokens_name_ck" });
    await expect(insert({ kind: "pat", tokenHash: `hash-${uniqueKey()}`, policyEpoch: -1 })).rejects.toMatchObject({ constraint_name: "mcp_tokens_policy_epoch_ck" });
    const hash = `hash-${uniqueKey()}`;
    await insert({ kind: "pat", tokenHash: hash });
    await expect(insert({ kind: "pat", tokenHash: hash })).rejects.toMatchObject({ code: "23505", constraint_name: "mcp_tokens_token_hash_uq" });
  });
});
