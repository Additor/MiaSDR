import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";

/** A reconnect can bring a new vendor id for the same profile. Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("LinkedIn deliveries that name an account's former id", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  const now = new Date("2026-11-05T10:00:00Z");
  let accounts: typeof import("../drizzle-linkedin-account-store").drizzleLinkedInAccountStore;
  let inbound: ReturnType<typeof import("../drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  const orgs: TestOrg[] = [];

  beforeAll(async () => {
    accounts = (await import("../drizzle-linkedin-account-store")).drizzleLinkedInAccountStore;
    inbound = (await import("../drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  async function organization() {
    const created = await createTestOrg(sql, "Former id", "admin");
    orgs.push(created);
    return created.organizationId;
  }

  const sync = (org: string, ref: string, username: string) =>
    accounts.upsertAccounts(org, [{ ref, linkedinId: null, name: "Seller", username, status: "connected", headline: null, isPremium: null }], "unipile");

  const accepted = (org: string, account: string, member: string) =>
    inbound.apply(org, { type: "connection_accepted", account, member, name: "Lead", profileUrl: null }, now);

  const connections = async (account: string) => (await sql`select count(*)::int as n from linkedin_connections c join linkedin_accounts a on a.id = c.linkedin_account_id where a.provider_account_id = ${account}`)[0].n;

  it("applies a delivery from before the reconnect to the account, in place of skipping it", async () => {
    const org = await organization();
    const [before, after, username] = [uniqueKey(), uniqueKey(), `seller-${uniqueKey()}`];
    await sync(org, before, username);
    await sync(org, after, username);
    expect(await accepted(org, before, "member-1")).toMatchObject({ result: "done" });
    expect(await connections(after)).toBe(1);
  });

  it("keeps a former id once when a reconnect goes back and forth, and never lists the current id", async () => {
    const org = await organization();
    const [first, second, username] = [uniqueKey(), uniqueKey(), `seller-${uniqueKey()}`];
    await sync(org, first, username);
    await sync(org, second, username);
    await sync(org, first, username);
    await sync(org, second, username);
    expect((await sql`select former_provider_account_ids as former from linkedin_accounts where provider_account_id = ${second}`)[0].former).toEqual([first]);
  });

  it("sends a delivery to the account that holds the id now, over one that used to", async () => {
    const org = await organization();
    const [shared, later] = [uniqueKey(), uniqueKey()];
    const [oldName, newName] = [`old-${uniqueKey()}`, `new-${uniqueKey()}`];
    await sync(org, shared, oldName);
    await sync(org, later, oldName);
    await sync(org, shared, newName);
    expect(await accepted(org, shared, "member-2")).toMatchObject({ result: "done" });
    expect(await connections(shared)).toBe(1);
    expect(await connections(later)).toBe(0);
  });

  it("does not reach another organization's former id", async () => {
    const [owner, other] = [await organization(), await organization()];
    const [before, after, username] = [uniqueKey(), uniqueKey(), `seller-${uniqueKey()}`];
    await sync(owner, before, username);
    await sync(owner, after, username);
    expect(await accepted(other, before, "member-3")).toMatchObject({ result: "skipped" });
    expect(await connections(after)).toBe(0);
  });

  it("marks only an account on a polled vendor as read by polling", async () => {
    const org = await organization();
    const ref = uniqueKey();
    await sync(org, ref, `seller-${uniqueKey()}`);
    expect((await accounts.list(org, now))[0].inboxReadByPoll).toBe(false);
    await sql`update linkedin_accounts set provider = 'edges' where provider_account_id = ${ref}`;
    expect((await accounts.list(org, now))[0].inboxReadByPoll).toBe(true);
  });
});
