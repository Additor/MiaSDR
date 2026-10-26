import { afterAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql } from "../../../test-support/db";
import { seedWorld, uid, type World } from "../../../test-support/full-world";

/**
 * Five cross-row rules. Each rule has a violating insert, a violating update, the legal
 * shapes next to it, and a trigger name in the test title so dropping the trigger fails exactly that test. Also covers the
 * foreign key actions (ON DELETE SET NULL) and legacy rows, which the triggers must not trip on. Needs TEST_DATABASE_URL.
 */
const MESSAGE = /classifications\.message_id must be an inbound message of the classification's record/;
const SUBCATEGORY = /classifications\.(previous|proposed|applied)_subcategory_id must belong to the record's pipeline/;
const CHANNEL = /drafts\.channel \(\w+\) must equal the channel of its conversation/;
const REPLY = /drafts\.reply_for_message_id must be an inbound message/;
const ACCOUNT = /send_attempts\.account_ref \(.*\) must equal the account of the draft's conversation/;

describeDb("cross-row validators", () => {
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

  /** A second conversation of the same record (LinkedIn) with an inbound message, and an outbound message in the first. */
  async function extras(w: World) {
    const account = uid();
    const [li] = await sql`insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id) values (${w.org}, ${w.record}, 'linkedin', ${account}, ${"chat-" + w.tag}) returning id`;
    const [liInbound] = await sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${w.org}, ${li.id}, 'linkedin', ${account}, 'inbound', ${"li-in-" + w.tag}, 'hi on linkedin', now()) returning id`;
    const [outbound] = await sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${w.org}, ${w.conversation}, 'email', ${"me@" + w.tag + ".test"}, 'outbound', ${"out-" + w.tag}, 'our reply', now()) returning id`;
    // A message of another record in the same organization.
    const [otherPerson] = await sql`insert into people (organization_id, email) values (${w.org}, ${"o-" + w.tag + "@lead.test"}) returning id`;
    const [otherRecord] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${w.org}, ${otherPerson.id}, ${w.pipeline}) returning id`;
    const [otherConv] = await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${w.org}, ${otherRecord.id}, 'email', ${"me@" + w.tag + ".test"}) returning id`;
    const [otherMessage] = await sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${w.org}, ${otherConv.id}, 'email', ${"me@" + w.tag + ".test"}, 'inbound', ${"other-" + w.tag}, 'someone else', now()) returning id`;
    return { linkedinConversation: li.id as string, linkedinAccount: account, linkedinInbound: liInbound.id as string, outbound: outbound.id as string, otherMessage: otherMessage.id as string };
  }

  const classify = (w: World, message: string, version: number, cols = "") =>
    sql.unsafe(`insert into classifications (organization_id, record_id, message_id, expected_context_version, confidence ${cols ? ", " + cols.split("|")[0] : ""}) values ('${w.org}', '${w.record}', '${message}', ${version}, 0.9 ${cols ? ", " + cols.split("|")[1] : ""})`);

  describe("classifications_message_ins_trg and classifications_message_upd_trg", () => {
    it("classifications_message_ins_trg: refuses an outbound message and a message of another record", async () => {
      const w = await world();
      const x = await extras(w);
      await expect(classify(w, x.outbound, 5)).rejects.toThrow(MESSAGE);
      await expect(classify(w, x.otherMessage, 6)).rejects.toThrow(MESSAGE);
    });

    it("classifications_message_ins_trg: accepts an inbound message of the record, in any of its conversations", async () => {
      const w = await world();
      const x = await extras(w);
      await classify(w, w.message, 7);
      await classify(w, x.linkedinInbound, 0);
    });

    it("classifications_message_upd_trg: refuses moving a classification to an outbound message", async () => {
      const w = await world();
      const x = await extras(w);
      await expect(sql`update classifications set message_id = ${x.outbound} where id = ${w.classification}`).rejects.toThrow(MESSAGE);
      await sql`update classifications set status = 'accepted' where id = ${w.classification}`;
    });
  });

  describe("classifications_subcategories_ins_trg and classifications_subcategories_upd_trg", () => {
    async function otherPipelineSub(w: World) {
      const [p] = await sql`insert into pipelines (organization_id, name) values (${w.org}, 'second') returning id`;
      const [s] = await sql`insert into subcategories (organization_id, pipeline_id, category_key, key, name) values (${w.org}, ${p.id}, 'interested', 'z', 'Z') returning id`;
      return s.id as string;
    }

    it("classifications_subcategories_ins_trg: refuses a subcategory of another pipeline in each of the three columns", async () => {
      const w = await world();
      const foreign = await otherPipelineSub(w);
      for (const [i, col] of ["previous", "proposed", "applied"].entries()) {
        await expect(classify(w, w.message, 10 + i, `${col}_subcategory_id|'${foreign}'`)).rejects.toThrow(SUBCATEGORY);
      }
    });

    it("classifications_subcategories_ins_trg: refuses a subcategory whose category differs from the stated key", async () => {
      const w = await world();
      await expect(classify(w, w.message, 20, `applied_subcategory_id, applied_category_key|'${w.subA}', 'customer'`)).rejects.toThrow(SUBCATEGORY);
      await classify(w, w.message, 21, `applied_subcategory_id, applied_category_key|'${w.subA}', 'interested'`);
    });

    it("classifications_subcategories_ins_trg: tolerates a null category key (the fixtures leave them null)", async () => {
      const w = await world();
      await classify(w, w.message, 22, `previous_subcategory_id, proposed_subcategory_id, applied_subcategory_id|'${w.subA}', '${w.subB}', '${w.subA}'`);
    });

    it("classifications_subcategories_upd_trg: refuses an update to a foreign subcategory or a mismatched key", async () => {
      const w = await world();
      const foreign = await otherPipelineSub(w);
      await expect(sql`update classifications set applied_subcategory_id = ${foreign} where id = ${w.classification}`).rejects.toThrow(SUBCATEGORY);
      await expect(sql`update classifications set proposed_category_key = 'customer' where id = ${w.classification}`).rejects.toThrow(SUBCATEGORY);
      await sql`update classifications set proposed_subcategory_id = ${w.subB}, proposed_category_key = 'interested' where id = ${w.classification}`;
    });

    it("leaves the ON DELETE SET NULL action alone, even on a legacy row that breaks the rule", async () => {
      const w = await world();
      const foreign = await otherPipelineSub(w);
      // A legacy row: the trigger is off while it is written, as if it predated the trigger.
      await sql.begin(async (tx) => {
        await tx`alter table classifications disable trigger classifications_subcategories_ins_trg`;
        await tx`insert into classifications (organization_id, record_id, message_id, expected_context_version, confidence, previous_subcategory_id, applied_subcategory_id)
                 values (${w.org}, ${w.record}, ${w.message}, 30, 0.9, ${foreign}, ${w.subB})`;
        await tx`alter table classifications enable trigger classifications_subcategories_ins_trg`;
      });
      await sql`delete from subcategories where id = ${w.subB}`;
      const [row] = await sql`select previous_subcategory_id, applied_subcategory_id from classifications where organization_id = ${w.org} and expected_context_version = 30`;
      expect(row).toMatchObject({ previous_subcategory_id: foreign, applied_subcategory_id: null });
      // An update that touches none of the checked columns also passes on the legacy row.
      await sql`update classifications set status = 'rejected' where organization_id = ${w.org} and expected_context_version = 30`;
    });
  });

  describe("drafts_channel_ins_trg and drafts_channel_upd_trg", () => {
    const insertDraft = (w: World, conversation: string, channel: string) =>
      sql`insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel) values (${w.org}, ${w.record}, ${conversation}, 0, ${channel})`;

    it("drafts_channel_ins_trg: refuses a draft whose channel differs from its conversation", async () => {
      const w = await world();
      const x = await extras(w);
      await expect(insertDraft(w, w.conversation, "linkedin")).rejects.toThrow(CHANNEL);
      await expect(insertDraft(w, x.linkedinConversation, "email")).rejects.toThrow(CHANNEL);
    });

    it("drafts_channel_ins_trg: accepts a matching channel on email and on LinkedIn", async () => {
      const w = await world();
      const x = await extras(w);
      await insertDraft(w, w.conversation, "email");
      await insertDraft(w, x.linkedinConversation, "linkedin");
    });

    it("drafts_channel_upd_trg: refuses a channel or conversation change that breaks the match", async () => {
      const w = await world();
      const x = await extras(w);
      await expect(sql`update drafts set channel = 'linkedin' where id = ${w.draft}`).rejects.toThrow(CHANNEL);
      await expect(sql`update drafts set conversation_id = ${x.linkedinConversation} where id = ${w.draft}`).rejects.toThrow(CHANNEL);
      await sql`update drafts set status = 'discarded', revision = revision + 1 where id = ${w.draft}`;
    });
  });

  describe("drafts_reply_target_ins_trg and drafts_reply_target_upd_trg", () => {
    it("drafts_reply_target_ins_trg: refuses an outbound reply target", async () => {
      const w = await world();
      const x = await extras(w);
      await expect(
        sql`insert into drafts (organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel) values (${w.org}, ${w.record}, ${w.conversation}, ${x.outbound}, 0, 'email')`,
      ).rejects.toThrow(REPLY);
    });

    it("drafts_reply_target_ins_trg: accepts an inbound message of another conversation of the record, and no target", async () => {
      const w = await world();
      const x = await extras(w);
      // thread-context.ts sets the target to the record's latest inbound message, wherever it lives.
      await sql`insert into drafts (organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel) values (${w.org}, ${w.record}, ${w.conversation}, ${x.linkedinInbound}, 0, 'email')`;
      await sql`insert into drafts (organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel) values (${w.org}, ${w.record}, ${w.conversation}, null, 0, 'email')`;
    });

    it("drafts_reply_target_upd_trg: refuses moving the target to an outbound message", async () => {
      const w = await world();
      const x = await extras(w);
      await expect(sql`update drafts set reply_for_message_id = ${x.outbound} where id = ${w.draft}`).rejects.toThrow(REPLY);
      await sql`update drafts set reply_for_message_id = ${x.linkedinInbound} where id = ${w.draft}`;
      await sql`update drafts set reply_for_message_id = null where id = ${w.draft}`;
    });

    it("leaves the ON DELETE SET NULL action alone, even on a legacy draft with the wrong channel", async () => {
      const w = await world();
      const x = await extras(w);
      await sql.begin(async (tx) => {
        await tx`alter table drafts disable trigger drafts_channel_ins_trg`;
        await tx`insert into drafts (id, organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel)
                 values (${x.outbound}, ${w.org}, ${w.record}, ${x.linkedinConversation}, ${x.linkedinInbound}, 0, 'email')`;
        await tx`alter table drafts enable trigger drafts_channel_ins_trg`;
      });
      await sql.begin(async (tx) => {
        await tx`select set_config('miasdr.allow_purge', 'on', true)`;
        await tx`update classifications set message_id = message_id where false`;
        await tx`delete from messages where id = ${x.linkedinInbound}`;
      });
      const [row] = await sql`select reply_for_message_id from drafts where id = ${x.outbound}`;
      expect(row.reply_for_message_id).toBeNull();
    });
  });

  describe("send_attempts_account_ins_trg and send_attempts_account_upd_trg", () => {
    const attempt = (w: World, accountRef: string | null, key: string) =>
      sql`insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, account_ref) values (${w.org}, ${w.draft}, ${key}, ${w.user}, ${accountRef})`;

    it("send_attempts_account_ins_trg: refuses an account that differs from the conversation's", async () => {
      const w = await world();
      await expect(attempt(w, "someone-else@" + w.tag + ".test", "a-" + uid())).rejects.toThrow(ACCOUNT);
    });

    it("send_attempts_account_ins_trg: accepts the same account in any letter case, and no account", async () => {
      const w = await world();
      await attempt(w, ("ME@" + w.tag + ".TEST").toUpperCase(), "b-" + uid());
      await attempt(w, "me@" + w.tag + ".test", "c-" + uid());
      await attempt(w, null, "d-" + uid());
    });

    it("send_attempts_account_ins_trg: compares the LinkedIn account id of a LinkedIn conversation", async () => {
      const w = await world();
      const x = await extras(w);
      const [d] = await sql`insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel) values (${w.org}, ${w.record}, ${x.linkedinConversation}, 0, 'linkedin') returning id`;
      await expect(
        sql`insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, provider, account_ref) values (${w.org}, ${d.id}, ${"e-" + uid()}, ${w.user}, 'linkedin', ${uid()})`,
      ).rejects.toThrow(ACCOUNT);
      await sql`insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, provider, account_ref) values (${w.org}, ${d.id}, ${"f-" + uid()}, ${w.user}, 'linkedin', ${x.linkedinAccount})`;
    });

    it("send_attempts_account_upd_trg: refuses an update to another account, accepts the matching one and status changes", async () => {
      const w = await world();
      await expect(sql`update send_attempts set account_ref = 'other@t8.test' where id = ${w.sendAttempt}`).rejects.toThrow(ACCOUNT);
      await sql`update send_attempts set account_ref = ${"ME@" + w.tag + ".test"} where id = ${w.sendAttempt}`;
      await sql`update send_attempts set status = 'sending' where id = ${w.sendAttempt}`;
    });
  });

  it("registers the ten triggers", async () => {
    const rows = await sql`select tgname from pg_trigger where not tgisinternal and tgname ~ '^(classifications_message|classifications_subcategories|drafts_channel|drafts_reply_target|send_attempts_account)_(ins|upd)_trg$' order by tgname`;
    expect(rows.map((r) => r.tgname)).toHaveLength(10);
  });
});
