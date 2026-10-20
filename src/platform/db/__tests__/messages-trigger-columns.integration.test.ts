import { afterAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql } from "../../../test-support/db";
import { seedWorld, type World } from "../../../test-support/full-world";

/**
 * Migration 0018: messages_reject_immutable_update compares the columns of messages one by one with
 * IS DISTINCT FROM instead of serializing both rows to jsonb. That makes a column added later invisible to the trigger
 * until someone adds it to the function. The guard test lists information_schema.columns and fails for any column that is
 * neither compared in the function definition nor named in WRITABLE below. Needs TEST_DATABASE_URL.
 */
/** Columns the application updates after insert (setMessageImportant, markRead). Everything else must be compared. */
const WRITABLE = ["important", "opened_at"];

const FUNCTION = "messages_reject_immutable_update";

describeDb("messages_reject_immutable_update column coverage (0018)", () => {
  const sql = testSql();
  const worlds: World[] = [];
  const world = async () => {
    const w = await seedWorld(sql);
    worlds.push(w);
    return w;
  };
  afterAll(async () => {
    await dropOrgs(sql, worlds.map((w) => ({ organizationId: w.org, userId: w.user })));
    await sql.end();
  });

  async function definition(): Promise<string> {
    const [row] = await sql`select pg_get_functiondef(oid) as def from pg_proc where proname = ${FUNCTION}`;
    return row.def as string;
  }
  async function columns(): Promise<string[]> {
    const rows = await sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'messages' order by ordinal_position`;
    return rows.map((r) => r.column_name as string);
  }
  const compares = (def: string, column: string) => new RegExp(`NEW\\.${column}\\s+IS DISTINCT FROM\\s+OLD\\.${column}\\b`).test(def.replace(/"/g, ""));

  it("compares every column of messages except the writable ones", async () => {
    const def = await definition();
    const missing = (await columns()).filter((c) => !WRITABLE.includes(c) && !compares(def, c));
    expect(missing, `add these messages columns to ${FUNCTION} (new migration) or to WRITABLE in this test`).toEqual([]);
  });

  it("does not compare the writable columns", async () => {
    const def = await definition();
    for (const c of WRITABLE) expect(compares(def, c), c).toBe(false);
    expect(await columns()).toEqual(expect.arrayContaining(WRITABLE));
  });

  it("the guard fails for a column added to messages and not compared", async () => {
    // Rolled back: the scratch column exists only inside this transaction.
    const found = await sql
      .begin(async (tx) => {
        await tx`alter table messages add column zz_scratch text`;
        const cols = (await tx`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'messages'`).map((r) => r.column_name as string);
        const [row] = await tx`select pg_get_functiondef(oid) as def from pg_proc where proname = ${FUNCTION}`;
        const missing = cols.filter((c) => !WRITABLE.includes(c) && !compares(row.def as string, c));
        throw Object.assign(new Error("rollback"), { missing });
      })
      .catch((e: { missing?: string[] }) => e.missing);
    expect(found).toEqual(["zz_scratch"]);
  });

  describe("behavior", () => {
    it("allows important and opened_at, with or without a changed value", async () => {
      const w = await world();
      await sql`update messages set important = true where id = ${w.message}`;
      await sql`update messages set opened_at = now() where id = ${w.message}`;
      await sql`update messages set important = false, opened_at = null where id = ${w.message}`;
      await sql`update messages set body_text = body_text, subject = subject, raw = raw where id = ${w.message}`;
    });

    it.each([
      ["conversation_id", `uuid '00000000-0000-4000-8000-000000000001'`],
      ["channel", `'linkedin'`],
      ["account_ref", `'other'`],
      ["direction", `'outbound'`],
      ["idempotency_key", `'changed'`],
      ["provider_message_id", `'pm-1'`],
      ["subject", `'changed'`],
      ["from_address", `'a@b.test'`],
      ["to_address", `'a@b.test'`],
      ["cc", `array['a@b.test']`],
      ["body_text", `'rewritten'`],
      ["body_html", `'<p>x</p>'`],
      ["raw", `'{"a":1}'::jsonb`],
      ["sent_at", `now() - interval '1 day'`],
      ["created_at", `now() - interval '1 day'`],
    ])("raises when %s changes", async (column, value) => {
      const w = await world();
      await expect(sql.unsafe(`update messages set ${column} = ${value} where id = '${w.message}'`)).rejects.toThrow(/messages is append-only: only important and opened_at can change/);
    });

    it("raises when a NULL column becomes a value and when a value becomes NULL", async () => {
      const w = await world();
      await expect(sql`update messages set subject = 'now set' where id = ${w.message}`).rejects.toMatchObject({ code: "23000" });
      await expect(sql`update messages set idempotency_key = null where id = ${w.message}`).rejects.toMatchObject({ code: "23000" });
    });
  });
});
