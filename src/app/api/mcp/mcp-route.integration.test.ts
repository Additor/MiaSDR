import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp, legacyInitialize, MODERN_VERSION, type McpCallOptions } from "@/test-support/mcp-client";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

describeDb("/api/mcp", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let POST: (request: Request) => Promise<Response>;
  let GET: (request: Request) => Promise<Response>;
  let hash: (token: string) => string;
  const orgs: TestOrg[] = [];
  const users: string[] = [];

  async function token(org: TestOrg, patch: { revoked?: boolean } = {}) {
    const raw = `msdr_pat_${randomBytes(32).toString("base64url")}`;
    await sql`insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes, revoked_at)
              values (${org.organizationId}, ${org.userId}, 'pat', 'Test', ${hash(raw)}, ${raw.slice(-4)}, ${["mcp:read"]}, ${patch.revoked ? new Date() : null})`;
    return raw;
  }

  const enable = (org: TestOrg, enabled: boolean) =>
    sql`insert into channel_settings (organization_id, channel, values) values (${org.organizationId}, 'mcp', ${sql.json({ enabled })})
        on conflict (organization_id, channel) do update set values = excluded.values`;

  const post = (options: Omit<McpCallOptions, "era"> & { era?: McpCallOptions["era"] }) => callMcp(POST, { era: "modern", ...options });

  beforeAll(async () => {
    ({ POST, GET } = await import("./route"));
    hash = (await import("@/contexts/tenancy/infrastructure/mcp-composition")).hashMcpToken;
    orgs.push(await createTestOrg(sql, "MCP on"), await createTestOrg(sql, "MCP off"));
    await enable(orgs[0], true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("answers 401 with a bearer challenge without a token, or with a malformed, unknown or revoked one", async () => {
    const [on] = orgs;
    const revoked = await token(on, { revoked: true });
    for (const value of [null, "not-a-token", `msdr_pat_${randomBytes(32).toString("base64url")}`, revoked]) {
      const result = await post({ token: value, method: "server/discover" });
      expect(result.status, String(value)).toBe(401);
      expect(result.headers.get("www-authenticate")).toBe('Bearer realm="miasdr"');
      expect(result.body).toMatchObject({ code: "unauthenticated" });
    }
  });

  it("answers 403 mcp_disabled while the token's organization has MCP off", async () => {
    const result = await post({ token: await token(orgs[1]), method: "server/discover" });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: "mcp_disabled" });
  });

  it("refuses a request from a browser page on another origin and lets a request without an Origin through", async () => {
    const live = await token(orgs[0]);
    for (const origin of ["https://evil.example", "http://localhost:3001", "https://localhost:3000", "null"]) {
      const refused = await post({ token: live, method: "server/discover", headers: { origin } });
      expect(refused.status, origin).toBe(403);
      expect(refused.body).toMatchObject({ code: "foreign_origin" });
    }
    expect((await post({ token: live, method: "server/discover", headers: { origin: "http://localhost:3000" } })).status).toBe(200);
    expect((await post({ token: live, method: "server/discover" })).status).toBe(200);
  });

  it("serves a 2026-07-28 client: discovery names the version and the server", async () => {
    const result = await post({ token: await token(orgs[0]), method: "server/discover" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      result: { supportedVersions: [MODERN_VERSION], _meta: { "io.modelcontextprotocol/serverInfo": { name: "miasdr" } } },
    });
  });

  it("serves a 2025-11-25 client statelessly and answers 405 to its session GET", async () => {
    const live = await token(orgs[0]);
    const result = await post({ era: "legacy", token: live, method: "initialize", params: legacyInitialize });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ result: { protocolVersion: legacyInitialize.protocolVersion, serverInfo: { name: "miasdr" } } });
    expect((await callMcp(GET, { era: "legacy", token: live, method: "", httpMethod: "GET" })).status).toBe(405);
  });

  it("refuses a request whose Mcp-Method header disagrees with its body", async () => {
    const result = await post({ token: await token(orgs[0]), method: "server/discover", headers: { "mcp-method": "tools/list" } });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: -32020 } });
  });

  it("stops answering the token of a member removed from the organization", async () => {
    const [on] = orgs;
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Gone', ${`gone-${randomBytes(4).toString("hex")}@mcp.test`}) returning id`;
    users.push(userId);
    const [{ id: memberId }] = await sql<{ id: string }[]>`insert into members (organization_id, user_id, role) values (${on.organizationId}, ${userId}, 'member') returning id`;
    const raw = `msdr_pat_${randomBytes(32).toString("base64url")}`;
    await sql`insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, scopes) values (${on.organizationId}, ${userId}, 'pat', 'Gone', ${hash(raw)}, ${["mcp:read"]})`;
    expect((await post({ token: raw, method: "server/discover" })).status).toBe(200);
    await sql`delete from members where id = ${memberId}`;
    expect((await post({ token: raw, method: "server/discover" })).status).toBe(401);
  });

  it("answers 429 with Retry-After once a token passes 60 requests in a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T12:00:15Z"));
    const live = await token(orgs[0]);
    const [{ id }] = await sql<{ id: string }[]>`select id from mcp_tokens where token_hash = ${hash(live)}`;
    await sql`insert into mcp_rate_limits (organization_id, token_id, bucket, window_start, count)
              values (${orgs[0].organizationId}, ${id}, 'read', ${new Date("2026-10-30T12:00:00Z")}, 60)`;
    const refused = await post({ token: live, method: "server/discover" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("45");
    expect(refused.body).toMatchObject({ code: "rate_limited", retryAfterSeconds: 45 });

    vi.setSystemTime(new Date("2026-10-30T12:01:00Z"));
    expect((await post({ token: live, method: "server/discover" })).status).toBe(200);
  });

  it("keeps no IP limit without TRUST_PROXY_HOPS", async () => {
    for (let i = 0; i < 25; i++) {
      const result = await post({ token: `msdr_pat_${randomBytes(32).toString("base64url")}`, method: "server/discover", headers: { "x-forwarded-for": "203.0.113.9" } });
      expect(result.status).toBe(401);
    }
  });
});
