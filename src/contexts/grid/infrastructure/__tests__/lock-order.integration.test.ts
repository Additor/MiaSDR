import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, TEST_DATABASE_URL, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";

/**
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres. Lock order of the grid writers: workbooks (in id order), then
 * the table, then rows, then columns. A writer that takes them in another order can deadlock with the others (40P01).
 */
describeDb("grid lock order", () => {
  const sql = testSql({ max: 12 });
  const orgs: TestOrg[] = [];
  let structure: typeof import("../drizzle-structure-store").drizzleStructureStore;
  let rowStore: typeof import("../drizzle-row-store").drizzleRowStore;

  async function org() {
    const created = await createTestOrg(sql, "L");
    orgs.push(created);
    return created.organizationId;
  }
  async function workbook(organizationId: string, tables: number) {
    const [{ id }] = await sql`insert into grid_workbooks (organization_id, name) values (${organizationId}, 'wb') returning id`;
    const ids: string[] = [];
    for (let i = 0; i < tables; i += 1) {
      const [t] = await sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${organizationId}, ${id}, ${"t" + i}, ${i + 1}) returning id`;
      ids.push(t.id);
    }
    return { id: id as string, tables: ids };
  }
  const deadlock = (reason: unknown) => {
    const e = reason as { code?: string; cause?: { code?: string } };
    return e?.code === "40P01" || e?.cause?.code === "40P01";
  };

  useTestEnv();
  beforeAll(async () => {
    structure = (await import("../drizzle-structure-store")).drizzleStructureStore;
    rowStore = (await import("../drizzle-row-store")).drizzleRowStore;
  });
  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("never deadlocks when tables are moved, deleted, reordered and duplicated at the same time", async () => {
    const organizationId = await org();
    for (let round = 0; round < 25; round += 1) {
      const a = await workbook(organizationId, 4);
      const b = await workbook(organizationId, 4);
      const jobs = [
        structure.moveTable(organizationId, a.tables[0], b.id, 50),
        structure.moveTable(organizationId, b.tables[0], a.id, 50),
        structure.moveTable(organizationId, a.tables[1], b.id, 50),
        structure.moveTable(organizationId, b.tables[1], a.id, 50),
        structure.deleteTable(organizationId, a.tables[2]),
        structure.deleteTable(organizationId, b.tables[2]),
        structure.reorderTables(organizationId, a.id, [a.tables[3], a.tables[2], a.tables[1], a.tables[0]]),
        structure.reorderTables(organizationId, b.id, [b.tables[3], b.tables[2], b.tables[1], b.tables[0]]),
        structure.duplicateTable(organizationId, a.tables[3], 50),
        structure.duplicateTable(organizationId, b.tables[3], 50),
      ];
      const settled = await Promise.allSettled(jobs);
      const deadlocked = settled.filter((r) => r.status === "rejected" && deadlock(r.reason));
      expect(deadlocked, `round ${round}`).toEqual([]);
    }
  });

  /** Holds the row lock of one table on a separate connection until `release` is called. */
  async function holdTable(tableId: string) {
    const blocker = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const holder = blocker.begin(async (tx) => {
      await tx`select id from grid_tables where id = ${tableId} for update`;
      locked();
      await held;
    });
    await ready;
    return {
      async release() {
        release();
        await holder;
        await blocker.end();
      },
    };
  }

  it("moveTable takes both workbook locks before it waits for the table lock", async () => {
    const organizationId = await org();
    const a = await workbook(organizationId, 2);
    const b = await workbook(organizationId, 2);
    const hold = await holdTable(a.tables[0]);
    const move = structure.moveTable(organizationId, a.tables[0], b.id, 50);
    await waitForLockWaiters(sql);
    // skip locked returns only the workbook rows nobody holds. A move that locked the table first holds neither.
    const free = await sql`select id from grid_workbooks where id = any(${[a.id, b.id]}) for update skip locked`;
    await hold.release();
    await move;
    expect(free).toHaveLength(0);
  });

  it("deleteDuplicates waits for the table lock before it locks the column or the rows", async () => {
    const organizationId = await org();
    const wb = await workbook(organizationId, 1);
    const tableId = wb.tables[0];
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${organizationId}, ${tableId}, 'name', 'name', 'text', 1)`;
    const [{ id: columnId }] = await sql`select id from grid_columns where table_id = ${tableId}`;
    await sql`insert into grid_rows (organization_id, table_id, position, cells) values (${organizationId}, ${tableId}, 1, '{"name":"a"}'::jsonb), (${organizationId}, ${tableId}, 2, '{"name":"a"}'::jsonb)`;
    const hold = await holdTable(tableId);
    const run = rowStore.deleteDuplicates(organizationId, tableId, columnId, (rows) => rows.slice(1).map((r) => r.id));
    await waitForLockWaiters(sql);
    // While it waits on the table, skip locked still sees the column and both rows: it has locked neither.
    const freeColumns = await sql`select id from grid_columns where id = ${columnId} for update skip locked`;
    const freeRows = await sql`select id from grid_rows where table_id = ${tableId} for update skip locked`;
    await hold.release();
    expect(await run).toHaveLength(1);
    expect(freeColumns).toHaveLength(1);
    expect(freeRows).toHaveLength(2);
  });
});
