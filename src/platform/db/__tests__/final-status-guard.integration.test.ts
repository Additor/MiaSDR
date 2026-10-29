import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, type TestOrg } from "../../../test-support/db";
import { ATTEMPT_FINAL, ATTEMPT_FROM, type AttemptStatus } from "@/contexts/conversations/domain/send-attempt-status";
import { SEND_FINAL, SEND_FROM, type SendStatus } from "@/contexts/outreach/domain/send-status";

/**
 * A Postgres trigger refuses an UPDATE that moves `sends.status` or `send_attempts.status` out of a
 * final state. The expectations come from the domain tables, so a new status or a changed final set fails here.
 * Needs TEST_DATABASE_URL, like the other integration tests.
 */
const SEND_STATUSES = Object.keys(SEND_FROM) as SendStatus[];
const ATTEMPT_STATUSES = Object.keys(ATTEMPT_FROM) as AttemptStatus[];

/** Every (from, to) pair the domain table allows, for a status set. */
function allowedPairs<S extends string>(table: Record<S, readonly S[]>): [S, S][] {
  return (Object.keys(table) as S[]).flatMap((to) => table[to].map((from) => [from, to] as [S, S]));
}

describeDb("final status guard", () => {
  const sql = testSql();
  let owner: TestOrg;
  let org = "";
  let user = "";
  let mailbox = "";
  let record = "";
  let conversation = "";
  const tag = uniqueKey();
  let counter = 0;

  beforeAll(async () => {
    owner = await createTestOrg(sql, "F");
    ({ organizationId: org, userId: user } = owner);
    [{ id: mailbox }] = await sql`insert into mailboxes (organization_id, email_address) values (${org}, ${"mb-" + tag + "@fs.test"}) returning id`;
    const [{ id: person }] = await sql`insert into people (organization_id, email) values (${org}, ${tag + "@lead.test"}) returning id`;
    const [{ id: pipeline }] = await sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'p', true) returning id`;
    [{ id: record }] = await sql`insert into records (organization_id, person_id, reply_type_set_id) values (${org}, ${person}, ${pipeline}) returning id`;
    [{ id: conversation }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${org}, ${record}, 'email', 'me@fs.test') returning id`;
  });

  afterAll(async () => {
    await dropOrgs(sql, [owner]);
    await sql.end();
  });

  async function insertSend(status: SendStatus): Promise<string> {
    const [{ id }] = await sql`
      insert into sends (organization_id, kind, channel, status, mailbox_id, to_address)
      values (${org}, 'test', 'email', ${status}, ${mailbox}, 'to@fs.test') returning id`;
    return id;
  }

  async function insertAttempt(status: AttemptStatus): Promise<string> {
    counter += 1;
    const [{ id: draft }] = await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, subject)
      values (${org}, ${record}, ${conversation}, 0, 'email', 'Re: hi') returning id`;
    const [{ id }] = await sql`
      insert into send_attempts (organization_id, draft_id, idempotency_key, status, actor_user_id, reconciliation_note)
      values (${org}, ${draft}, ${`fs-${tag}-${counter}`}, ${status}, ${user}, ${status === "reconciled" ? "found" : null}) returning id`;
    return id;
  }

  const moveSend = (id: string, to: SendStatus) => sql`update sends set status = ${to}, error = 'x' where id = ${id}`;
  /** The engines' re-claim: failed -> sending with the attempt counter raised by one. */
  const reclaim = (id: string) => sql`update sends set status = 'sending', attempt = attempt + 1, error = null where id = ${id}`;
  const moveAttempt = (id: string, to: AttemptStatus) =>
    sql`update send_attempts set status = ${to}, reconciliation_note = ${to === "reconciled" ? "confirmed" : null} where id = ${id}`;

  describe("sends", () => {
    for (const [from, to] of allowedPairs(SEND_FROM)) {
      it(`allows ${from} -> ${to}`, async () => {
        const id = await insertSend(from);
        await moveSend(id, to);
        expect((await sql`select status from sends where id = ${id}`)[0].status).toBe(to);
      });
    }

    // `failed` is final except for the re-claim as the next attempt, so the exits that stay closed are every final -> other pair but that one.
    for (const from of SEND_FINAL) {
      for (const to of SEND_STATUSES.filter((s) => s !== from)) {
        if (from === "failed" && to === "sending") continue;
        it(`rejects ${from} -> ${to}`, async () => {
          const id = await insertSend(from);
          await expect(moveSend(id, to)).rejects.toThrow(/is final and cannot change/);
          expect((await sql`select status from sends where id = ${id}`)[0].status).toBe(from);
        });
      }
    }

    // The enrollment owns the attempt cap; the trigger holds only the step of one.
    it("lets a failed send be re-claimed as its next attempt, and only so", async () => {
      for (const attempt of [1, 2, 3, 7]) {
        const id = await insertSend("failed");
        await sql`update sends set attempt = ${attempt} where id = ${id}`;
        await reclaim(id);
        const [row] = await sql`select status, attempt from sends where id = ${id}`;
        expect([row.status, row.attempt]).toEqual(["sending", attempt + 1]);
      }
      const noCount = await insertSend("failed");
      await expect(sql`update sends set status = 'sending' where id = ${noCount}`).rejects.toThrow(/is final and cannot change/);
      // The re-claim raises attempt by exactly one: a jump from 1 to 3 skips an attempt and stays closed.
      const skipped = await insertSend("failed");
      await sql`update sends set attempt = 1 where id = ${skipped}`;
      await expect(sql`update sends set status = 'sending', attempt = 3 where id = ${skipped}`).rejects.toThrow(/is final and cannot change/);
      expect((await sql`select status, attempt from sends where id = ${skipped}`)[0]).toEqual({ status: "failed", attempt: 1 });
    });

    it("lets a final row change other columns and keep its status", async () => {
      for (const status of SEND_FINAL) {
        const id = await insertSend(status);
        await sql`update sends set status = ${status}, error = 'again', body = 'b' where id = ${id}`;
        await sql`update sends set error = 'later' where id = ${id}`;
      }
    });

    it("raises a check_violation, so callers see a database error and no silent write", async () => {
      const id = await insertSend("sent");
      await expect(moveSend(id, "failed")).rejects.toMatchObject({ code: "23514" });
    });

    it("still lets the store's guarded update match nothing on a final row", async () => {
      // The stores filter on SEND_FROM[target]; the filter excludes final rows, so the trigger never fires.
      const id = await insertSend("sent");
      const moved = await sql`update sends set status = 'failed' where id = ${id} and status in ${sql(SEND_FROM.failed)} returning id`;
      expect(moved).toHaveLength(0);
    });
  });

  describe("send_attempts", () => {
    for (const [from, to] of allowedPairs(ATTEMPT_FROM)) {
      it(`allows ${from} -> ${to}`, async () => {
        const id = await insertAttempt(from);
        await moveAttempt(id, to);
        expect((await sql`select status from send_attempts where id = ${id}`)[0].status).toBe(to);
      });
    }

    for (const from of ATTEMPT_FINAL) {
      for (const to of ATTEMPT_STATUSES.filter((s) => s !== from)) {
        it(`rejects ${from} -> ${to}`, async () => {
          const id = await insertAttempt(from);
          await expect(moveAttempt(id, to)).rejects.toThrow(/is final and cannot change/);
          expect((await sql`select status from send_attempts where id = ${id}`)[0].status).toBe(from);
        });
      }
    }

    it("lets a final attempt change other columns and keep its status", async () => {
      for (const status of ATTEMPT_FINAL) {
        const id = await insertAttempt(status);
        await sql`update send_attempts set status = ${status}, error = 'again', updated_at = now() where id = ${id}`;
        await sql`update send_attempts set response = ${sql.json({ ok: true })} where id = ${id}`;
      }
    });
  });
});
