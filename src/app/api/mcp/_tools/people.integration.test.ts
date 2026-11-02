import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

describeDb("search_people and get_person", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  let caller: McpCaller;
  let ada: string;
  let carl: string;
  let foreign: string;

  const person = async (org: TestOrg, name: string, email: string, contact = false) => {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into people (organization_id, full_name, email, title, lifecycle, converted_at)
      values (${org.organizationId}, ${name}, ${email}, 'VP Sales', ${contact ? "contact" : "lead"}, ${contact ? new Date() : null}) returning id`;
    return id;
  };

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    orgs.push(await createTestOrg(sql, "People A"), await createTestOrg(sql, "People B"));
    for (const org of orgs) await enableMcp(sql, org.organizationId);
    ada = await person(orgs[0], "Ada Lovelace", "ada@acme.test");
    await person(orgs[0], "Bob Builder", "bob@beta.test");
    carl = await person(orgs[0], "Carl Contact", "carl@acme.test", true);
    foreign = await person(orgs[1], "Ada Elsewhere", "ada@other.test");
    caller = await mcpCaller(sql, POST, orgs[0]);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("search_people filters like the Leads page and stays in the token's organization", async () => {
    const leads = await caller.tool("search_people", {});
    expect(leads.isError, leads.text).toBe(false);
    expect(leads.structured.total).toBe(2);

    const found = await caller.tool("search_people", { query: "ada" });
    expect(found.structured.people).toEqual([expect.objectContaining({ personId: ada, email: "ada@acme.test", lifecycle: "lead", appUrl: `http://localhost:3000/leads/${ada}` })]);

    const everyone = await caller.tool("search_people", { query: "acme", lifecycle: "all" });
    const ids = (everyone.structured.people as Array<{ personId: string; appUrl: string }>).map((p) => p.personId);
    expect(ids.sort()).toEqual([ada, carl].sort());
    expect(JSON.stringify(everyone.structured)).toContain(`/crm/contacts/${carl}`);
    expect(JSON.stringify(everyone.structured)).not.toContain(foreign);
  });

  it("search_people answers an empty page past the last one", async () => {
    const past = await caller.tool("search_people", { page: 9 });
    expect(past.structured).toMatchObject({ total: 2, page: 9, pageCount: 1, people: [] });
  });

  it("get_person reads one person and answers not found for another organization's", async () => {
    const result = await caller.tool("get_person", { personId: ada });
    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({ personId: ada, name: "Ada Lovelace", lifecycle: "lead", enrollments: [], sends: [], reach: { email: "open" } });
    // An imported value comes fenced, so a title cannot pass for MiaSDR's own words.
    expect(result.structured.title).toMatch(/^<untrusted_field_[0-9a-f]+>\nVP Sales\n<\/untrusted_field_[0-9a-f]+>$/);
    const refused = await caller.tool("get_person", { personId: foreign });
    expect(refused.isError).toBe(true);
    expect(refused.structured).toMatchObject({ error: { code: "not_found" } });
  });
});
