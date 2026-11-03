import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as script from "../../../../scripts/migrate.mjs";
import { describeDb, TEST_DATABASE_URL } from "../../../test-support/db";
import { adminAndScratchUrls, folderUpTo, readJournal } from "../../../test-support/migration-test-kit";

/**
 * 0016 moves "a person reviewed this stop request" off the pick's status. A settled pick counts as reviewed, as the send gate
 * read it, unless an agent's call settled it: that reply goes back in front of a person.
 */
describeDb("0016_stop_reviews on existing rows", () => {
  const name = `miasdr_stop_reviews_${Math.random().toString(36).slice(2, 8)}`;
  const { admin, scratch } = adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x@localhost/x", name);
  const adminSql = postgres(admin, { max: 1, onnotice: () => undefined });
  const env = { DATABASE_URL: scratch, DATABASE_SSL: "disable" };
  const migrate = async (folder: string) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      return await script.main(env, folder);
    } finally {
      log.mockRestore();
    }
  };
  let sql: postgres.Sql;
  const replies: Record<string, string> = {};

  beforeAll(async () => {
    await adminSql.unsafe(`create database ${name}`);
    const before = readJournal().entries.find((entry) => entry.tag === "0016_stop_reviews")!.idx - 1;
    expect(await migrate(folderUpTo(mkdtempSync(path.join(tmpdir(), "miasdr-0016-")), before))).toBe(0);
    sql = postgres(scratch, { max: 1, onnotice: () => undefined });
    const [{ id: org }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values ('o-0016', 'o-0016') returning id`;
    const [{ id: set }] = await sql<{ id: string }[]>`insert into reply_type_sets (organization_id, name) values (${org}, 'Default') returning id`;

    const seed = async (label: string, status: string, options: { asks?: boolean; agentEvent?: string; acknowledged?: boolean } = {}) => {
      const [{ id: person }] = await sql<{ id: string }[]>`insert into people (organization_id, email) values (${org}, ${`${label}@acme.test`}) returning id`;
      const [{ id: record }] = await sql<{ id: string }[]>`insert into records (organization_id, person_id, reply_type_set_id) values (${org}, ${person}, ${set}) returning id`;
      const [{ id: conversation }] = await sql<{ id: string }[]>`insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id) values (${org}, ${record}, 'email', 'a@corp.test', ${label}) returning id`;
      const [{ id: message }] = await sql<{ id: string }[]>`
        insert into messages (organization_id, conversation_id, channel, account_ref, idempotency_key, direction, body_text, sent_at) values (${org}, ${conversation}, 'email', 'a@corp.test', ${label}, 'inbound', 'Hello', now()) returning id`;
      await sql`insert into reply_type_picks (organization_id, record_id, message_id, status, confidence, response, expected_context_version, acknowledged_at)
        values (${org}, ${record}, ${message}, ${status}, 0.9, ${sql.json({ stopRequested: options.asks !== false })}, 0, ${options.acknowledged ? new Date() : null})`;
      if (options.agentEvent) await sql`insert into events (organization_id, person_id, record_id, event_type, actor_type, actor_user_id, meta) values (${org}, ${person}, ${record}, ${options.agentEvent}, 'system', null, ${sql.json({ via: { tokenId: "t", tokenName: "Bot" } })})`;
      replies[label] = message;
    };
    await seed("held", "proposed");
    await seed("unchecked", "auto_applied");
    await seed("seen", "auto_applied", { acknowledged: true });
    await seed("overridden", "overridden");
    await seed("undone", "rejected");
    await seed("agent-undone", "rejected", { agentEvent: "reply_type_pick.undone" });
    await seed("agent-seen", "auto_applied", { acknowledged: true, agentEvent: "reply_type_pick.acknowledged" });
    await seed("asks-nothing", "overridden", { asks: false });
    expect(await migrate(path.join(process.cwd(), "drizzle"))).toBe(0);
  });

  afterAll(async () => {
    await sql?.end();
    await adminSql.unsafe(`drop database if exists ${name} with (force)`);
    await adminSql.end();
  });

  it("counts a settled stop pick as reviewed, and leaves an open one or an agent's open", async () => {
    const rows = await sql<{ message_id: string }[]>`select message_id from stop_reviews`;
    const reviewed = new Set(rows.map((r) => r.message_id));
    const seen = Object.fromEntries(Object.entries(replies).map(([label, id]) => [label, reviewed.has(id)]));
    expect(seen).toEqual({ held: false, unchecked: false, seen: true, overridden: true, undone: true, "agent-undone": false, "agent-seen": false, "asks-nothing": false });
  });
});
