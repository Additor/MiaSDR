import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as script from "../../../../scripts/migrate.mjs";
import { describeDb, TEST_DATABASE_URL } from "../../../test-support/db";
import { adminAndScratchUrls, folderUpTo } from "../../../test-support/migration-test-kit";

/**
 * 0002_rename_reply_types renames the reply taxonomy and rewrites the stored events that name it. A scratch database at
 * 0001 gets a record, a pick and the events the app wrote before the rename; the test applies 0002 and reads them back.
 * Needs TEST_DATABASE_URL. Builds and drops its own scratch database.
 */
describeDb("0002_rename_reply_types on existing rows", () => {
  const name = `miasdr_rename_reply_types_${Math.random().toString(36).slice(2, 8)}`;
  const { admin, scratch } = adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x@localhost/x", name);
  const adminSql = postgres(admin, { max: 1, onnotice: () => undefined });
  const env = { DATABASE_URL: scratch, DATABASE_SSL: "disable" };
  const migrate = async (folder: string) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await script.main(env, folder)).toBe(0);
    } finally {
      log.mockRestore();
    }
  };
  let sql: postgres.Sql;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await adminSql.unsafe(`create database ${name}`);
    await migrate(folderUpTo(mkdtempSync(path.join(tmpdir(), "miasdr-0002-")), 1));
    sql = postgres(scratch, { max: 1, onnotice: () => undefined });
    const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id;
    const org = (ids.org = await one(sql`insert into organizations (name, slug) values ('R', 'r-0002') returning id`));
    const user = await one(sql`insert into users (name, email) values ('U', 'u@0002.test') returning id`);
    const person = await one(sql`insert into people (organization_id, email, full_name) values (${org}, 'lead@0002.test', 'Lead') returning id`);
    const set = await one(sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'p', true) returning id`);
    ids.type = await one(sql`insert into subcategories (organization_id, pipeline_id, category_key, key, name) values (${org}, ${set}, 'interested', 'a', 'A') returning id`);
    const record = (ids.record = await one(sql`
      insert into records (organization_id, person_id, pipeline_id, category_key, subcategory_id, category_source, category_locked)
      values (${org}, ${person}, ${set}, 'interested', ${ids.type}, 'human', false) returning id`));
    const conversation = await one(sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${org}, ${record}, 'email', 'me@0002.test') returning id`);
    const message = await one(sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${org}, ${conversation}, 'email', 'me@0002.test', 'inbound', 'm-0002', 'hello', now()) returning id`);
    ids.pick = await one(sql`
      insert into classifications (organization_id, record_id, message_id, expected_context_version, status, confidence, applied_category_key, applied_subcategory_id)
      values (${org}, ${record}, ${message}, 0, 'auto_applied', 0.9, 'interested', ${ids.type}) returning id`);
    const event = (type: string, from: unknown, to: unknown, meta: unknown) =>
      sql`insert into events (organization_id, person_id, record_id, event_type, actor_type, actor_user_id, from_data, to_data, meta)
        values (${org}, ${person}, ${record}, ${type}, 'human', ${user}, ${sql.json(from as never)}, ${sql.json(to as never)}, ${sql.json(meta as never)})`;
    await event(
      "stage.moved",
      { categoryKey: null, subcategoryId: null, categorySource: null, categoryLocked: false },
      { categoryKey: "interested", subcategoryId: ids.type, categorySource: "human", categoryLocked: false },
      { note: "Call went well", unlockedCustomer: false },
    );
    await event("classification.undone", { categoryKey: "interested", subcategoryId: ids.type }, { categoryKey: null, subcategoryId: null }, { classificationId: ids.pick });
    await event("classification.acknowledged", null, null, { classificationId: ids.pick });
    await event("deal.stage_moved", { categoryKey: "kept" }, null, { classificationId: "kept" });
    await sql.end();
    await migrate(path.join(process.cwd(), "drizzle"));
    sql = postgres(scratch, { max: 1, onnotice: () => undefined });
  });
  afterAll(async () => {
    await sql?.end();
    await adminSql.unsafe(`drop database if exists ${name} with (force)`);
    await adminSql.end();
  });

  it("keeps the record, its reply type and the pick under the new names", async () => {
    const [record] = await sql`select group_key, reply_type_id, reply_type_source, reply_type_locked from records where id = ${ids.record}`;
    expect(record).toEqual({ group_key: "interested", reply_type_id: ids.type, reply_type_source: "human", reply_type_locked: false });
    const [pick] = await sql`select applied_group_key, applied_reply_type_id from reply_type_picks where id = ${ids.pick}`;
    expect(pick).toEqual({ applied_group_key: "interested", applied_reply_type_id: ids.type });
    const [type] = await sql`select group_key, key from reply_types where id = ${ids.type}`;
    expect(type).toEqual({ group_key: "interested", key: "a" });
  });

  it("renames the stored event types and their JSON keys, and leaves other events alone", async () => {
    const rows = await sql`select event_type, from_data, to_data, meta from events where organization_id = ${ids.org} order by event_type`;
    expect(rows).toEqual([
      { event_type: "deal.stage_moved", from_data: { categoryKey: "kept" }, to_data: null, meta: { classificationId: "kept" } },
      {
        event_type: "reply_type.changed",
        from_data: { groupKey: null, replyTypeId: null, replyTypeSource: null, replyTypeLocked: false },
        to_data: { groupKey: "interested", replyTypeId: ids.type, replyTypeSource: "human", replyTypeLocked: false },
        meta: { note: "Call went well", unlockedCustomer: false },
      },
      { event_type: "reply_type_pick.acknowledged", from_data: null, to_data: null, meta: { replyTypePickId: ids.pick } },
      {
        event_type: "reply_type_pick.undone",
        from_data: { groupKey: "interested", replyTypeId: ids.type },
        to_data: { groupKey: null, replyTypeId: null },
        meta: { replyTypePickId: ids.pick },
      },
    ]);
  });

  it("turns the append-only guard on events back on", async () => {
    await expect(sql`update events set meta = '{}' where organization_id = ${ids.org}`).rejects.toThrow(/events is append-only/);
  });

  it("keeps the renamed validators attached to the renamed tables", async () => {
    await expect(sql`update reply_types set key = 'b' where id = ${ids.type}`).rejects.toThrow(/reply_types keys are immutable/);
    await expect(sql`update reply_type_picks set applied_group_key = 'customer' where id = ${ids.pick}`).rejects.toThrow(
      /reply_type_picks\.applied_reply_type_id must belong to the record's reply type set/,
    );
  });
});
