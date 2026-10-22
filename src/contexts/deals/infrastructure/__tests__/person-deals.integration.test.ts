import { afterAll, beforeAll, expect, it } from "vitest";
import { bootDealsKit, sqlState, type DealsKit, type DealsOrg } from "../../../../test-support/deals-test-kit";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * The deals side of a contact delete ("Contacts and Companies CRUD" in docs/decisions.md): the person's
 * deals locked with their stages, won and lost counts with titles at 3 or fewer, and the closed deals deleted with the open
 * ones and other people's deals left. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("person deals", () => {
  let kit: DealsKit;
  let deals: typeof import("../../application/deals");
  let composition: typeof import("@/composition/deals");
  let personDeals: typeof import("../person-deals");
  let dbClient: typeof import("@/platform/db/client");

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    deals = await import("../../application/deals");
    composition = await import("@/composition/deals");
    personDeals = await import("../person-deals");
    dbClient = await import("@/platform/db/client");
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  let n = 0;
  /** A contact with one deal per entry, closed in that order, an hour apart. */
  async function contactWith(f: DealsOrg, kinds: Array<"open" | "won" | "lost">) {
    const personId = await f.person({ contact: true });
    const stages = await dbClient.db.transaction((tx) => composition.dealsDeps().store.ensureStages(tx, f.org));
    const ids: string[] = [];
    for (const [index, kind] of kinds.entries()) {
      const { dealId } = await deals.createDealForContact(composition.dealsDeps(), f.owner, personId, { title: `${kind} ${index}`, idempotencyKey: `person-deals-${++n}` });
      const target = stages.find((s) => s.kind === kind)!;
      const at = new Date(Date.UTC(2026, 9, 1, index));
      if (kind !== "open") await deals.moveDealStage(composition.dealsDeps({ now: () => at }), f.owner, dealId, { stageId: target.id, expectedVersion: 0, lostReason: kind === "lost" ? "Budget" : undefined });
      ids.push(dealId);
    }
    return { personId, ids, stages };
  }

  const inTx = <T>(fn: (tx: Parameters<Parameters<typeof dbClient.db.transaction>[0]>[0]) => Promise<T>) => dbClient.db.transaction(fn);

  it("locks every deal of the person in id order with its stage, and holds them until commit", async () => {
    const f = await kit.organization();
    const { personId, ids, stages } = await contactWith(f, ["open", "won"]);
    const other = await contactWith(f, ["open"]);
    let probe: string | undefined;
    const locked = await inTx(async (tx) => {
      const rows = await personDeals.lockDealsOfPerson(tx, f.org, personId);
      probe = await kit.sql`select id from deals where id = ${ids[0]} for update nowait`.then(() => "free", (error: unknown) => sqlState(error));
      // Another person's deal stays free.
      await kit.sql`select id from deals where id = ${other.ids[0]} for update nowait`;
      return rows;
    });
    expect(probe).toBe("55P03");
    const open = stages.find((s) => s.kind === "open")!;
    const won = stages.find((s) => s.kind === "won")!;
    expect(locked).toEqual(
      [
        { id: ids[0], title: "open 0", stageName: open.name, stageKind: "open" },
        { id: ids[1], title: "won 1", stageName: won.name, stageKind: "won" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const outsider = await kit.organization();
    expect(await inTx((tx) => personDeals.lockDealsOfPerson(tx, outsider.org, personId))).toEqual([]);
  });

  it("counts won and lost deals and names won deals at 3 or fewer, newest close first", async () => {
    const f = await kit.organization();
    const three = await contactWith(f, ["won", "lost", "won", "open", "won"]);
    expect(await inTx((tx) => personDeals.dealCountsOfPerson(tx, f.org, three.personId))).toEqual({ won: 3, lost: 1, wonTitles: ["won 4", "won 2", "won 0"] });
    const four = await contactWith(f, ["won", "won", "won", "won"]);
    expect(await inTx((tx) => personDeals.dealCountsOfPerson(tx, f.org, four.personId))).toEqual({ won: 4, lost: 0, wonTitles: [] });
    const none = await f.person({ contact: true });
    expect(await inTx((tx) => personDeals.dealCountsOfPerson(tx, f.org, none))).toEqual({ won: 0, lost: 0, wonTitles: [] });
  });

  it("deletes the closed deals only, and no deal of another person or organization", async () => {
    const f = await kit.organization();
    const target = await contactWith(f, ["won", "lost", "open"]);
    const neighbour = await contactWith(f, ["won"]);
    const elsewhere = await kit.organization();
    const foreign = await contactWith(elsewhere, ["lost"]);
    expect(await inTx((tx) => personDeals.deleteClosedDealsOfPerson(tx, f.org, target.personId))).toEqual({ deleted: 2 });
    expect((await kit.sql`select id from deals where person_id = ${target.personId}`).map((r) => r.id)).toEqual([target.ids[2]]);
    expect(await kit.count("deals", f.org, `person_id = '${neighbour.personId}'`)).toBe(1);
    expect(await kit.count("deals", elsewhere.org, `person_id = '${foreign.personId}'`)).toBe(1);
    // The wrong organization deletes nothing.
    expect(await inTx((tx) => personDeals.deleteClosedDealsOfPerson(tx, elsewhere.org, neighbour.personId))).toEqual({ deleted: 0 });
  });

  it("reads a new contact's title parts inside the transaction", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    const named = await f.person({ name: "Ada", companyId: acme, contact: true });
    const bare = await f.person({ name: null, email: `bare-${f.tag}@acme.test`, contact: true });
    expect(await inTx((tx) => personDeals.dealTitleParts(tx, f.org, named))).toEqual({ name: "Ada", companyName: "Acme" });
    expect(await inTx((tx) => personDeals.dealTitleParts(tx, f.org, bare))).toEqual({ name: `bare-${f.tag}@acme.test`, companyName: null });
    expect(await inTx((tx) => personDeals.dealTitleParts(tx, f.org, "00000000-0000-4000-8000-000000000000"))).toBeNull();
  });
});
