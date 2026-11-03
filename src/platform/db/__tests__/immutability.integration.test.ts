import { afterAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, insertFollowUpFlow, testSql } from "../../../test-support/db";
import { seedWorld, uid, type World } from "../../../test-support/full-world";

/**
 * Conversation identity, reply type keys, knowledge versions and published follow-up
 * versions stay as written. Each test names the trigger it protects, so dropping the trigger fails exactly that test.
 * Every trigger also gets a pass case for the update paths the application uses. Needs TEST_DATABASE_URL.
 */
const IDENTITY = /threads identity is immutable/;
const KEYS = /reply_types keys are immutable/;
const KNOWLEDGE = /knowledge_document_versions is append-only/;
const KNOWLEDGE_DELETE = /knowledge_document_versions is append-only: rows cannot be deleted directly/;
const VERSION_IDENTITY = /follow_up_versions identity is immutable/;
const VERSION_FROZEN = /a published follow-up version is frozen/;
const VERSION_DELETE = /a published follow-up version cannot be deleted directly/;
const STEPS_FROZEN = /follow_up_steps of a published follow-up version are frozen/;

/** Columns each trigger guards. The foreign key scan below fails if an ON DELETE/UPDATE SET NULL action could write one. */
const GUARDED: Record<string, string[]> = {
  threads: ["channel", "account_ref", "provider_thread_id", "provider_contact_id"],
  reply_types: ["key", "group_key", "reply_type_set_id"],
  follow_up_versions: ["organization_id", "flow_id", "version", "status", "published_at"],
  people: ["lifecycle", "converted_at"],
  deal_stages: ["kind"],
  deals: ["person_id", "organization_id"],
};

describeDb("immutable identity and versions", () => {
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

  /** A flow with a published version 1 that holds one step. Returns the ids. */
  async function flowWithPublished(w: World) {
    const flow = await insertFollowUpFlow(sql, w.org, "s-" + uid());
    const [version] = await sql`insert into follow_up_versions (organization_id, flow_id, version, status) values (${w.org}, ${flow}, 1, 'draft') returning id`;
    const [step] = await sql`
      insert into follow_up_steps (organization_id, follow_up_version_id, position, step_type, name, delay_minutes, ai_instructions)
      values (${w.org}, ${version.id}, 1, 'reply', 'Reply', 0, 'Answer the question.') returning id`;
    await sql`update follow_up_versions set status = 'published', published_at = now(), updated_at = now() where id = ${version.id}`;
    return { flow, version: version.id as string, step: step.id as string };
  }

  describe("threads_identity_trg", () => {
    it("raises when channel, account_ref, provider_thread_id or provider_contact_id change", async () => {
      const w = await world();
      await expect(sql`update threads set channel = 'linkedin' where id = ${w.thread}`).rejects.toThrow(IDENTITY);
      await expect(sql`update threads set account_ref = 'other@t8.test' where id = ${w.thread}`).rejects.toThrow(IDENTITY);
      await expect(sql`update threads set provider_thread_id = 'thread-1' where id = ${w.thread}`).rejects.toMatchObject({ code: "23000" });
      await expect(sql`update threads set provider_contact_id = 'contact-1' where id = ${w.thread}`).rejects.toThrow(IDENTITY);
      const [row] = await sql`select channel, account_ref from threads where id = ${w.thread}`;
      expect(row.channel).toBe("email");
      expect(row.account_ref).toBe("me@" + w.tag + ".test");
    });

    it("allows the update paths the application uses", async () => {
      const w = await world();
      // updated_at touches (reply and inbound stores), status, and a same-value write.
      await sql`update threads set updated_at = now() where id = ${w.thread}`;
      await sql`update threads set status = 'closed' where id = ${w.thread}`;
      await sql`update threads set channel = channel, account_ref = account_ref, provider_thread_id = provider_thread_id where id = ${w.thread}`;
    });
  });

  describe("reply_types_keys_trg", () => {
    it("raises when key, group_key, reply_type_set_id or system_role change", async () => {
      const w = await world();
      await expect(sql`update reply_types set key = 'renamed' where id = ${w.subA}`).rejects.toThrow(KEYS);
      await expect(sql`update reply_types set system_role = 'customer' where id = ${w.subA}`).rejects.toThrow(KEYS);
      await expect(sql`update reply_types set group_key = 'customer' where id = ${w.subA}`).rejects.toThrow(KEYS);
      const [other] = await sql`insert into reply_type_sets (organization_id, name) values (${w.org}, 'second') returning id`;
      await expect(sql`update reply_types set reply_type_set_id = ${other.id} where id = ${w.subA}`).rejects.toThrow(KEYS);
    });

    it("allows the columns that are not keys", async () => {
      const w = await world();
      await sql`
        update reply_types set name = 'Renamed', description = 'd', classification_guidance = 'g', reply_draft = false, follow_ups = 'stop', sort_order = 5
        where id = ${w.subA}`;
      await sql`update reply_types set key = key, group_key = group_key where id = ${w.subA}`;
    });
  });

  describe("knowledge_versions_no_update_trg and knowledge_versions_no_delete_trg", () => {
    it("knowledge_versions_no_update_trg: raises when a version row changes", async () => {
      const w = await world();
      await expect(sql`update knowledge_document_versions set content = 'rewritten' where document_id = ${w.knowledgeDoc}`).rejects.toThrow(KNOWLEDGE);
      await expect(sql`update knowledge_document_versions set version = 9 where document_id = ${w.knowledgeDoc}`).rejects.toMatchObject({ code: "23000" });
      const [row] = await sql`select content from knowledge_document_versions where document_id = ${w.knowledgeDoc}`;
      expect(row.content).toBe("c");
    });

    it("knowledge_versions_no_update_trg: a same-value update passes and a new version appends", async () => {
      const w = await world();
      await sql`update knowledge_document_versions set content = content where document_id = ${w.knowledgeDoc}`;
      // The store's update path: insert version 2, then raise latest_version, in one transaction.
      await sql.begin(async (tx) => {
        await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${w.org}, ${w.knowledgeDoc}, 2, 'second')`;
        await tx`update knowledge_documents set latest_version = 2, updated_at = now() where id = ${w.knowledgeDoc}`;
      });
    });

    it("knowledge_versions_no_delete_trg: a direct delete raises, the purge flag allows it, a document delete cascades", async () => {
      const w = await world();
      await sql.begin(async (tx) => {
        await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${w.org}, ${w.knowledgeDoc}, 2, 'second')`;
        await tx`update knowledge_documents set latest_version = 2 where id = ${w.knowledgeDoc}`;
      });
      await expect(sql`delete from knowledge_document_versions where document_id = ${w.knowledgeDoc} and version = 1`).rejects.toThrow(KNOWLEDGE_DELETE);
      await sql.begin(async (tx) => {
        await tx`select set_config('miasdr.allow_purge', 'on', true)`;
        await tx`delete from knowledge_document_versions where document_id = ${w.knowledgeDoc} and version = 1`;
      });
      await sql`delete from knowledge_documents where id = ${w.knowledgeDoc}`;
      expect((await sql`select 1 from knowledge_document_versions where document_id = ${w.knowledgeDoc}`).length).toBe(0);
    });
  });

  describe("follow_up_versions_frozen_trg", () => {
    it("raises when the identity of any version changes", async () => {
      const w = await world();
      const s = await flowWithPublished(w);
      const [draft] = await sql`insert into follow_up_versions (organization_id, flow_id, version, status) values (${w.org}, ${s.flow}, 2, 'draft') returning id`;
      await expect(sql`update follow_up_versions set version = 7 where id = ${draft.id}`).rejects.toThrow(VERSION_IDENTITY);
      const other = await insertFollowUpFlow(sql, w.org, "o-" + uid());
      await expect(sql`update follow_up_versions set flow_id = ${other} where id = ${draft.id}`).rejects.toThrow(VERSION_IDENTITY);
    });

    it("raises when a published version changes status or published_at", async () => {
      const w = await world();
      const s = await flowWithPublished(w);
      await expect(sql`update follow_up_versions set status = 'draft', published_at = null where id = ${s.version}`).rejects.toThrow(VERSION_FROZEN);
      await expect(sql`update follow_up_versions set published_at = now() - interval '1 day' where id = ${s.version}`).rejects.toThrow(VERSION_FROZEN);
    });

    it("allows the draft to published transition and updated_at touches", async () => {
      const w = await world();
      const s = await flowWithPublished(w);
      // The draft is edited, then published: the same statement the store uses. An updated_at touch on the published row passes.
      const [draft] = await sql`insert into follow_up_versions (organization_id, flow_id, version, status) values (${w.org}, ${s.flow}, 2, 'draft') returning id`;
      await sql`update follow_up_versions set updated_at = now() where id = ${draft.id}`;
      await sql`update follow_up_versions set status = 'published', published_at = now(), updated_at = now() where id = ${draft.id}`;
      await sql`update follow_up_versions set updated_at = now() where id = ${s.version}`;
      const [row] = await sql`select status from follow_up_versions where id = ${draft.id}`;
      expect(row.status).toBe("published");
    });
  });

  describe("follow_up_versions_no_delete_trg", () => {
    it("raises on a direct delete of a published version, allows a draft, and passes through the flow delete", async () => {
      const w = await world();
      const s = await flowWithPublished(w);
      await expect(sql`delete from follow_up_versions where id = ${s.version}`).rejects.toThrow(VERSION_DELETE);
      const [draft] = await sql`insert into follow_up_versions (organization_id, flow_id, version, status) values (${w.org}, ${s.flow}, 2, 'draft') returning id`;
      await sql`delete from follow_up_versions where id = ${draft.id}`;
      await sql`delete from follow_up_flows where id = ${s.flow}`;
      expect((await sql`select 1 from follow_up_versions where flow_id = ${s.flow}`).length).toBe(0);
      expect((await sql`select 1 from follow_up_steps where id = ${s.step}`).length).toBe(0);
    });
  });

  describe("follow_up_steps_frozen_trg", () => {
    it("raises on insert, update and delete under a published version", async () => {
      const w = await world();
      const s = await flowWithPublished(w);
      await expect(
        sql`insert into follow_up_steps (organization_id, follow_up_version_id, position, step_type, name, delay_minutes, ai_instructions)
            values (${w.org}, ${s.version}, 2, 'follow_up', 'Later', 60, 'Nudge.')`,
      ).rejects.toThrow(STEPS_FROZEN);
      await expect(sql`update follow_up_steps set ai_instructions = 'Changed.' where id = ${s.step}`).rejects.toThrow(STEPS_FROZEN);
      await expect(sql`delete from follow_up_steps where id = ${s.step}`).rejects.toThrow(STEPS_FROZEN);
      const [row] = await sql`select ai_instructions from follow_up_steps where id = ${s.step}`;
      expect(row.ai_instructions).toBe("Answer the question.");
    });

    it("raises when a step moves from a draft into a published version", async () => {
      const w = await world();
      const s = await flowWithPublished(w);
      const [draft] = await sql`insert into follow_up_versions (organization_id, flow_id, version, status) values (${w.org}, ${s.flow}, 2, 'draft') returning id`;
      const [step] = await sql`
        insert into follow_up_steps (organization_id, follow_up_version_id, position, step_type, name, delay_minutes, ai_instructions)
        values (${w.org}, ${draft.id}, 1, 'reply', 'Reply', 0, 'Draft text.') returning id`;
      await expect(sql`update follow_up_steps set follow_up_version_id = ${s.version} where id = ${step.id}`).rejects.toThrow(STEPS_FROZEN);
    });

    it("keeps draft steps editable: delete and re-insert, as the store does", async () => {
      const w = await world();
      const s = await flowWithPublished(w);
      const [draft] = await sql`insert into follow_up_versions (organization_id, flow_id, version, status) values (${w.org}, ${s.flow}, 2, 'draft') returning id`;
      await sql`
        insert into follow_up_steps (organization_id, follow_up_version_id, position, step_type, name, delay_minutes, ai_instructions)
        values (${w.org}, ${draft.id}, 1, 'reply', 'Reply', 0, 'v1')`;
      await sql`delete from follow_up_steps where follow_up_version_id = ${draft.id} and organization_id = ${w.org}`;
      await sql`
        insert into follow_up_steps (organization_id, follow_up_version_id, position, step_type, name, delay_minutes, ai_instructions)
        values (${w.org}, ${draft.id}, 1, 'reply', 'Reply', 0, 'v2')`;
      await sql`update follow_up_steps set ai_instructions = 'v3' where follow_up_version_id = ${draft.id}`;
    });
  });

  it("an organization delete cascades through every guarded table", async () => {
    const w = await world();
    await flowWithPublished(w);
    await sql`delete from organizations where id = ${w.org}`;
    for (const table of ["threads", "reply_types", "knowledge_document_versions", "follow_up_versions", "follow_up_steps"]) {
      expect((await sql.unsafe(`select 1 from ${table} where organization_id = $1`, [w.org])).length, table).toBe(0);
    }
  });

  it("no foreign key action writes a guarded column", async () => {
    // A SET NULL or SET DEFAULT action issues an UPDATE on the child table. The triggers raise on a changed guarded column,
    // so a key that nulled one would turn a parent delete into an error. Keys with a column list (PG 15) null only that list.
    const rows = await sql<{ child: string; cols: string[] }[]>`
      select c.conrelid::regclass::text as child,
        array(select a.attname from pg_attribute a
              where a.attrelid = c.conrelid and a.attnum = any(coalesce(c.confdelsetcols, c.conkey))) as cols
      from pg_constraint c
      where c.contype = 'f' and c.confdeltype in ('n', 'd') and c.conrelid::regclass::text = any(${Object.keys(GUARDED)})`;
    for (const row of rows) {
      const hit = row.cols.filter((col) => GUARDED[row.child].includes(col));
      expect(hit, `${row.child} SET NULL/DEFAULT key writes a guarded column`).toEqual([]);
    }
    // ON UPDATE actions rewrite the child too (CASCADE would copy a changed parent key into the guarded column).
    const cascades = await sql<{ child: string; cols: string[] }[]>`
      select c.conrelid::regclass::text as child,
        array(select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as cols
      from pg_constraint c
      where c.contype = 'f' and c.confupdtype in ('c', 'n', 'd') and c.conrelid::regclass::text = any(${Object.keys(GUARDED)})`;
    for (const row of cascades) {
      const hit = row.cols.filter((col) => GUARDED[row.child].includes(col));
      expect(hit, `${row.child} ON UPDATE action writes a guarded column`).toEqual([]);
    }
  });
});
