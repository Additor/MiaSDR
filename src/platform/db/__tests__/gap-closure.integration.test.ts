import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, type TestOrg } from "../../../test-support/db";

/** Invariants added by migration 0007. Needs TEST_DATABASE_URL, like the other integration tests. */
describeDb("gap-closure schema (0007)", () => {
  const sql = testSql();
  let orgA = "";
  let orgB = "";
  let personA = "";
  let personB = "";
  let mailboxA = "";
  let messageA = "";
  let messageB = "";
  let userId = "";
  const orgs: TestOrg[] = [];

  beforeAll(async () => {
    const s = uniqueKey();
    orgs.push(await createTestOrg(sql, "A"), await createTestOrg(sql, "B"));
    [orgA, orgB] = orgs.map((o) => o.organizationId);
    userId = orgs[0].userId;
    [{ id: personA }] = await sql`insert into people (organization_id, email) values (${orgA}, ${"a-" + s + "@x.com"}) returning id`;
    [{ id: personB }] = await sql`insert into people (organization_id, email) values (${orgB}, ${"b-" + s + "@x.com"}) returning id`;
    [{ id: mailboxA }] = await sql`
      insert into mailboxes (organization_id, email_address) values (${orgA}, ${"mb-" + s + "@x.com"}) returning id`;
    messageA = await makeMessage(orgA, personA, "a" + s);
    messageB = await makeMessage(orgB, personB, "b" + s);
  });

  async function makeMessage(org: string, person: string, key: string): Promise<string> {
    const [{ id: pipelineId }] = await sql`
      insert into pipelines (organization_id, name) values (${org}, ${"p-" + key}) returning id`;
    const [{ id: recordId }] = await sql`
      insert into records (organization_id, person_id, pipeline_id) values (${org}, ${person}, ${pipelineId}) returning id`;
    const [{ id: convId }] = await sql`
      insert into conversations (organization_id, record_id, channel, account_ref)
      values (${org}, ${recordId}, 'email', ${"acc-" + key}) returning id`;
    const [{ id }] = await sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${org}, ${convId}, 'email', ${"acc-" + key}, 'inbound', ${"k-" + key}, 'hi', now()) returning id`;
    return id;
  }

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("lead_ccs", () => {
    it("stores one row per person and address, and rejects a duplicate", async () => {
      await sql`insert into lead_ccs (organization_id, person_id, email, source_message_id)
                values (${orgA}, ${personA}, 'boss@x.com', ${messageA})`;
      await expect(
        sql`insert into lead_ccs (organization_id, person_id, email) values (${orgA}, ${personA}, 'boss@x.com')`,
      ).rejects.toThrow(/unique|duplicate/i);
      await expect(
        sql`insert into lead_ccs (organization_id, person_id, email) values (${orgA}, ${personA}, 'Boss@x.com')`,
      ).rejects.toThrow(/check/i);
    });

    it("rejects an address that is not lowercase or has no @", async () => {
      await expect(
        sql`insert into lead_ccs (organization_id, person_id, email) values (${orgA}, ${personA}, ' c@x.com')`,
      ).rejects.toThrow(/check/i);
      await expect(
        sql`insert into lead_ccs (organization_id, person_id, email) values (${orgA}, ${personA}, 'nope')`,
      ).rejects.toThrow(/check/i);
    });

    it("rejects a person or source message from another tenant", async () => {
      await expect(
        sql`insert into lead_ccs (organization_id, person_id, email) values (${orgA}, ${personB}, 'z@x.com')`,
      ).rejects.toThrow(/foreign key|violates/i);
      await expect(
        sql`insert into lead_ccs (organization_id, person_id, email, source_message_id)
            values (${orgA}, ${personA}, 'y@x.com', ${messageB})`,
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("rejects last_seen_at before first_seen_at", async () => {
      await expect(
        sql`insert into lead_ccs (organization_id, person_id, email, first_seen_at, last_seen_at)
            values (${orgA}, ${personA}, 'w@x.com', now(), now() - interval '1 day')`,
      ).rejects.toThrow(/check/i);
    });

    it("is removed with its person", async () => {
      const [{ id }] = await sql`insert into people (organization_id, email) values (${orgA}, 'gone@x.com') returning id`;
      await sql`insert into lead_ccs (organization_id, person_id, email) values (${orgA}, ${id}, 'v@x.com')`;
      await sql`delete from people where id = ${id}`;
      const rows = await sql`select 1 from lead_ccs where person_id = ${id}`;
      expect(rows).toHaveLength(0);
    });
  });

  describe("people and companies raw / linkedin_url", () => {
    it("defaults raw and linkedin_url to null", async () => {
      const [row] = await sql`select raw, linkedin_url from people where id = ${personA}`;
      expect(row).toEqual({ raw: null, linkedin_url: null });
    });

    it("caps raw at 256 KiB", async () => {
      const ok = JSON.stringify({ k: "x".repeat(1000) });
      const big = JSON.stringify({ k: "x".repeat(262144) });
      await sql`update people set raw = ${ok}::jsonb where id = ${personA}`;
      await expect(sql`update people set raw = ${big}::jsonb where id = ${personA}`).rejects.toThrow(/check/i);
      await expect(
        sql`insert into companies (organization_id, domain, raw) values (${orgA}, 'big.com', ${big}::jsonb)`,
      ).rejects.toThrow(/check/i);
    });
  });

  describe("sends kind=test", () => {
    it("accepts a test send without an enrollment", async () => {
      await sql`insert into sends (organization_id, kind, channel, mailbox_id, to_address, requested_by)
                values (${orgA}, 'test', 'email', ${mailboxA}, 'me@x.com', ${userId})`;
    });

    it("rejects a test send without recipient or mailbox, or on LinkedIn", async () => {
      await expect(
        sql`insert into sends (organization_id, kind, channel, mailbox_id) values (${orgA}, 'test', 'email', ${mailboxA})`,
      ).rejects.toThrow(/check/i);
      await expect(
        sql`insert into sends (organization_id, kind, channel, to_address) values (${orgA}, 'test', 'email', 'me@x.com')`,
      ).rejects.toThrow(/check/i);
      await expect(
        sql`insert into sends (organization_id, kind, channel, mailbox_id, to_address)
            values (${orgA}, 'test', 'linkedin', ${mailboxA}, 'me@x.com')`,
      ).rejects.toThrow(/check/i);
    });

    it("rejects a campaign send without an enrollment and an unknown kind", async () => {
      await expect(
        sql`insert into sends (organization_id, channel) values (${orgA}, 'email')`,
      ).rejects.toThrow(/check/i);
      await expect(
        sql`insert into sends (organization_id, kind, channel) values (${orgA}, 'weird', 'email')`,
      ).rejects.toThrow(/check/i);
    });
  });

  describe("drafts.cc", () => {
    it("defaults to an empty array and refuses CC on a LinkedIn draft", async () => {
      const [{ id: pipelineId }] = await sql`insert into pipelines (organization_id, name) values (${orgA}, 'dp') returning id`;
      const [{ id: recordId }] = await sql`
        insert into records (organization_id, person_id, pipeline_id) values (${orgA}, ${personA}, ${pipelineId}) returning id`;
      const [{ id: convId }] = await sql`
        insert into conversations (organization_id, record_id, channel, account_ref) values (${orgA}, ${recordId}, 'linkedin', 'li-1') returning id`;
      const [d] = await sql`
        insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel)
        values (${orgA}, ${recordId}, ${convId}, 0, 'linkedin') returning cc`;
      expect(d.cc).toEqual([]);
      await expect(
        sql`insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, cc)
            values (${orgA}, ${recordId}, ${convId}, 0, 'linkedin', ${["a@x.com"]})`,
      ).rejects.toThrow(/check/i);
    });
  });

  describe("tasks", () => {
    it("takes an assignee and completion fields, and rejects another tenant's person", async () => {
      await sql`insert into tasks (organization_id, person_id, name, assigned_to) values (${orgA}, ${personA}, 't', ${userId})`;
      await expect(
        sql`insert into tasks (organization_id, person_id, name) values (${orgA}, ${personB}, 't')`,
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  describe("linkedin limits", () => {
    it("bounds daily invitations and messages", async () => {
      const s = Math.random().toString(36).slice(2, 8);
      const ins = (invite: number, message: number) =>
        sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, daily_invite_limit, daily_message_limit)
            values (${orgA}, ${"pa-" + s + invite + message}, ${"li-" + s + invite + message}, ${invite}, ${message})`;
      await expect(ins(20, 50)).resolves.toBeDefined();
      await expect(ins(0, 50)).rejects.toThrow(/check/i);
      await expect(ins(101, 50)).rejects.toThrow(/check/i);
      await expect(ins(20, 0)).rejects.toThrow(/check/i);
      await expect(ins(20, 201)).rejects.toThrow(/check/i);
    });
  });

  describe("linkedin_connect_links", () => {
    const hash = "a".repeat(64);
    const insert = (org: string, name: string, h = hash, extra = sql``) =>
      sql`insert into linkedin_connect_links (organization_id, provider_name, secret_hash, expires_at)
          values (${org}, ${name}, ${h}, now() + interval '1 hour') ${extra}`;

    it("needs a hex SHA-256 secret hash and a unique provider name", async () => {
      const name = "link-" + Math.random();
      await insert(orgA, name);
      await expect(insert(orgB, name)).rejects.toThrow(/unique|duplicate/i);
      await expect(insert(orgA, name + "x", "plain-secret")).rejects.toThrow(/check/i);
    });

    it("ties completed status to completed_at", async () => {
      await expect(
        sql`insert into linkedin_connect_links (organization_id, provider_name, secret_hash, expires_at, status)
            values (${orgA}, ${"c-" + Math.random()}, ${hash}, now(), 'completed')`,
      ).rejects.toThrow(/check/i);
    });

    it("rejects a LinkedIn account from another tenant", async () => {
      const s = Math.random().toString(36).slice(2, 8);
      const [{ id: accB }] = await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id)
        values (${orgB}, ${"pb-" + s}, ${"lb-" + s}) returning id`;
      await expect(
        sql`insert into linkedin_connect_links (organization_id, provider_name, secret_hash, expires_at, linkedin_account_id)
            values (${orgA}, ${"x-" + s}, ${hash}, now(), ${accB})`,
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  describe("audit_log and organization timezone", () => {
    it("appends rows per organization and rejects a blank action", async () => {
      await sql`insert into audit_log (organization_id, actor_user_id, action, entity_type, entity_id, meta)
                values (${orgA}, ${userId}, 'organization.renamed', 'organization', ${orgA}, ${'{"from":"A"}'}::jsonb)`;
      await expect(sql`insert into audit_log (organization_id, action) values (${orgA}, '  ')`).rejects.toThrow(/check/i);
    });

    it("defaults organization timezone to UTC", async () => {
      const [{ timezone }] = await sql`select timezone from organizations where id = ${orgA}`;
      expect(timezone).toBe("UTC");
    });
  });

  describe("inbound_events replay", () => {
    it("keeps the event key unique and starts replay_count at zero", async () => {
      const key = "evt-" + Math.random();
      const [row] = await sql`
        insert into inbound_events (provider, provider_event_key, event_type, payload, status)
        values ('unipile', ${key}, 'message_received', '{}'::jsonb, 'failed') returning replay_count`;
      expect(row.replay_count).toBe(0);
      await expect(
        sql`insert into inbound_events (provider, provider_event_key, event_type, payload) values ('unipile', ${key}, 'x', '{}'::jsonb)`,
      ).rejects.toThrow(/unique|duplicate/i);
      await sql`update inbound_events set status = 'pending', replay_count = replay_count + 1, last_replayed_at = now()
                where provider = 'unipile' and provider_event_key = ${key}`;
      await sql`delete from inbound_events where provider_event_key = ${key}`;
    });
  });

  describe("linkedin search batches", () => {
    it("dedupes query URLs inside a batch but not across batches", async () => {
      const mk = async () => {
        const [{ id }] = await sql`insert into linkedin_search_batches (organization_id, name) values (${orgA}, 'b') returning id`;
        return id as string;
      };
      const b1 = await mk();
      const b2 = await mk();
      const q = (batch: string) =>
        sql`insert into linkedin_search_queries (organization_id, batch_id, url, source_row)
            values (${orgA}, ${batch}, 'https://www.linkedin.com/sales/search/people?q=1', 2)`;
      await q(b1);
      await expect(q(b1)).rejects.toThrow(/unique|duplicate/i);
      await expect(q(b2)).resolves.toBeDefined();
    });
  });

  describe("existing structures stay in place", () => {
    it("keeps the grid row trigger and the old indexes", async () => {
      const trg = await sql`select tgname from pg_trigger where not tgisinternal`;
      expect(trg.map((r) => r.tgname)).toContain("grid_rows_bump_version_trg");
      const idx = await sql`select indexname from pg_indexes where schemaname = 'public'`;
      const names = idx.map((r) => r.indexname);
      for (const n of ["people_org_email_uq", "messages_org_direction_sent_idx", "sends_mailbox_day_idx", "enrollments_due_idx", "sends_enrollment_step_uq"]) {
        expect(names).toContain(n);
      }
    });
  });
});
