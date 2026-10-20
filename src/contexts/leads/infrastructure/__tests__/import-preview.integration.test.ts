import { afterAll, beforeAll, expect, it } from "vitest";
import type { ImportSummary } from "../../domain/import-summary";
import type { Mapping } from "../../domain/import-plan";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
const mapping: Mapping = {
  Email: "email",
  "First Name": "first_name",
  Title: "title",
  Phone: "phone",
  LinkedIn: "linkedin",
  Plan: "custom:Plan",
  Notes: "skip",
};
const headers = Object.keys(mapping);

/** A small seeded generator, so a failing run can be replayed from its number. */
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

type Row = Record<string, string>;
type Snapshot = { people: unknown[]; columns: unknown[]; runs: number; companies: number };

describeDb("import dry run", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let app: typeof import("../../application/import-leads");
  let store: typeof import("../drizzle-lead-store").drizzleLeadStore;
  const orgs: string[] = [];
  const users: string[] = [];

  async function newOrg() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('P', ${"ip-" + tag}) returning id`;
    const [{ id: userId }] = await sql`insert into users (name, email) values ('U', ${tag + "@ip.test"}) returning id`;
    users.push(userId);
    orgs.push(id);
    users.push(userId);
    return { id: id as string, userId: userId as string };
  }

  async function snapshot(orgId: string): Promise<Snapshot> {
    return {
      people: [...(await sql`select id, email, linkedin_slug, first_name, title, phone, custom, raw from people where organization_id = ${orgId} order by id`)],
      columns: [...(await sql`select id, key, name, archived_at from entity_columns where organization_id = ${orgId} order by id`)],
      runs: (await sql`select count(*)::int as n from import_runs where organization_id = ${orgId}`)[0].n,
      companies: (await sql`select count(*)::int as n from companies where organization_id = ${orgId}`)[0].n,
    };
  }

  const command = (org: { id: string; userId: string }, rows: Row[], restoreArchivedColumns: boolean) => ({
    organizationId: org.id,
    userId: org.userId,
    filename: "p.csv",
    headers,
    rows,
    mapping,
    defaultCountry: "US",
    restoreArchivedColumns,
  });

  beforeAll(async () => {
    app = await import("../../application/import-leads");
    store = (await import("../drizzle-lead-store")).drizzleLeadStore;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  /** One random org and file. `archived` hides the Plan column, `renamedKey` stores it under another key. */
  async function scenario(seed: number) {
    const next = rng(seed);
    const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)];
    const org = await newOrg();
    const archived = next() < 0.4;
    const planKey = next() < 0.5 ? "x_plan" : "x_account_plan";
    if (next() < 0.8) {
      await sql`insert into entity_columns (organization_id, entity, key, name, type, position, archived_at)
                values (${org.id}, 'people', ${planKey}, 'Plan', 'text', 1, ${archived ? new Date() : null})`;
    }
    const mails = ["a", "b", "c", "d", "e", "f"].map((n) => `${n}@pool.test`);
    const slugs = ["s1", "s2", "s3"];
    const existing = mails.filter(() => next() < 0.5);
    for (const [i, email] of existing.entries()) {
      const slug = next() < 0.4 ? pick(slugs) : null;
      const custom = next() < 0.5 ? { [planKey]: pick(["Free", "Pro"]) } : {};
      await sql`insert into people (organization_id, email, linkedin_slug, first_name, full_name, title, phone, custom)
                values (${org.id}, ${email}, ${slug && !(await sql`select 1 from people where organization_id = ${org.id} and linkedin_slug = ${slug}`).length ? slug : null},
                        ${next() < 0.7 ? "Old" + i : null}, null, ${next() < 0.6 ? pick(["CTO", "VP"]) : null}, ${next() < 0.4 ? "+14155550100" : null}, ${sql.json(custom)})`;
    }
    const rows: Row[] = Array.from({ length: 6 + Math.floor(next() * 20) }, () => {
      const mail = pick([...mails, ...mails.map((m) => m.toUpperCase()), "", "not-an-email", "bad@"]);
      return {
        Email: mail,
        "First Name": pick(["", "Old0", "New"]),
        Title: pick(["", "CTO", "VP", "COO"]),
        Phone: pick(["", "+14155550100", "+14155550199", "123"]),
        LinkedIn: pick(["", "", `https://www.linkedin.com/in/${pick(slugs)}`, "not a url"]),
        Plan: pick(["", "Free", "Pro", "Team"]),
        Notes: pick(["", "n"]),
      };
    });
    return { org, rows, planKey, archived };
  }

  it("matches the real import on random files, existing leads and archived columns, and writes nothing", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { org, rows } = await scenario(seed * 7919);
      const before = await snapshot(org.id);
      const summary: ImportSummary = await app.previewImport({ store }, command(org, rows, true));
      expect(await snapshot(org.id), `seed ${seed}: the dry run changed the database`).toEqual(before);

      const report = await app.importLeads({ store }, command(org, rows, true));
      const skipped = summary.skipped.reduce<Record<string, number>>((all, g) => ({ ...all, [g.kind]: g.count }), {});
      expect(
        {
          created: summary.created,
          updated: summary.updated,
          unchanged: summary.unchanged,
          invalid: (skipped.invalid_email ?? 0) + (skipped.missing_identifier ?? 0) + (skipped.file_conflict ?? 0),
          conflicts: skipped.conflict ?? 0,
          duplicates: summary.duplicates.count,
          totalRows: summary.totalRows,
        },
        `seed ${seed}`,
      ).toEqual({
        created: report.stats.created,
        updated: report.stats.updated,
        unchanged: report.stats.unchanged,
        invalid: report.stats.invalid,
        conflicts: report.stats.conflicts,
        duplicates: report.stats.duplicatesInFile,
        totalRows: report.stats.totalRows,
      });
      // The examples the wizard shows are the rows the report lists.
      expect(summary.skipped.find((g) => g.kind === "conflict")?.examples ?? []).toEqual(report.issues.conflicts.slice(0, 3));
      // Merged duplicate rows reach the result screen too, so the summary's "more" line is true.
      expect(summary.duplicates.examples).toEqual(report.issues.duplicates.slice(0, 3));
      expect(report.issues.duplicates).toHaveLength(Math.min(report.stats.duplicatesInFile, 20));
      expect(summary.skipped.flatMap((g) => (g.kind === "conflict" ? [] : g.examples)).every((e) => report.issues.invalid.some((i) => i.row === e.row))).toBe(true);
    }
  }, 120_000);

  it("counts the stored values the import replaces, per column", async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { org, rows, planKey } = await scenario(seed * 104729);
      const before = await snapshot(org.id);
      const summary = await app.previewImport({ store }, command(org, rows, true));
      await app.importLeads({ store }, command(org, rows, true));
      const after = await snapshot(org.id);

      type P = { id: string; first_name: string | null; title: string | null; phone: string | null; custom: Record<string, string> | null };
      const was = new Map((before.people as P[]).map((p) => [p.id, p]));
      const replaced = (read: (p: P) => string | null | undefined) =>
        (after.people as P[]).filter((p) => {
          const old = was.get(p.id);
          return old && read(old) && read(p) !== read(old);
        }).length;
      // The Plan column resolves to the stored key of the column that carries the name.
      const keyNow = ((after.columns as Array<{ key: string; name: string }>).find((c) => c.name === "Plan")?.key ?? planKey) as string;
      const expected = Object.fromEntries(
        Object.entries({
          "First Name": replaced((p) => p.first_name),
          Title: replaced((p) => p.title),
          Phone: replaced((p) => p.phone),
          Plan: replaced((p) => p.custom?.[keyNow]),
        }).filter(([, n]) => n > 0),
      );
      const actual = Object.fromEntries(summary.overwrites.filter((o) => o.header !== "Source data").map((o) => [o.header, o.leads]));
      expect(actual, `seed ${seed}`).toEqual(expected);
    }
  }, 120_000);

  it("refuses an archived column for a member exactly as the import does, and restores nothing", async () => {
    const org = await newOrg();
    await sql`insert into entity_columns (organization_id, entity, key, name, type, position, archived_at) values (${org.id}, 'people', 'x_plan', 'Plan', 'text', 1, now())`;
    const rows = [{ Email: "a@pool.test", "First Name": "", Title: "", Phone: "", LinkedIn: "", Plan: "Pro", Notes: "" }];
    const before = await snapshot(org.id);
    const { ConflictError } = await import("@/shared/errors");
    const preview = await app.previewImport({ store }, command(org, rows, false)).catch((e) => e);
    const real = await app.importLeads({ store }, command(org, rows, false)).catch((e) => e);
    expect(preview).toBeInstanceOf(ConflictError);
    expect(real).toBeInstanceOf(ConflictError);
    expect((preview as Error).message).toBe((real as Error).message);
    expect(await snapshot(org.id)).toEqual(before);
    // An admin passes both, and the archived column comes back only on the real import.
    const summary = await app.previewImport({ store }, command(org, rows, true));
    expect(summary.created).toBe(1);
    expect((await snapshot(org.id)).columns).toEqual(before.columns);
    await app.importLeads({ store }, command(org, rows, true));
    expect((await sql`select archived_at from entity_columns where organization_id = ${org.id}`)[0].archived_at).toBeNull();
  });

  it("looks only at the caller's organization", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await sql`insert into people (organization_id, email, title) values (${b.id}, 'a@pool.test', 'CTO')`;
    const rows = [{ Email: "a@pool.test", "First Name": "", Title: "VP", Phone: "", LinkedIn: "", Plan: "", Notes: "" }];
    const summary = await app.previewImport({ store }, command(a, rows, true));
    expect([summary.created, summary.updated]).toEqual([1, 0]);
    expect(summary.overwrites).toEqual([]);
  });
});
