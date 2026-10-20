import { afterAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql } from "../../../test-support/db";
import { seedWorld, uid, type World } from "../../../test-support/full-world";

/**
 * The tenant foreign keys and the CHECK constraints exist, are validated, reject a bad row, and act on delete as declared.
 * Needs TEST_DATABASE_URL.
 */

/** [table, constraint, column(s) the delete action nulls, CASCADE, or null for NO ACTION]. */
const FOREIGN_KEYS: Array<[string, string, string | null]> = [
  ["classifications", "classifications_previous_subcategory_fk", "previous_subcategory_id"],
  ["classifications", "classifications_proposed_subcategory_fk", "proposed_subcategory_id"],
  ["classifications", "classifications_applied_subcategory_fk", "applied_subcategory_id"],
  ["drafts", "drafts_reply_message_fk", "reply_for_message_id"],
  ["records", "records_latest_inbound_message_fk", "latest_inbound_message_id"],
  ["sends", "sends_mailbox_fk", null],
  ["sends", "sends_taken_over_mailbox_fk", null],
  ["sends", "sends_linkedin_account_fk", null],
  ["linkedin_connections", "linkedin_connections_enrollment_fk", "enrollment_id"],
  ["linkedin_search_queries", "linkedin_search_queries_current_account_fk", "current_account_id"],
  ["notes", "notes_record_fk", "record_id"],
  ["tasks", "tasks_record_fk", "record_id"],
  ["import_runs", "import_runs_destination_campaign_fk", "destination_campaign_id"],
  ["deals", "deals_source_enrollment_fk", "source_enrollment_id"],
  ["company_domain_aliases", "company_domain_aliases_company_fk", "CASCADE"],
];

const CHECKS = [
  ["ai_jobs", "ai_jobs_attempts_range_ck"],
  ["ai_jobs", "ai_jobs_completion_ck"],
  ["classifications", "classifications_confidence_range_ck"],
  ["classifications", "classifications_context_version_ck"],
  ["classifications", "classifications_category_keys_ck"],
  ["conversations", "conversations_account_ref_ck"],
  ["drafts", "drafts_context_version_ck"],
  ["events", "events_type_ck"],
  ["identity_exceptions", "identity_exceptions_channel_ck"],
  ["identity_exceptions", "identity_exceptions_keys_ck"],
  ["messages", "messages_keys_ck"],
  ["pipeline_settings", "pipeline_settings_instructions_ck"],
  ["records", "records_active_channel_ck"],
  ["send_attempts", "send_attempts_refs_ck"],
] as const;

describeDb("foreign keys and checks", () => {
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

  describe("catalog", () => {
    it.each(FOREIGN_KEYS)("%s has %s, validated, with the planned delete action", async (table, name, nulls) => {
      const [row] = await sql`
        select convalidated, pg_get_constraintdef(oid) as def, confdeltype
        from pg_constraint where conrelid = ${table}::regclass and conname = ${name}`;
      expect(row, `${name} is missing`).toBeDefined();
      expect(row.convalidated).toBe(true);
      if (nulls === "CASCADE") {
        expect(row.def).toContain("ON DELETE CASCADE");
      } else if (nulls) {
        expect(row.def).toContain(`ON DELETE SET NULL (${nulls})`);
      } else {
        expect(row.confdeltype).toBe("a");
      }
      expect(row.def).toMatch(/\(\w+, organization_id\) REFERENCES \w+\(id, organization_id\)/);
    });

    it.each(CHECKS)("%s has %s, validated", async (table, name) => {
      const [row] = await sql`select convalidated from pg_constraint where conrelid = ${table}::regclass and conname = ${name} and contype = 'c'`;
      expect(row, `${name} is missing`).toBeDefined();
      expect(row.convalidated).toBe(true);
    });
  });

  describe("a row that points nowhere is refused", () => {
    const BAD: Array<[string, string, (w: World, id: string) => PromiseLike<unknown>]> = [
      ["classifications_previous_subcategory_fk", "classification", (w, id) => sql`update classifications set previous_subcategory_id = ${id} where id = ${w.classification}`],
      ["classifications_proposed_subcategory_fk", "classification", (w, id) => sql`update classifications set proposed_subcategory_id = ${id} where id = ${w.classification}`],
      ["classifications_applied_subcategory_fk", "classification", (w, id) => sql`update classifications set applied_subcategory_id = ${id} where id = ${w.classification}`],
      ["drafts_reply_message_fk", "draft", (w, id) => sql`update drafts set reply_for_message_id = ${id} where id = ${w.draft}`],
      ["records_latest_inbound_message_fk", "record", (w, id) => sql`update records set latest_inbound_message_id = ${id} where id = ${w.record}`],
      ["sends_mailbox_fk", "send", (w, id) => sql`update sends set mailbox_id = ${id} where id = ${w.sendEmail}`],
      ["sends_taken_over_mailbox_fk", "send", (w, id) => sql`update sends set taken_over_from_mailbox_id = ${id} where id = ${w.sendEmail}`],
      ["sends_linkedin_account_fk", "send", (w, id) => sql`update sends set linkedin_account_id = ${id} where id = ${w.sendLinkedin}`],
      ["linkedin_connections_enrollment_fk", "connection", (w, id) => sql`update linkedin_connections set enrollment_id = ${id} where id = ${w.connection}`],
      ["linkedin_search_queries_current_account_fk", "query", (w, id) => sql`update linkedin_search_queries set current_account_id = ${id} where id = ${w.searchQuery}`],
      ["notes_record_fk", "note", (w, id) => sql`update notes set record_id = ${id} where id = ${w.note}`],
      ["tasks_record_fk", "task", (w, id) => sql`update tasks set record_id = ${id} where id = ${w.task}`],
      ["import_runs_destination_campaign_fk", "import run", (w, id) => sql`update import_runs set destination_campaign_id = ${id} where id = ${w.importRun}`],
      ["deals_source_enrollment_fk", "deal", (w, id) => sql`update deals set source_enrollment_id = ${id} where id = ${w.deal}`],
      ["company_domain_aliases_company_fk", "company alias", (w, id) => sql`update company_domain_aliases set company_id = ${id} where id = ${w.companyAlias}`],
    ];

    it.each(BAD)("%s refuses an id that does not exist (%s)", async (name, _what, run) => {
      const w = await world();
      await expect(run(w, uid())).rejects.toThrow(new RegExp(`foreign key constraint "${name}"`));
    });

    it("refuses another organization's parent", async () => {
      const a = await world();
      const b = await world();
      await expect(sql`update sends set mailbox_id = ${b.mailbox} where id = ${a.sendEmail}`).rejects.toThrow(/sends_mailbox_fk/);
      await expect(sql`update notes set record_id = ${b.record} where id = ${a.note}`).rejects.toThrow(/notes_record_fk/);
      await expect(sql`update classifications set applied_subcategory_id = ${b.subA} where id = ${a.classification}`).rejects.toThrow(/classifications_applied_subcategory_fk/);
      await expect(sql`update deals set source_enrollment_id = ${b.enrollment} where id = ${a.deal}`).rejects.toThrow(/deals_source_enrollment_fk/);
      await expect(sql`update company_domain_aliases set company_id = ${b.company} where id = ${a.companyAlias}`).rejects.toThrow(/company_domain_aliases_company_fk/);
    });
  });

  describe("delete behavior", () => {
    it("deleting a subcategory nulls the classification pointers and keeps the row", async () => {
      const w = await world();
      await sql`delete from subcategories where id = ${w.subA}`;
      const [c] = await sql`select organization_id, previous_subcategory_id as p, proposed_subcategory_id as q, applied_subcategory_id as a from classifications where id = ${w.classification}`;
      expect(c).toMatchObject({ organization_id: w.org, p: null, q: null, a: null });
    });

    it("deleting an enrollment nulls the connection's enrollment_id", async () => {
      const w = await world();
      await sql`delete from campaign_enrollments where id = ${w.enrollment}`;
      const [c] = await sql`select organization_id, enrollment_id from linkedin_connections where id = ${w.connection}`;
      expect(c).toMatchObject({ organization_id: w.org, enrollment_id: null });
    });

    it("deleting an enrollment nulls the deal's source_enrollment_id and keeps the deal", async () => {
      const w = await world();
      await sql`delete from campaign_enrollments where id = ${w.enrollment}`;
      const [d] = await sql`select organization_id, source_enrollment_id, person_id from deals where id = ${w.deal}`;
      expect(d).toMatchObject({ organization_id: w.org, source_enrollment_id: null, person_id: w.contact });
    });

    it("deleting a company removes its other domains", async () => {
      const w = await world();
      await sql`delete from companies where id = ${w.company}`;
      expect((await sql`select count(*)::int as n from company_domain_aliases where id = ${w.companyAlias}`)[0].n).toBe(0);
    });

    it("deleting a campaign nulls the import run's destination", async () => {
      const w = await world();
      await sql`delete from campaigns where id = ${w.campaign}`;
      const [r] = await sql`select organization_id, destination_campaign_id from import_runs where id = ${w.importRun}`;
      expect(r).toMatchObject({ organization_id: w.org, destination_campaign_id: null });
    });

    it("deleting a campaign nulls the search batch's target campaign", async () => {
      const w = await world();
      await sql`update linkedin_search_batches set target_campaign_id = ${w.campaign} where id = ${w.searchBatch}`;
      await sql`delete from campaigns where id = ${w.campaign}`;
      const [b] = await sql`select organization_id, target_campaign_id from linkedin_search_batches where id = ${w.searchBatch}`;
      expect(b).toEqual({ organization_id: w.org, target_campaign_id: null });
    });

    it("deleting a record nulls the note and task pointers", async () => {
      const w = await world();
      const person2 = (await sql`insert into people (organization_id, email) values (${w.org}, ${"p2-" + w.tag + "@lead.test"}) returning id`)[0].id;
      const record2 = (await sql`insert into records (organization_id, person_id, pipeline_id) values (${w.org}, ${person2}, ${w.pipeline}) returning id`)[0].id;
      const note = (await sql`insert into notes (organization_id, person_id, record_id, body) values (${w.org}, ${person2}, ${record2}, 'n') returning id`)[0].id;
      const task = (await sql`insert into tasks (organization_id, person_id, record_id, name) values (${w.org}, ${person2}, ${record2}, 't') returning id`)[0].id;
      await sql`delete from records where id = ${record2}`;
      expect((await sql`select record_id from notes where id = ${note}`)[0].record_id).toBeNull();
      expect((await sql`select record_id from tasks where id = ${task}`)[0].record_id).toBeNull();
    });

    it("deleting a message (with the purge setting) nulls the draft and record pointers", async () => {
      const w = await world();
      const conv = w.conversation;
      const msg2 = (await sql`
        insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${w.org}, ${conv}, 'email', ${"me@" + w.tag + ".test"}, 'inbound', ${"m2-" + w.tag}, 'again', now()) returning id`)[0].id;
      await sql`update records set latest_inbound_message_id = ${msg2} where id = ${w.record}`;
      await sql`update drafts set reply_for_message_id = ${msg2} where id = ${w.draft}`;
      await sql.begin(async (tx) => {
        await tx`select set_config('miasdr.allow_purge', 'on', true)`;
        await tx`delete from messages where id = ${msg2}`;
      });
      expect((await sql`select latest_inbound_message_id as m from records where id = ${w.record}`)[0].m).toBeNull();
      expect((await sql`select reply_for_message_id as m from drafts where id = ${w.draft}`)[0].m).toBeNull();
    });

    it("a LinkedIn account with sends cannot be deleted, one with only a search pointer can", async () => {
      const w = await world();
      await expect(sql`delete from linkedin_accounts where id = ${w.linkedinAccount}`).rejects.toThrow(/foreign key/);
      await sql`delete from sends where id = ${w.sendLinkedin}`;
      await sql`delete from linkedin_connections where id = ${w.connection}`;
      await sql`delete from linkedin_accounts where id = ${w.linkedinAccount}`;
      const [q] = await sql`select organization_id, current_account_id from linkedin_search_queries where id = ${w.searchQuery}`;
      expect(q).toMatchObject({ organization_id: w.org, current_account_id: null });
    });

    it("a mailbox with sends cannot be deleted (history blocks removal), as the mailbox store reports it", async () => {
      const w = await world();
      await expect(sql`delete from mailboxes where id = ${w.mailbox}`).rejects.toMatchObject({ code: "23503" });
      await expect(sql`delete from mailboxes where id = ${w.mailbox2}`).rejects.toMatchObject({ code: "23503" });
    });

    it("deleting the organization removes rows in all 13 child tables", async () => {
      const w = await seedWorld(sql);
      await sql`delete from organizations where id = ${w.org}`;
      for (const t of ["classifications", "drafts", "records", "sends", "linkedin_connections", "linkedin_search_queries", "notes", "tasks", "import_runs", "messages", "events", "audit_log"]) {
        const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${t} where organization_id = '${w.org}'`);
        expect(n, t).toBe(0);
      }
      await sql`delete from users where id = ${w.user}`;
    });
  });

  describe("a row that breaks a check is refused", () => {
    const fails = (name: string) => new RegExp(`violates check constraint "${name}"`);

    it("classification confidence outside 0 to 1, context version below 0, unknown category key", async () => {
      const w = await world();
      await expect(sql`update classifications set confidence = 1.5 where id = ${w.classification}`).rejects.toThrow(fails("classifications_confidence_range_ck"));
      await expect(sql`update classifications set confidence = -0.1 where id = ${w.classification}`).rejects.toThrow(fails("classifications_confidence_range_ck"));
      await expect(sql`update classifications set expected_context_version = -1 where id = ${w.classification}`).rejects.toThrow(fails("classifications_context_version_ck"));
      // Detaching the subcategory first keeps the 0020 validator out of the way; the CHECK is under test here.
      await expect(sql`update classifications set applied_subcategory_id = null, applied_category_key = 'maybe' where id = ${w.classification}`).rejects.toThrow(fails("classifications_category_keys_ck"));
      // The subcategory of the fixture is in 'interested': a different key would trip classifications_subcategories_upd_trg (0020).
      await sql`update classifications set confidence = 1, applied_category_key = 'interested' where id = ${w.classification}`;
    });

    it("draft context version below 0", async () => {
      const w = await world();
      await expect(sql`update drafts set expected_context_version = -1 where id = ${w.draft}`).rejects.toThrow(fails("drafts_context_version_ck"));
    });

    it("ai job attempts and completion", async () => {
      const w = await world();
      const job = (id: string, extra: string) =>
        sql.unsafe(`insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key ${extra ? ", " + extra.split("=")[0] : ""}) values ('${w.org}', 'classification', 'message', '${id}', '${id}' ${extra ? ", " + extra.split("=")[1] : ""})`);
      await expect(job(uid(), "attempts=-1")).rejects.toThrow(fails("ai_jobs_attempts_range_ck"));
      await expect(job(uid(), "max_attempts=0")).rejects.toThrow(fails("ai_jobs_attempts_range_ck"));
      await expect(job(uid(), "status='succeeded'")).rejects.toThrow(fails("ai_jobs_completion_ck"));
      await expect(job(uid(), "status='skipped'")).rejects.toThrow(fails("ai_jobs_completion_ck"));
      await sql.unsafe(`insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, status, completed_at) values ('${w.org}', 'classification', 'message', '${uid()}', '${uid()}', 'succeeded', now())`);
    });

    it("blank keys and references", async () => {
      const w = await world();
      // An insert: an update of account_ref now stops at conversations_identity_trg (0016) before the CHECK runs.
      await expect(sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${w.org}, ${w.record}, 'email', ' ')`).rejects.toThrow(fails("conversations_account_ref_ck"));
      await expect(
        sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
            values (${w.org}, ${w.conversation}, 'email', ${"me@" + w.tag + ".test"}, 'inbound', '  ', 'x', now())`,
      ).rejects.toThrow(fails("messages_keys_ck"));
      await expect(sql`insert into events (organization_id, person_id, event_type, actor_type) values (${w.org}, ${w.person}, ' ', 'system')`).rejects.toThrow(fails("events_type_ck"));
      await expect(sql`update send_attempts set idempotency_key = ' ' where id = ${w.sendAttempt}`).rejects.toThrow(fails("send_attempts_refs_ck"));
      await expect(sql`update send_attempts set provider = '' where id = ${w.sendAttempt}`).rejects.toThrow(fails("send_attempts_refs_ck"));
      await expect(sql`update send_attempts set request_id = ' ' where id = ${w.sendAttempt}`).rejects.toThrow(fails("send_attempts_refs_ck"));
      await expect(sql`update send_attempts set account_ref = ' ' where id = ${w.sendAttempt}`).rejects.toThrow(fails("send_attempts_refs_ck"));
      await sql`update send_attempts set provider = null, request_id = 'r' where id = ${w.sendAttempt}`;
      const ex = (channel: string, account: string, key: string, reason: string) =>
        sql`insert into identity_exceptions (organization_id, channel, account_ref, source_event_key, reason) values (${w.org}, ${channel}, ${account}, ${key}, ${reason})`;
      await expect(ex("sms", "a", "k1", "r")).rejects.toThrow(fails("identity_exceptions_channel_ck"));
      await expect(ex("email", " ", "k2", "r")).rejects.toThrow(fails("identity_exceptions_keys_ck"));
      await expect(ex("email", "a", " ", "r")).rejects.toThrow(fails("identity_exceptions_keys_ck"));
      await expect(ex("email", "a", "k3", " ")).rejects.toThrow(fails("identity_exceptions_keys_ck"));
      await ex("email", "a", "k4", "r");
    });

    it("record active channel and instruction shape", async () => {
      const w = await world();
      await expect(sql`update records set active_channel = 'sms' where id = ${w.record}`).rejects.toThrow(fails("records_active_channel_ck"));
      await sql`update records set active_channel = 'linkedin' where id = ${w.record}`;
      const settings = (draft: unknown, cls: unknown = []) =>
        sql`insert into pipeline_settings (pipeline_id, organization_id, draft_instructions, classification_instructions)
            values (${w.pipeline}, ${w.org}, ${sql.json(draft as never)}, ${sql.json(cls as never)})`;
      await expect(settings({ a: 1 })).rejects.toThrow(fails("pipeline_settings_instructions_ck"));
      await expect(settings([], "text")).rejects.toThrow(fails("pipeline_settings_instructions_ck"));
      await expect(settings([{ title: "t", content: "x".repeat(100_001) }])).rejects.toThrow(fails("pipeline_settings_instructions_ck"));
      await settings([{ title: "t", content: "x".repeat(8000) }]);
    });
  });
});
