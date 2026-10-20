import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";
import type { GridDeps } from "../../application/ports";
import type { Actor } from "@/shared/errors";

/** Column and tab positions after many inserts at one spot. */
describeDb("positions stay distinct and ordered", () => {
  const sql = testSql({ max: 6 });
  useTestEnv();
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let m: {
    providers: typeof import("../../application/enrichment-providers");
    columns: typeof import("../../application/enrichment-columns");
    adapters: typeof import("../enrichment-adapters");
    pstore: typeof import("../enrichment-provider-store");
    rstore: typeof import("../enrichment-run-store");
    crypto: typeof import("@/contexts/integrations/infrastructure/credential-crypto");
  };

  async function org() {
    const { organizationId: id, actor } = await gridOrg(sql, orgs, "owner");
    return { id, actor };
  }

  async function table(actor: Actor) {
    const { workbook, table: t } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    return { workbook, table: t };
  }

  const columnOrder = async (tableId: string) => (await sql`select key, position from grid_columns where table_id = ${tableId} order by position, id`).map((r) => ({ key: r.key as string, position: Number(r.position) }));
  const tabOrder = async (workbookId: string) => (await sql`select id, name, position from grid_tables where workbook_id = ${workbookId} order by position, id`).map((r) => ({ id: r.id as string, name: r.name as string, position: Number(r.position) }));
  const distinct = (items: Array<{ position: number }>) => new Set(items.map((i) => i.position)).size === items.length;

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    m = {
      providers: await import("../../application/enrichment-providers"),
      columns: await import("../../application/enrichment-columns"),
      adapters: await import("../enrichment-adapters"),
      pstore: await import("../enrichment-provider-store"),
      rstore: await import("../enrichment-run-store"),
      crypto: await import("@/contexts/integrations/infrastructure/credential-crypto"),
    };
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("inserts 60 columns after one column without ties, newest first", async () => {
    const { actor } = await org();
    const { table: t } = await table(actor);
    const first = (await columnsUc.listColumns(deps, actor, t.id)).columns[0];
    const { column: last } = await columnsUc.createColumn(deps, actor, t.id, { name: "Last", type: "text" });
    const names: string[] = [];
    for (let n = 0; n < 60; n += 1) {
      const { column } = await columnsUc.createColumn(deps, actor, t.id, { name: `C${n}`, type: "text", afterColumnId: first.id });
      names.push(column.key);
    }
    const order = await columnOrder(t.id);
    expect(distinct(order)).toBe(true);
    expect(order.map((c) => c.key)).toEqual([first.key, ...names.reverse(), last.key]);
  });

  it("moves a column left and right after the gap has been squeezed", async () => {
    const { actor } = await org();
    const { table: t } = await table(actor);
    const first = (await columnsUc.listColumns(deps, actor, t.id)).columns[0];
    for (let n = 0; n < 55; n += 1) await columnsUc.createColumn(deps, actor, t.id, { name: `C${n}`, type: "text", afterColumnId: first.id });
    const before = (await columnOrder(t.id)).map((c) => c.key);
    const cols = (await columnsUc.listColumns(deps, actor, t.id)).columns;
    const byKey = new Map(cols.map((c) => [c.key, c]));
    // Move the column at index 3 to sit after the column at index 1, then back after the one that was index 2.
    const moving = byKey.get(before[3])!;
    await columnsUc.updateColumn(deps, actor, t.id, moving.id, { afterColumnId: byKey.get(before[1])!.id });
    let order = await columnOrder(t.id);
    expect(distinct(order)).toBe(true);
    expect(order.map((c) => c.key).slice(0, 4)).toEqual([before[0], before[1], before[3], before[2]]);
    await columnsUc.updateColumn(deps, actor, t.id, moving.id, { afterColumnId: null });
    order = await columnOrder(t.id);
    expect(order[0].key).toBe(before[3]);
    expect(distinct(order)).toBe(true);
  });

  it("takes turns under the table lock when 12 inserts land at the same anchor", async () => {
    const { actor } = await org();
    const { table: t } = await table(actor);
    const first = (await columnsUc.listColumns(deps, actor, t.id)).columns[0];
    for (let n = 0; n < 48; n += 1) await columnsUc.createColumn(deps, actor, t.id, { name: `Seed${n}`, type: "text", afterColumnId: first.id });
    const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => columnsUc.createColumn(deps, actor, t.id, { name: `Race${n}`, type: "text", afterColumnId: first.id })));
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    const order = await columnOrder(t.id);
    expect(order).toHaveLength(1 + 48 + 12);
    expect(distinct(order)).toBe(true);
    expect(new Set(order.map((c) => c.key)).size).toBe(order.length);
    // The 12 racers all sit directly after the anchor, ahead of every seed column.
    expect(order.slice(1, 13).every((c) => c.key.startsWith("race"))).toBe(true);
  });

  it("copies one tab 60 times and keeps the tabs distinct, each copy next to its original", async () => {
    const { actor } = await org();
    const { workbook, table: t } = await table(actor);
    const copies: string[] = [];
    for (let n = 0; n < 60; n += 1) {
      const { table: copy } = await structure.duplicateTable(deps, actor, t.id);
      copies.push(copy.id);
    }
    const tabs = await tabOrder(workbook.id);
    expect(tabs).toHaveLength(61);
    expect(distinct(tabs)).toBe(true);
    expect(tabs.map((tab) => tab.id)).toEqual([t.id, ...copies.reverse()]);
  });

  it("copies a tab concurrently without a tie", async () => {
    const { actor } = await org();
    const { workbook, table: t } = await table(actor);
    for (let n = 0; n < 50; n += 1) await structure.duplicateTable(deps, actor, t.id);
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => structure.duplicateTable(deps, actor, t.id)));
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    const tabs = await tabOrder(workbook.id);
    expect(tabs).toHaveLength(59);
    expect(distinct(tabs)).toBe(true);
    expect(tabs[0].id).toBe(t.id);
  });

  it("lets enrichment columns land after a renumber without a tie", async () => {
    // layout() in enrichment-columns.ts (G3) reads the columns outside the table lock. After 60 inserts
    // squeezed the gap and renumbered the table, it must still place its three columns in order.
    const { actor } = await org();
    const { table: t } = await table(actor);
    const secret = "x".repeat(40);
    const adapters = m.adapters.createAdapterRegistry({ policy: { allowedHosts: [] }, net: { resolve: async () => ["93.184.216.34"] }, fake: new m.adapters.FakeEnrichmentProvider() });
    const cipher = { encrypt: (p: string) => m.crypto.encryptCredential(p, secret), decrypt: (e: string) => m.crypto.decryptCredential(e, secret) };
    await m.providers.createProvider({ providers: m.pstore.drizzleProviderStore, cipher, adapters, urlPolicy: { allowedHosts: [] }, allowFake: true }, actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" } });

    const cols = (await columnsUc.listColumns(deps, actor, t.id)).columns;
    const anchor = cols[0];
    await columnsUc.createColumn(deps, actor, t.id, { name: "Domain", type: "text" });
    for (let n = 0; n < 60; n += 1) await columnsUc.createColumn(deps, actor, t.id, { name: `Fill${n}`, type: "text", afterColumnId: anchor.id });
    const created = await m.columns.createEnrichmentColumns(
      { store: m.rstore.drizzleGridRunStore, providers: m.pstore.drizzleProviderStore, adapters },
      actor,
      t.id,
      { providerKey: "fake", actionKey: "find-email", inputs: { fullName: anchor.key, companyDomain: "domain" }, selectedOutputs: ["email"], afterColumnId: anchor.id },
    );
    const order = await columnOrder(t.id);
    expect(distinct(order)).toBe(true);
    expect(order.slice(1, 1 + created.length).map((c) => c.key)).toEqual(created.map((c) => c.key));
    expect(order[0].key).toBe(anchor.key);
  });
});
