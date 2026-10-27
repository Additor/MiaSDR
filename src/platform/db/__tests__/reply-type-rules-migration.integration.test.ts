import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as script from "../../../../scripts/migrate.mjs";
import { DEFAULT_REPLY_TYPES } from "@/contexts/conversations/domain/default-reply-types";
import { describeDb, TEST_DATABASE_URL } from "../../../test-support/db";
import { adminAndScratchUrls, folderUpTo } from "../../../test-support/migration-test-kit";

/** The default reply types as 0002 stored them: group, key, name, stage rank and review flag. */
const OLD_DEFAULTS: Array<[group: string, key: string, name: string, rank: number | null, review: boolean]> = [
  ["interested", "information_requested", "Information requested", 1, false],
  ["interested", "case_study", "Case study", 1, false],
  ["interested", "demo_request", "Demo request", 1, false],
  ["interested", "meeting_requested", "Meeting requested", 2, false],
  ["interested", "meeting_no_show", "Meeting no show", 2, false],
  ["interested", "meeting_done", "Meeting done", 3, false],
  ["interested", "trial_requested", "Trial requested", 4, false],
  ["interested", "trial_user", "Trial user", 5, false],
  ["customer", "customer", "Existing customer", 6, true],
  ["not_interested", "do_not_contact", "Do not contact", null, false],
  ["not_interested", "not_required_right_now", "Not required right now", null, false],
  ["not_interested", "already_using_a_tool", "Already using a tool", null, false],
  ["other", "wrong_contact", "Did not connect to different contact", null, false],
  ["other", "connected_to_different_contact", "Connected to different contact", null, false],
  ["other", "left_company", "Left company", null, false],
  ["other", "out_of_office", "Out of office", null, false],
  ["other", "other", "Other", null, false],
];

const OLD_TRIAL_GUIDANCE =
  "Pick this when the person asks to start, activate, or get access to a trial or a sandbox, or asks what the next step to begin is. Once they are already using the trial, pick Trial user.";

/**
 * 0003_reply_type_rules turns the key and group rules into type rules, drops the stage rank and the review settings, and
 * snapshots the rules on existing picks. A scratch database at 0002 gets two organizations: one with the starter types
 * and default settings, which must end up exactly as a new organization's seeds, and one that changed its settings,
 * renamed a type and added its own. Needs TEST_DATABASE_URL. Builds and drops its own scratch database.
 */
describeDb("0003_reply_type_rules on existing rows", () => {
  const name = `miasdr_reply_type_rules_${Math.random().toString(36).slice(2, 8)}`;
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
    await migrate(folderUpTo(mkdtempSync(path.join(tmpdir(), "miasdr-0003-")), 2));
    sql = postgres(scratch, { max: 1, onnotice: () => undefined });
    const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id;
    const org = async (slug: string, reviewOther: boolean, customerReview: boolean) => {
      const id = await one(sql`insert into organizations (name, slug) values (${slug}, ${slug}) returning id`);
      const set = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${id}, 'Default', true) returning id`);
      await sql`insert into reply_handling_settings (reply_type_set_id, organization_id, review_other, customer_requires_review) values (${set}, ${id}, ${reviewOther}, ${customerReview})`;
      for (const [index, [group, key, typeName, rank, review]] of OLD_DEFAULTS.entries()) {
        ids[`${slug}:${key}`] = await one(sql`
          insert into reply_types (organization_id, reply_type_set_id, group_key, key, name, stage_rank, review_required, sort_order, classification_guidance)
          values (${id}, ${set}, ${group}, ${key}, ${typeName}, ${rank}, ${review}, ${index}, ${key === "trial_requested" ? OLD_TRIAL_GUIDANCE : null}) returning id`);
      }
      return { id, set };
    };
    const a = await org("a-0003", true, true);
    const b = await org("b-0003", false, false);
    ids.orgA = a.id;
    ids.orgB = b.id;
    ids.setB = b.set;

    // Organization B renamed two starter types, archived do not contact by hand and added two types of its own.
    await sql`update reply_types set name = 'VIP account' where id = ${ids["b-0003:customer"]}`;
    await sql`update reply_types set name = 'Not right now', classification_guidance = 'Our own words.' where id = ${ids["b-0003:not_required_right_now"]}`;
    await sql`update reply_types set active = false where id = ${ids["b-0003:do_not_contact"]}`;
    ids.pricing = await one(sql`
      insert into reply_types (organization_id, reply_type_set_id, group_key, key, name, review_required) values (${b.id}, ${b.set}, 'interested', 'pricing', 'Pricing', true) returning id`);
    ids.budget = await one(sql`
      insert into reply_types (organization_id, reply_type_set_id, group_key, key, name) values (${b.id}, ${b.set}, 'not_interested', 'no_budget', 'No budget') returning id`);

    const person = await one(sql`insert into people (organization_id, email, full_name) values (${b.id}, 'lead@0003.test', 'Lead') returning id`);
    const record = await one(sql`
      insert into records (organization_id, person_id, reply_type_set_id, group_key, reply_type_id, reply_type_source)
      values (${b.id}, ${person}, ${b.set}, 'other', ${ids["b-0003:out_of_office"]}, 'ai') returning id`);
    const conversation = await one(sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${b.id}, ${record}, 'email', 'me@0003.test') returning id`);
    const message = async (key: string) =>
      one(sql`
        insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${b.id}, ${conversation}, 'email', 'me@0003.test', 'inbound', ${key}, 'hello', now()) returning id`);
    ids.applied = await one(sql`
      insert into reply_type_picks (organization_id, record_id, message_id, expected_context_version, status, confidence, proposed_group_key, proposed_reply_type_id, applied_group_key, applied_reply_type_id)
      values (${b.id}, ${record}, ${await message("m1")}, 0, 'overridden', 1, 'interested', ${ids.pricing}, 'other', ${ids["b-0003:out_of_office"]}) returning id`);
    ids.proposed = await one(sql`
      insert into reply_type_picks (organization_id, record_id, message_id, expected_context_version, status, confidence, proposed_group_key, proposed_reply_type_id)
      values (${b.id}, ${record}, ${await message("m2")}, 0, 'proposed', 0.5, 'interested', ${ids.pricing}) returning id`);
    ids.failed = await one(sql`
      insert into reply_type_picks (organization_id, record_id, message_id, expected_context_version, status, error)
      values (${b.id}, ${record}, ${await message("m3")}, 0, 'failed', 'timeout') returning id`);
    await sql.end();
    await migrate(path.join(process.cwd(), "drizzle"));
    sql = postgres(scratch, { max: 1, onnotice: () => undefined });
  });
  afterAll(async () => {
    await sql?.end();
    await adminSql.unsafe(`drop database if exists ${name} with (force)`);
    await adminSql.end();
  });

  const typesOf = (org: string) =>
    sql<Array<{ key: string; name: string; check_mode: string; reply_draft: boolean; follow_ups: string; system_role: string | null; active: boolean }>>`
      select key, name, check_mode, reply_draft, follow_ups, system_role, active from reply_types where organization_id = ${org} order by sort_order, key`;

  it("gives an organization on the starter types and default settings what a new organization's seeds give", async () => {
    const rows = await typesOf(ids.orgA);
    expect(rows).toEqual(
      DEFAULT_REPLY_TYPES.map((d) => ({
        key: d.key,
        name: d.name,
        check_mode: d.rules.checkMode,
        reply_draft: d.rules.replyDraft,
        follow_ups: d.rules.followUps,
        system_role: d.systemRole ?? null,
        active: true,
      })),
    );
    const [trial] = await sql`select classification_guidance from reply_types where id = ${ids["a-0003:trial_requested"]}`;
    expect(trial.classification_guidance).toBe(DEFAULT_REPLY_TYPES.find((d) => d.key === "trial_requested")?.classificationGuidance);
  });

  it("follows the organization's review settings, its review_required types and its own names", async () => {
    const byKey = new Map((await typesOf(ids.orgB)).map((r) => [r.key, r]));
    // review_other and customer_requires_review were off: those groups apply without a check, unless review_required.
    expect(byKey.get("customer")).toMatchObject({ name: "VIP account", check_mode: "before", reply_draft: true, follow_ups: "stop", system_role: "customer" });
    expect(byKey.get("other")).toMatchObject({ name: "Unclear", check_mode: "after", reply_draft: true, follow_ups: "continue", system_role: null });
    expect(byKey.get("out_of_office")).toMatchObject({ check_mode: "skip", reply_draft: false, follow_ups: "stop" });
    expect(byKey.get("wrong_contact")).toMatchObject({ name: "Wrong person", check_mode: "after", reply_draft: true, follow_ups: "stop" });
    expect(byKey.get("pricing")).toMatchObject({ check_mode: "before", reply_draft: true, follow_ups: "continue", system_role: null });
    expect(byKey.get("no_budget")).toMatchObject({ check_mode: "skip", reply_draft: false, follow_ups: "stop", system_role: null });
    expect(byKey.get("not_required_right_now")).toMatchObject({ name: "Not right now", check_mode: "skip" });
    const [kept] = await sql`select classification_guidance from reply_types where id = ${ids["b-0003:not_required_right_now"]}`;
    expect(kept.classification_guidance).toBe("Our own words.");
    // The stop request type is always checked before, and active again.
    expect(byKey.get("do_not_contact")).toMatchObject({ name: "Asked to stop", check_mode: "before", reply_draft: false, follow_ups: "stop", system_role: "stop_request", active: true });
  });

  it("snapshots the rules of each pick's applied type, else its proposed type, and leaves a pick without a type empty", async () => {
    const rows = await sql`select id, rules from reply_type_picks where organization_id = ${ids.orgB}`;
    const rules = new Map(rows.map((r) => [r.id as string, r.rules]));
    expect(rules.get(ids.applied)).toEqual({ checkMode: "skip", replyDraft: false, followUps: "stop" });
    expect(rules.get(ids.proposed)).toEqual({ checkMode: "before", replyDraft: true, followUps: "continue" });
    expect(rules.get(ids.failed)).toBeNull();
  });

  it("drops the stage rank and the review settings", async () => {
    const columns = await sql`
      select table_name, column_name from information_schema.columns
      where table_name in ('reply_types', 'reply_handling_settings') and column_name in ('stage_rank', 'review_required', 'review_other', 'customer_requires_review', 'auto_apply_confidence')`;
    expect(columns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual(["reply_handling_settings.auto_apply_confidence"]);
  });

  it("keeps the stop request rules, one type per role and the customer type in its group", async () => {
    const stop = ids["b-0003:do_not_contact"];
    await expect(sql`update reply_types set reply_draft = true where id = ${stop}`).rejects.toThrow(/reply_types_stop_request_ck/);
    await expect(sql`update reply_types set check_mode = 'after' where id = ${stop}`).rejects.toThrow(/reply_types_stop_request_ck/);
    await expect(sql`update reply_types set follow_ups = 'continue' where id = ${stop}`).rejects.toThrow(/reply_types_stop_request_ck/);
    await expect(sql`update reply_types set active = false where id = ${stop}`).rejects.toThrow(/reply_types_stop_request_ck/);
    await expect(
      sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name, check_mode, reply_draft, follow_ups, system_role)
        values (${ids.orgB}, ${ids.setB}, 'not_interested', 'stop_two', 'Stop two', 'before', false, 'stop', 'stop_request')`,
    ).rejects.toThrow(/reply_types_set_system_role_uq/);
    await expect(
      sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name, system_role) values (${ids.orgB}, ${ids.setB}, 'interested', 'vip_two', 'VIP two', 'customer')`,
    ).rejects.toThrow(/reply_types_customer_ck/);
    await expect(sql`update reply_types set check_mode = 'sometimes' where id = ${ids.pricing}`).rejects.toThrow(/reply_types_rules_ck/);
  });

  it("keeps a type's system role fixed, like its key", async () => {
    await expect(sql`update reply_types set system_role = null where id = ${ids["b-0003:customer"]}`).rejects.toThrow(/reply_types keys are immutable/);
    await expect(sql`update reply_types set system_role = 'customer' where id = ${ids.pricing}`).rejects.toThrow(/reply_types keys are immutable/);
    await sql`update reply_types set check_mode = 'before', name = 'VIP' where id = ${ids["b-0003:customer"]}`;
  });
});
