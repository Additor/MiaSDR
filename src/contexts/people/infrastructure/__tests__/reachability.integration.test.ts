import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

describeDb("reachability read model and writers", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let reach: typeof import("../reachability");
  let dbClient: typeof import("@/platform/db/client");
  const orgs: string[] = [];

  async function org() {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('R', ${"re-" + tag}) returning id`;
    orgs.push(id);
    return { id: id as string, tag };
  }

  const person = async (orgId: string, p: { email?: string | null; slug?: string | null }) => {
    const [{ id }] = await sql`insert into people (organization_id, email, linkedin_slug, full_name) values (${orgId}, ${p.email ?? null}, ${p.slug ?? null}, 'Pat') returning id`;
    return id as string;
  };

  beforeAll(async () => {
    reach = await import("../reachability");
    dbClient = await import("@/platform/db/client");
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("reads do not contact, a suppressed address in any case and missing channels in one query", async () => {
    const o = await org();
    const open = await person(o.id, { email: `open-${o.tag}@re.test`, slug: "open-pat" });
    const suppressed = await person(o.id, { email: `Bounced-${o.tag}@RE.test`, slug: "bounced-pat" });
    const marked = await person(o.id, { email: `dnc-${o.tag}@re.test` });
    const bare = await person(o.id, {});
    await sql`insert into suppression_list (organization_id, email, reason, created_at) values (${o.id}, ${`bounced-${o.tag}@re.test`}, 'bounced', '2026-10-01T10:00:00Z')`;
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, reason, source, set_at) values (${marked}, ${o.id}, true, 'Asked to stop', 'human', '2026-10-02T10:00:00Z')`;

    void dbClient.db.$client;
    const select = vi.spyOn((globalThis as unknown as { __miasdrDb: typeof dbClient.db }).__miasdrDb, "select");
    let map;
    try {
      map = await reach.readReachability(o.id, [open, suppressed, marked, bare]);
      expect(select).toHaveBeenCalledTimes(1);
    } finally {
      select.mockRestore();
    }
    expect(map.get(open)).toEqual({ doNotContact: null, email: { state: "open", suppressionReason: null, since: null }, linkedin: { state: "open" } });
    expect(map.get(suppressed)).toEqual({
      doNotContact: null,
      email: { state: "suppressed", suppressionReason: "bounced", since: new Date("2026-10-01T10:00:00Z") },
      linkedin: { state: "open" },
    });
    expect(map.get(marked)).toMatchObject({ doNotContact: { reason: "Asked to stop", since: new Date("2026-10-02T10:00:00Z") }, email: { state: "open" }, linkedin: { state: "missing" } });
    expect(map.get(bare)).toMatchObject({ email: { state: "missing" }, linkedin: { state: "missing" } });
  });

  it("reads a cleared flag as reachable and never reads another organization", async () => {
    const mine = await org();
    const theirs = await org();
    const cleared = await person(mine.id, { email: `c-${mine.tag}@re.test` });
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, reason, source, set_at, cleared_at) values (${cleared}, ${mine.id}, false, 'x', 'human', now() - interval '1 day', now())`;
    const foreign = await person(theirs.id, { email: `f-${theirs.tag}@re.test` });
    // The same address suppressed in another organization does not suppress it here.
    await sql`insert into suppression_list (organization_id, email, reason) values (${theirs.id}, ${`c-${mine.tag}@re.test`}, 'manual')`;
    const map = await reach.readReachability(mine.id, [cleared, foreign]);
    expect(map.get(cleared)).toMatchObject({ doNotContact: null, email: { state: "open" } });
    expect(map.has(foreign)).toBe(false);
    expect((await reach.readReachability(mine.id, [])).size).toBe(0);
  });

  const inTx = <T>(fn: (tx: import("@/platform/db/client").DbTx) => Promise<T>) => dbClient.db.transaction(fn);

  it("keeps a marked person's address suppressed on delete and leaves an existing row as it is", async () => {
    const o = await org();
    const marked = await person(o.id, { email: `Marked-${o.tag}@Lead.test` });
    const already = await person(o.id, { email: `gone-${o.tag}@lead.test` });
    const free = await person(o.id, { email: `free-${o.tag}@lead.test` });
    const noEmail = await person(o.id, {});
    for (const id of [marked, already, noEmail]) {
      await sql`insert into contact_policies (person_id, organization_id, do_not_contact, reason, source, set_at) values (${id}, ${o.id}, true, 'Stop', 'human', now())`;
    }
    await sql`insert into suppression_list (organization_id, email, reason, note) values (${o.id}, ${`gone-${o.tag}@lead.test`}, 'unsubscribed', 'clicked')`;

    await inTx((tx) => reach.suppressDoNotContactAddressesTx(tx, o.id, [marked, already, free, noEmail]));
    const rows = await sql`select email, reason, note from suppression_list where organization_id = ${o.id} order by email`;
    expect(rows).toEqual([
      { email: `gone-${o.tag}@lead.test`, reason: "unsubscribed", note: "clicked" },
      { email: `marked-${o.tag}@lead.test`, reason: "manual", note: "Deleted while marked do not contact." },
    ]);
    expect(await reach.isSuppressed(dbClient.db, o.id, `MARKED-${o.tag}@lead.test `)).toBe(true);
    expect(await reach.isSuppressed(dbClient.db, o.id, `free-${o.tag}@lead.test`)).toBe(false);
    expect(await reach.isSuppressed(dbClient.db, o.id, null)).toBe(false);
  });

  it("sets and clears do not contact once each, reporting the policy before the call", async () => {
    const o = await org();
    const p = await person(o.id, { email: `p-${o.tag}@lead.test` });
    const write = (enabled: boolean, reason: string | null) => inTx((tx) => reach.writeDoNotContactTx(tx, { organizationId: o.id, personId: p, enabled, reason, now: new Date() }));

    expect(await write(false, null)).toEqual({ changed: false, previous: null });
    expect(await write(true, "Asked to stop")).toEqual({ changed: true, previous: null });
    expect(await write(true, "Again")).toEqual({ changed: false, previous: { doNotContact: true, reason: "Asked to stop" } });
    expect(await write(false, "Wrote back")).toEqual({ changed: true, previous: { doNotContact: true, reason: "Asked to stop" } });
    const [row] = await sql`select do_not_contact, reason, cleared_at is not null as cleared from contact_policies where person_id = ${p}`;
    expect(row).toEqual({ do_not_contact: false, reason: "Wrote back", cleared: true });
    // Another organization's id writes nothing there.
    const other = await org();
    expect(await inTx((tx) => reach.writeDoNotContactTx(tx, { organizationId: other.id, personId: p, enabled: false, reason: null, now: new Date() }))).toEqual({ changed: false, previous: null });
  });

  it("adds an address once in its stored form, and removes only a row pasted on Settings", async () => {
    const o = await org();
    expect(await inTx((tx) => reach.suppressAddressTx(tx, { organizationId: o.id, email: ` Pasted-${o.tag}@Lead.test `, reason: "manual", addedInSettings: true }))).toEqual({ email: `pasted-${o.tag}@lead.test`, added: true });
    expect(await inTx((tx) => reach.suppressAddressTx(tx, { organizationId: o.id, email: `pasted-${o.tag}@lead.test`, reason: "bounced" }))).toEqual({ email: `pasted-${o.tag}@lead.test`, added: false });
    await inTx((tx) => reach.suppressAddressTx(tx, { organizationId: o.id, email: `bounce-${o.tag}@lead.test`, reason: "bounced" }));
    const ids = await sql`select id, email from suppression_list where organization_id = ${o.id} order by email`;
    for (const { id } of ids) await reach.removeSettingsSuppression(dbClient.db, o.id, id);
    expect((await sql`select email, reason from suppression_list where organization_id = ${o.id}`).map((r) => r.email)).toEqual([`bounce-${o.tag}@lead.test`]);
  });
});
