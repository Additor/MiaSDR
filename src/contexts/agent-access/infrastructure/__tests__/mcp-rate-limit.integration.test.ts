import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

describeDb("MCP rate limit store", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let store: typeof import("../drizzle-mcp-rate-limit-store").drizzleMcpRateLimitStore;
  let take: typeof import("../../application/mcp-rate-limit").takeMcpRequest;
  const orgs: TestOrg[] = [];
  let tokenId: string;

  beforeAll(async () => {
    store = (await import("../drizzle-mcp-rate-limit-store")).drizzleMcpRateLimitStore;
    take = (await import("../../application/mcp-rate-limit")).takeMcpRequest;
    orgs.push(await createTestOrg(sql, "Rate"));
    [{ id: tokenId }] = await sql<{ id: string }[]>`
      insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, scopes)
      values (${orgs[0].organizationId}, ${orgs[0].userId}, 'pat', 'Rate', ${randomBytes(32).toString("hex")}, ${["mcp:read"]}) returning id`;
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("counts requests in a window, starts over in the next one, and counts concurrent requests once each", async () => {
    const organizationId = orgs[0].organizationId;
    const first = new Date("2026-10-30T12:00:00Z");
    const hit = (windowStart: Date) => store.hit({ organizationId, tokenId, bucket: "read", windowStart });
    expect(await hit(first)).toBe(1);
    expect(await hit(first)).toBe(2);
    const counts = await Promise.all(Array.from({ length: 5 }, () => hit(first)));
    expect(counts.sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7]);
    expect(await hit(new Date("2026-10-30T12:01:00Z"))).toBe(1);
    const [{ rows }] = await sql`select count(*)::int as rows from mcp_rate_limits where token_id = ${tokenId}`;
    expect(rows).toBe(1);
  });

  it("refuses request 61 of a minute with the seconds left", async () => {
    const organizationId = orgs[0].organizationId;
    const now = new Date("2026-10-30T13:00:20Z");
    const deps = { store, now: () => now };
    for (let i = 0; i < 60; i++) expect(await take(deps, { organizationId, tokenId }, "read")).toBeNull();
    expect(await take(deps, { organizationId, tokenId }, "read")).toEqual({ retryAfterSeconds: 40 });
  });
});
