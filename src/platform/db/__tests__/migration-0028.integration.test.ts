import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, TEST_DATABASE_URL } from "../../../test-support/db";
import { readableMigrationError } from "../migration-error";
import { adminAndScratchUrls, folderUpTo, readJournal } from "../../../test-support/migration-test-kit";
import { uid } from "../../../test-support/full-world";

/**
 * Migration 0028 (the assignee of a record) applied over records, campaigns and members from the 0027 schema. The backfill
 * gives a record the creator of its person's newest regular-campaign enrollment that is not removed, skipping a creator who
 * is not a member, and leaves every other record unassigned. Needs TEST_DATABASE_URL.
 *
 * This file is the template for a migration that changes existing rows: build a scratch database at the previous migration,
 * fill it, apply the migration and check only what it did to those rows. The rules the new schema enforces belong in a
 * schema test on the shared database (contacts-schema.integration.test.ts holds the ones of this migration).
 */

const RECORD_ASSIGNED_TO = 28;

describeDb("migration 0028 over data from the 0027 schema", () => {
  const name = `t28_mig_${Math.random().toString(36).slice(2, 8)}`;
  const urls = adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x/y", name);
  const admin = postgres(urls.admin, { max: 1, onnotice: () => undefined });
  const sql = postgres(urls.scratch, { max: 2, onnotice: () => undefined });
  const tmp = mkdtempSync(path.join(os.tmpdir(), "t28-mig-"));
  const apply = (lastIdx: number) => migrate(drizzle(sql), { migrationsFolder: folderUpTo(tmp, lastIdx) }).catch((e) => Promise.reject(readableMigrationError(e)));

  const [orgA, orgB, pipeA, pipeB, ann, bob, carl, dana] = Array.from({ length: 8 }, uid);
  const people: Record<string, string> = {};
  const records: Record<string, string> = {};
  let recordCount = 0;

  const SCENARIOS = ["single", "newerMember", "newerNonMember", "personalOnly", "removedOnly", "noEnrollment", "noCreator", "otherOrg"] as const;

  async function person(org: string, key: string): Promise<string> {
    const id = uid();
    await sql`insert into people (id, organization_id, email) values (${id}, ${org}, ${`${key}-${name}@x.test`})`;
    people[key] = id;
    return id;
  }
  async function record(org: string, pipeline: string, key: string) {
    const personId = await person(org, key);
    const [row] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${org}, ${personId}, ${pipeline}) returning id`;
    records[key] = row.id as string;
    return { personId, recordId: row.id as string };
  }
  async function campaign(org: string, createdBy: string | null, type = "regular"): Promise<string> {
    const [row] = await sql`insert into campaigns (organization_id, name, channel, type, created_by) values (${org}, ${"c-" + uid()}, ${type === "personal" ? "linkedin" : "email"}, ${type}, ${createdBy}) returning id`;
    return row.id as string;
  }
  async function enroll(org: string, campaignId: string, personId: string, createdAt: string, status = "active") {
    const [{ channel }] = await sql`select channel from campaigns where id = ${campaignId}`;
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, created_at) values (${org}, ${campaignId}, ${personId}, ${channel}, ${status}, ${createdAt})`;
  }
  const assignee = async (key: string) => (await sql`select assigned_to, assigned_source from records where id = ${records[key]}`)[0];

  beforeAll(async () => {
    await admin.unsafe(`create database ${name}`);
    expect(readJournal().entries.find((e) => e.idx === RECORD_ASSIGNED_TO)?.tag).toBe("0028_record_assigned_to");
    await apply(RECORD_ASSIGNED_TO - 1);

    await sql`insert into organizations (id, name, slug) values (${orgA}, 'A', ${"a-" + name}), (${orgB}, 'B', ${"b-" + name})`;
    await sql`insert into users (id, name, email) values (${ann}, 'Ann', ${"ann-" + name + "@x.test"}), (${bob}, 'Bob', ${"bob-" + name + "@x.test"}), (${carl}, 'Carl', ${"carl-" + name + "@x.test"}), (${dana}, 'Dana', ${"dana-" + name + "@x.test"})`;
    // Ann and Bob belong to A. Carl is in B only. Dana is in neither.
    await sql`insert into members (organization_id, user_id, role) values (${orgA}, ${ann}, 'owner'), (${orgA}, ${bob}, 'member'), (${orgB}, ${carl}, 'owner')`;
    await sql`insert into pipelines (id, organization_id, name) values (${pipeA}, ${orgA}, 'Default'), (${pipeB}, ${orgB}, 'Default')`;

    const annsCampaign = await campaign(orgA, ann);
    const bobsCampaign = await campaign(orgA, bob);
    const carlsCampaignInA = await campaign(orgA, carl);

    const single = await record(orgA, pipeA, "single");
    await enroll(orgA, annsCampaign, single.personId, "2026-09-01T10:00:00Z");

    const newer = await record(orgA, pipeA, "newerMember");
    await enroll(orgA, annsCampaign, newer.personId, "2026-09-01T10:00:00Z");
    await enroll(orgA, bobsCampaign, newer.personId, "2026-09-05T10:00:00Z");

    // The newest enrollment belongs to a creator who is not a member of A, so the older one decides.
    const nonMember = await record(orgA, pipeA, "newerNonMember");
    await enroll(orgA, annsCampaign, nonMember.personId, "2026-09-01T10:00:00Z");
    await enroll(orgA, carlsCampaignInA, nonMember.personId, "2026-09-09T10:00:00Z");

    const personalOnly = await record(orgA, pipeA, "personalOnly");
    await enroll(orgA, await campaign(orgA, ann, "personal"), personalOnly.personId, "2026-09-01T10:00:00Z");

    const removedOnly = await record(orgA, pipeA, "removedOnly");
    await enroll(orgA, annsCampaign, removedOnly.personId, "2026-09-01T10:00:00Z", "removed");

    await record(orgA, pipeA, "noEnrollment");

    const noCreator = await record(orgA, pipeA, "noCreator");
    await enroll(orgA, await campaign(orgA, null), noCreator.personId, "2026-09-01T10:00:00Z");

    // A campaign of organization B created by Dana, who belongs to no organization, and one by Ann, who belongs to A only.
    const otherOrg = await record(orgB, pipeB, "otherOrg");
    await enroll(orgB, await campaign(orgB, ann), otherOrg.personId, "2026-09-01T10:00:00Z");

    recordCount = (await sql`select count(*)::int as n from records`)[0].n as number;
    await apply(RECORD_ASSIGNED_TO);
  }, 60_000);

  afterAll(async () => {
    await sql.end();
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("the migration over existing data", () => {
    it("gives a record the creator of its person's newest regular enrollment", async () => {
      expect(await assignee("single")).toEqual({ assigned_to: ann, assigned_source: "auto" });
      expect(await assignee("newerMember")).toEqual({ assigned_to: bob, assigned_source: "auto" });
    });

    it("skips a creator who is not a member of the record's organization", async () => {
      expect(await assignee("newerNonMember")).toEqual({ assigned_to: ann, assigned_source: "auto" });
    });

    it("leaves a record unassigned when no regular enrollment, no creator or no member of its organization applies", async () => {
      for (const key of ["personalOnly", "removedOnly", "noEnrollment", "noCreator", "otherOrg"]) {
        expect(await assignee(key), key).toEqual({ assigned_to: null, assigned_source: null });
      }
    });

    it("changes no row count and leaves every constraint validated", async () => {
      expect((await sql`select count(*)::int as n from records`)[0].n).toBe(recordCount);
      expect(Object.keys(records)).toHaveLength(SCENARIOS.length);
      const notValid = await sql`select conname from pg_constraint where conrelid = 'records'::regclass and not convalidated`;
      expect(notValid).toEqual([]);
    });
  });
});
