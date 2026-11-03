import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { enableMcp } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {} }) }));

describeDb("MCP OAuth grants", () => {
  useTestEnv({ APP_URL: "http://localhost:3000" });
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let org: TestOrg;
  let tokens: typeof import("@/contexts/agent-access/application/mcp-tokens");
  let principal: typeof import("@/contexts/agent-access/application/mcp-principal");
  let deps: import("@/contexts/agent-access/application/mcp-tokens").McpTokenDeps;
  let principalDeps: import("@/contexts/agent-access/application/mcp-principal").McpPrincipalDeps;

  const actor = () => ({ userId: org.userId, organizationId: org.organizationId, role: "owner" });
  const claims = (clientId: string, scopes = ["mcp:read", "mcp:write", "offline_access"]) => ({ userId: org.userId, organizationId: org.organizationId, clientId, scopes });
  const client = async () => {
    const clientId = `client-${randomBytes(6).toString("hex")}`;
    await sql`insert into oauth_clients (client_id, redirect_uris, name) values (${clientId}, ${["https://app.test/cb"]}, 'Test App')`;
    return clientId;
  };

  beforeAll(async () => {
    tokens = await import("@/contexts/agent-access/application/mcp-tokens");
    principal = await import("@/contexts/agent-access/application/mcp-principal");
    const composition = await import("@/contexts/agent-access/infrastructure/mcp-composition");
    deps = composition.mcpTokenDeps();
    principalDeps = composition.mcpPrincipalDeps();
    org = await createTestOrg(sql, "OAuth grants");
    orgs.push(org);
    await enableMcp(sql, org.organizationId);
  });

  afterAll(async () => {
    try {
      await sql`delete from oauth_clients where name = 'Test App'`;
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("acts as the person with what they agreed to, and a token's scopes only narrow that", async () => {
    const clientId = await client();
    expect(await principal.resolveMcpGrant(principalDeps, claims(clientId))).toBeNull();
    await tokens.grantMcpAccess(deps, actor(), { clientId, clientName: "Test App", access: "write" });
    const access = await principal.resolveMcpGrant(principalDeps, claims(clientId));
    expect(access).toMatchObject({ principal: { userId: org.userId, organizationId: org.organizationId, scopes: ["mcp:read", "mcp:write"], tokenName: "Test App" } });
    expect(await principal.resolveMcpGrant(principalDeps, claims(clientId, ["mcp:read"]))).toMatchObject({ principal: { scopes: ["mcp:read"] } });
    // A token cannot name more than the person agreed to.
    expect(await principal.resolveMcpGrant(principalDeps, claims(clientId, ["mcp:read", "mcp:write", "mcp:send"]))).toMatchObject({ principal: { scopes: ["mcp:read", "mcp:write"] } });
  });

  it("refuses sending where the organization does not allow it, and does not count against the token limit", async () => {
    const clientId = await client();
    await expect(tokens.grantMcpAccess(deps, actor(), { clientId, clientName: "Test App", access: "send" })).rejects.toThrow(/Agent sending is off/);
    expect(await sql`select 1 from mcp_tokens where oauth_grant_id like ${`%:${clientId}`}`).toHaveLength(0);
    const before = (await tokens.listMcpTokens(deps, actor(), "mine")).filter((t) => t.kind === "oauth").length;
    await tokens.grantMcpAccess(deps, actor(), { clientId, clientName: "Test App", access: "read" });
    expect((await tokens.listMcpTokens(deps, actor(), "mine")).filter((t) => t.kind === "oauth")).toHaveLength(before + 1);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from mcp_tokens where organization_id = ${org.organizationId} and kind = 'pat'`;
    expect(row.n).toBe(0);
  });

  it("stops a revoked grant, drops its consent and refresh tokens, and agreeing again brings the same row back", async () => {
    const clientId = await client();
    await tokens.grantMcpAccess(deps, actor(), { clientId, clientName: "Test App", access: "write" });
    await sql`insert into oauth_consents (client_id, user_id, reference_id, scopes) values (${clientId}, ${org.userId}, ${org.organizationId}, ${["mcp:read"]})`;
    await sql`insert into oauth_refresh_tokens (token, client_id, user_id, reference_id, expires_at, scopes) values (${`rt-${clientId}`}, ${clientId}, ${org.userId}, ${org.organizationId}, now() + interval '1 day', ${["mcp:read"]})`;
    const [{ id }] = await sql<{ id: string }[]>`select id from mcp_tokens where oauth_grant_id like ${`%:${clientId}`}`;

    await tokens.revokeMcpToken(deps, actor(), id);
    expect(await principal.resolveMcpGrant(principalDeps, claims(clientId))).toBeNull();
    expect(await sql`select 1 from oauth_consents where client_id = ${clientId}`).toHaveLength(0);
    const [refresh] = await sql<{ revoked: Date | null }[]>`select revoked from oauth_refresh_tokens where client_id = ${clientId}`;
    expect(refresh.revoked).not.toBeNull();

    await tokens.grantMcpAccess(deps, actor(), { clientId, clientName: "Test App", access: "read" });
    const again = await principal.resolveMcpGrant(principalDeps, claims(clientId));
    expect(again).toMatchObject({ principal: { tokenId: id, scopes: ["mcp:read"] } });
  });

  it("answers MCP is off while the organization has it off, and refuses a new grant", async () => {
    const clientId = await client();
    await tokens.grantMcpAccess(deps, actor(), { clientId, clientName: "Test App", access: "read" });
    await sql`update channel_settings set values = values || ${sql.json({ enabled: false })} where organization_id = ${org.organizationId} and channel = 'mcp'`;
    expect(await principal.resolveMcpGrant(principalDeps, claims(clientId))).toEqual({ refusal: "mcp_disabled" });
    await expect(tokens.grantMcpAccess(deps, actor(), { clientId: await client(), clientName: "Test App", access: "read" })).rejects.toThrow(/MCP is off/);
    await enableMcp(sql, org.organizationId);
  });

  it("refuses a JWT this server signed for anything but this endpoint, and a token that is not one", async () => {
    const { verifyMcpAccessToken } = await import("@/contexts/identity/infrastructure/mcp-oauth");
    const { auth } = await import("@/contexts/identity/infrastructure/auth");
    const signJWT = (auth().api as unknown as { signJWT(args: unknown): Promise<{ token: string }> }).signJWT;
    const { token } = await signJWT({ body: { payload: { sub: org.userId, azp: "x", org_id: org.organizationId, aud: "https://elsewhere.test/mcp", iss: "http://localhost:3000/api/auth" } } });
    expect(await verifyMcpAccessToken(token)).toBeNull();
    const sameAudience = await signJWT({ body: { payload: { sub: org.userId, azp: "x", org_id: org.organizationId, aud: "http://localhost:3000/api/mcp", iss: "http://localhost:3000/api/auth" } } });
    // Right audience, but not an access token: this one lacks the `at+jwt` type.
    expect(await verifyMcpAccessToken(sameAudience.token)).toBeNull();
    expect(await verifyMcpAccessToken("a.b.c")).toBeNull();
    expect(await verifyMcpAccessToken("not-a-jwt")).toBeNull();
  });
});
