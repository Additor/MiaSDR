import { afterAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql } from "../../../test-support/db";
import { seedWorld, type World } from "../../../test-support/full-world";

/**
 * `events`, `audit_log` and `messages` are append-only. Each test names the trigger it protects, so dropping the trigger
 * fails exactly that test. Needs TEST_DATABASE_URL.
 */

const APPEND_ONLY = /is append-only/;

describeDb("append-only tables", () => {
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

  it("events_no_update_trg: an update of an event raises", async () => {
    const w = await world();
    await expect(sql`update events set event_type = 'changed' where id = ${w.event}`).rejects.toThrow(APPEND_ONLY);
    await expect(sql`update events set meta = '{"a":1}'::jsonb where id = ${w.event}`).rejects.toMatchObject({ code: "23000" });
  });

  it("audit_log_no_update_trg: an update of an audit row raises", async () => {
    const w = await world();
    await expect(sql`update audit_log set action = 'changed' where id = ${w.audit}`).rejects.toThrow(APPEND_ONLY);
  });

  it("messages_immutable_trg: an update of message content raises, important and opened_at stay writable", async () => {
    const w = await world();
    await expect(sql`update messages set body_text = 'rewritten' where id = ${w.message}`).rejects.toThrow(APPEND_ONLY);
    await expect(sql`update messages set sent_at = now() - interval '1 day' where id = ${w.message}`).rejects.toThrow(APPEND_ONLY);
    await expect(sql`update messages set important = true, body_text = 'x' where id = ${w.message}`).rejects.toThrow(APPEND_ONLY);
    await sql`update messages set important = true where id = ${w.message}`;
    await sql`update messages set opened_at = now() where id = ${w.message}`;
    const [m] = await sql`select important, opened_at from messages where id = ${w.message}`;
    expect(m.important).toBe(true);
    expect(m.opened_at).not.toBeNull();
  });

  it("events_no_delete_trg: a direct delete of an event raises", async () => {
    const w = await world();
    await expect(sql`delete from events where id = ${w.event}`).rejects.toThrow(APPEND_ONLY);
    expect((await sql`select 1 from events where id = ${w.event}`).length).toBe(1);
  });

  it("audit_log_no_delete_trg: a direct delete of an audit row raises", async () => {
    const w = await world();
    await expect(sql`delete from audit_log where organization_id = ${w.org}`).rejects.toThrow(APPEND_ONLY);
    expect((await sql`select 1 from audit_log where id = ${w.audit}`).length).toBe(1);
  });

  it("messages_no_delete_trg: a direct delete of a message raises", async () => {
    const w = await world();
    const orphan = (
      await sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
                values (${w.org}, ${w.conversation}, 'email', ${"me@" + w.tag + ".test"}, 'outbound', ${"o-" + w.tag}, 'bye', now()) returning id`
    )[0].id;
    await expect(sql`delete from messages where id = ${orphan}`).rejects.toThrow(APPEND_ONLY);
  });

  it("an organization delete cascades through all three tables", async () => {
    const w = await seedWorld(sql);
    await sql`delete from organizations where id = ${w.org}`;
    for (const t of ["events", "audit_log", "messages"]) {
      const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${t} where organization_id = '${w.org}'`);
      expect(n, t).toBe(0);
    }
    await sql`delete from users where id = ${w.user}`;
  });

  it("ledger_reject_update: a user delete nulls actor_user_id on events and audit_log", async () => {
    const w = await world();
    // events_human_user_ck forbids a human event without a user, so use a system event that names one.
    const sys = (
      await sql`insert into events (organization_id, person_id, event_type, actor_type, actor_user_id) values (${w.org}, ${w.person}, 'note', 'system', ${w.user}) returning id`
    )[0].id;
    await sql.begin(async (tx) => {
      await tx`select set_config('miasdr.allow_purge', 'on', true)`;
      await tx`delete from events where id = ${w.event}`;
    });
    await sql`delete from send_attempts where id = ${w.sendAttempt}`; // actor_user_id is ON DELETE RESTRICT there
    await sql`delete from users where id = ${w.user}`;
    const [e] = await sql`select actor_user_id, event_type from events where id = ${sys}`;
    const [a] = await sql`select actor_user_id, action from audit_log where id = ${w.audit}`;
    expect(e).toMatchObject({ actor_user_id: null, event_type: "note" });
    expect(a).toMatchObject({ actor_user_id: null, action: "test.action" });
  });

  it("ledger_reject_update: only the foreign key action may null actor_user_id", async () => {
    const w = await world();
    await expect(sql`update events set actor_user_id = null where id = ${w.event}`).rejects.toThrow(APPEND_ONLY);
    await expect(sql`update audit_log set actor_user_id = null where id = ${w.audit}`).rejects.toThrow(APPEND_ONLY);
  });

  it("ledger_reject_delete: the purge setting lets a delete through in its transaction only", async () => {
    const w = await world();
    await sql.begin(async (tx) => {
      await tx`select set_config('miasdr.allow_purge', 'on', true)`;
      await tx`delete from events where id = ${w.event}`;
      await tx`delete from audit_log where id = ${w.audit}`;
    });
    expect((await sql`select 1 from events where id = ${w.event}`).length).toBe(0);
    expect((await sql`select 1 from audit_log where id = ${w.audit}`).length).toBe(0);
    const [{ v }] = await sql`select current_setting('miasdr.allow_purge', true) as v`;
    expect(v === null || v === "" || v === "off").toBe(true);
    const e2 = (await sql`insert into events (organization_id, person_id, event_type, actor_type) values (${w.org}, ${w.person}, 'again', 'system') returning id`)[0].id;
    await expect(sql`delete from events where id = ${e2}`).rejects.toThrow(APPEND_ONLY);
  });

  it("ledger_reject_delete: the setting off still raises", async () => {
    const w = await world();
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('miasdr.allow_purge', 'off', true)`;
        await tx`delete from events where id = ${w.event}`;
      }),
    ).rejects.toThrow(APPEND_ONLY);
  });

  it("lists the six triggers by name", async () => {
    const rows = await sql`select tgname from pg_trigger where not tgisinternal and tgname ~ '^(events|audit_log|messages)_(no_update|no_delete|immutable)_trg$'`;
    expect(rows.map((r) => r.tgname).sort()).toEqual([
      "audit_log_no_delete_trg",
      "audit_log_no_update_trg",
      "events_no_delete_trg",
      "events_no_update_trg",
      "messages_immutable_trg",
      "messages_no_delete_trg",
    ]);
  });
});
