import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("custom column registry", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/custom-columns");
  let store: import("../../application/custom-columns").CustomColumnStore;
  const orgs: string[] = [];
  const users: string[] = [];
  const functions: string[] = [];

  async function org() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('C', ${"cc-" + tag}) returning id`;
    const [{ id: userId }] = await sql`insert into users (name, email) values ('U', ${tag + "@cc.test"}) returning id`;
    users.push(userId);
    orgs.push(id);
    const admin: Actor = { userId, organizationId: id, role: "admin" };
    const member: Actor = { ...admin, role: "member" };
    return { id, admin, member };
  }

  const person = async (orgId: string, n: number, custom: object) => {
    const [{ id }] = await sql`insert into people (organization_id, email, custom) values (${orgId}, ${`p${n}-${Math.random()}@x.test`}, ${sql.json(custom as never)}) returning id`;
    return id as string;
  };
  const company = async (orgId: string, custom: object) => {
    const [{ id }] = await sql`insert into companies (organization_id, domain, custom) values (${orgId}, ${`c${Math.random()}.test`}, ${sql.json(custom as never)}) returning id`;
    return id as string;
  };
  const customOf = async (table: "people" | "companies", id: string) => (await sql`select custom from ${sql(table)} where id = ${id}`)[0].custom as Record<string, unknown>;
  const names = async (actor: Actor, entity: "people" | "companies" = "people", includeArchived = false) =>
    (await uc.listCustomColumns(store, actor, { entity, includeArchived })).map((c) => c.name);

  beforeAll(async () => {
    uc = await import("../../application/custom-columns");
    store = (await import("../drizzle-custom-column-store")).drizzleCustomColumnStore;
  });

  afterAll(async () => {
    for (const fn of functions) await sql.unsafe(`drop function if exists ${fn}() cascade`);
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("creates a column with a derived key, text type and the next position", async () => {
    const { admin } = await org();
    const a = await uc.createCustomColumn(store, admin, { entity: "people", name: "  Plan   tier " });
    const b = await uc.createCustomColumn(store, admin, { entity: "people", name: "Region" });
    expect(a).toMatchObject({ key: "x_plan_tier", name: "Plan tier", type: "text", entity: "people" });
    expect(b.position).toBeGreaterThan(a.position);
    expect(await names(admin)).toEqual(["Plan tier", "Region"]);
  });

  it("refuses a duplicate name ignoring case, spacing and archived state", async () => {
    const { admin } = await org();
    const plan = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
    await expect(uc.createCustomColumn(store, admin, { entity: "people", name: " pLAN " })).rejects.toBeInstanceOf(ConflictError);
    await uc.archiveCustomColumn(store, admin, plan.id);
    await expect(uc.createCustomColumn(store, admin, { entity: "people", name: "PLAN" })).rejects.toThrow(/archive/);
    // The same name is free for the other entity.
    await expect(uc.createCustomColumn(store, admin, { entity: "companies", name: "Plan" })).resolves.toMatchObject({ entity: "companies" });
  });

  it("gives punctuation variants of one key distinct keys", async () => {
    const { admin } = await org();
    const a = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
    const b = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan!" });
    expect([a.key, b.key]).toEqual(["x_plan", "x_plan_2"]);
  });

  it("renames the label, keeps the key and leaves values reachable", async () => {
    const { id, admin } = await org();
    const col = await uc.createCustomColumn(store, admin, { entity: "people", name: "Tier" });
    const p = await person(id, 1, { [col.key]: "gold" });
    await uc.renameCustomColumn(store, admin, col.id, "Customer tier");
    const [after] = await uc.listCustomColumns(store, admin, { entity: "people", includeArchived: false });
    expect(after).toMatchObject({ key: col.key, name: "Customer tier", usedBy: 1 });
    expect(await customOf("people", p)).toEqual({ [col.key]: "gold" });
  });

  it("refuses a rename to a name another column uses, but allows a case change of its own name", async () => {
    const { admin } = await org();
    const a = await uc.createCustomColumn(store, admin, { entity: "people", name: "Alpha" });
    await uc.createCustomColumn(store, admin, { entity: "people", name: "Beta" });
    await expect(uc.renameCustomColumn(store, admin, a.id, "BETA")).rejects.toBeInstanceOf(ConflictError);
    await uc.renameCustomColumn(store, admin, a.id, "ALPHA");
    expect(await names(admin)).toContain("ALPHA");
  });

  it("reorders and persists; a stale or partial list is refused", async () => {
    const { admin } = await org();
    const a = await uc.createCustomColumn(store, admin, { entity: "people", name: "A col" });
    const b = await uc.createCustomColumn(store, admin, { entity: "people", name: "B col" });
    const c = await uc.createCustomColumn(store, admin, { entity: "people", name: "C col" });
    await uc.reorderCustomColumns(store, admin, { entity: "people", ids: [c.id, a.id, b.id] });
    expect(await names(admin)).toEqual(["C col", "A col", "B col"]);
    await expect(uc.reorderCustomColumns(store, admin, { entity: "people", ids: [a.id, b.id] })).rejects.toBeInstanceOf(ConflictError);
    expect(await names(admin)).toEqual(["C col", "A col", "B col"]);
  });

  it("archives and restores; values stay while archived", async () => {
    const { id, admin } = await org();
    const col = await uc.createCustomColumn(store, admin, { entity: "people", name: "Keep" });
    const p = await person(id, 2, { [col.key]: "v" });
    await uc.archiveCustomColumn(store, admin, col.id);
    expect(await names(admin)).toEqual([]);
    expect(await names(admin, "people", true)).toEqual(["Keep"]);
    expect(await customOf("people", p)).toEqual({ [col.key]: "v" });
    await expect(uc.archiveCustomColumn(store, admin, col.id)).rejects.toBeInstanceOf(ConflictError);
    await uc.restoreCustomColumn(store, admin, col.id);
    expect(await names(admin)).toEqual(["Keep"]);
    await expect(uc.restoreCustomColumn(store, admin, col.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("deletes only an archived column", async () => {
    const { admin } = await org();
    const col = await uc.createCustomColumn(store, admin, { entity: "people", name: "Live" });
    await expect(uc.deleteCustomColumn(store, admin, col.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await names(admin)).toEqual(["Live"]);
  });

  it("delete strips the key from every person and leaves other keys and organizations alone", async () => {
    const a = await org();
    const b = await org();
    const col = await uc.createCustomColumn(store, a.admin, { entity: "people", name: "Gone" });
    const other = await uc.createCustomColumn(store, a.admin, { entity: "people", name: "Stays" });
    const withBoth = await person(a.id, 3, { [col.key]: "1", [other.key]: "2" });
    const withOne = await person(a.id, 4, { [col.key]: "3" });
    const without = await person(a.id, 5, { [other.key]: "4" });
    const foreign = await person(b.id, 6, { [col.key]: "same key, other tenant" });
    await uc.archiveCustomColumn(store, a.admin, col.id);
    expect(await uc.deleteCustomColumn(store, a.admin, col.id)).toEqual({ strippedRows: 2 });
    expect(await customOf("people", withBoth)).toEqual({ [other.key]: "2" });
    expect(await customOf("people", withOne)).toEqual({});
    expect(await customOf("people", without)).toEqual({ [other.key]: "4" });
    expect(await customOf("people", foreign)).toEqual({ [col.key]: "same key, other tenant" });
    expect(await names(a.admin, "people", true)).toEqual(["Stays"]);
  });

  it("delete strips company values for a company column", async () => {
    const { id, admin } = await org();
    const col = await uc.createCustomColumn(store, admin, { entity: "companies", name: "Industry" });
    const co = await company(id, { [col.key]: "SaaS" });
    const p = await person(id, 7, { [col.key]: "a person value with the same key" });
    await uc.archiveCustomColumn(store, admin, col.id);
    await uc.deleteCustomColumn(store, admin, col.id);
    expect(await customOf("companies", co)).toEqual({});
    expect(await customOf("people", p)).toEqual({ [col.key]: "a person value with the same key" });
  });

  it("rolls the strip back when the column delete fails", async () => {
    const { id, admin } = await org();
    const col = await uc.createCustomColumn(store, admin, { entity: "people", name: "Doomed" });
    const p = await person(id, 8, { [col.key]: "precious" });
    await uc.archiveCustomColumn(store, admin, col.id);
    const fn = "t4cols_block_" + Math.random().toString(36).slice(2, 8);
    functions.push(fn);
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'blocked'; end $$`);
    await sql.unsafe(`create trigger ${fn} before delete on entity_columns for each row when (old.id = '${col.id}') execute function ${fn}()`);
    try {
      await expect(uc.deleteCustomColumn(store, admin, col.id)).rejects.toThrow();
      expect(await customOf("people", p)).toEqual({ [col.key]: "precious" });
      expect(await names(admin, "people", true)).toEqual(["Doomed"]);
    } finally {
      await sql.unsafe(`drop trigger ${fn} on entity_columns`);
    }
    await uc.deleteCustomColumn(store, admin, col.id);
    expect(await customOf("people", p)).toEqual({});
  });

  it("keeps organizations apart: lists, ids and names", async () => {
    const a = await org();
    const b = await org();
    const col = await uc.createCustomColumn(store, a.admin, { entity: "people", name: "Private" });
    expect(await names(b.admin)).toEqual([]);
    await expect(uc.renameCustomColumn(store, b.admin, col.id, "Hijack")).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.archiveCustomColumn(store, b.admin, col.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.restoreCustomColumn(store, b.admin, col.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.deleteCustomColumn(store, b.admin, col.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.reorderCustomColumns(store, b.admin, { entity: "people", ids: [col.id] })).rejects.toBeInstanceOf(ConflictError);
    // The same name is free in another organization.
    await expect(uc.createCustomColumn(store, b.admin, { entity: "people", name: "Private" })).resolves.toMatchObject({ key: "x_private" });
    expect(await names(a.admin)).toEqual(["Private"]);
  });

  it("lets a member read but not change the registry", async () => {
    const { admin, member } = await org();
    const col = await uc.createCustomColumn(store, admin, { entity: "people", name: "Visible" });
    expect(await names(member)).toEqual(["Visible"]);
    await expect(uc.createCustomColumn(store, member, { entity: "people", name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.renameCustomColumn(store, member, col.id, "Y")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.reorderCustomColumns(store, member, { entity: "people", ids: [col.id] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.archiveCustomColumn(store, member, col.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.restoreCustomColumn(store, member, col.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.deleteCustomColumn(store, member, col.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await names(admin)).toEqual(["Visible"]);
  });

  it("serializes two concurrent creates of the same name", async () => {
    const { admin } = await org();
    const results = await Promise.allSettled([
      uc.createCustomColumn(store, admin, { entity: "people", name: "Race" }),
      uc.createCustomColumn(store, admin, { entity: "people", name: "race" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await names(admin)).toHaveLength(1);
  });

  it("reports how many rows hold a value", async () => {
    const { id, admin } = await org();
    const col = await uc.createCustomColumn(store, admin, { entity: "people", name: "Counted" });
    await person(id, 9, { [col.key]: "a" });
    await person(id, 10, { [col.key]: "b" });
    await person(id, 11, {});
    const [row] = await uc.listCustomColumns(store, admin, { entity: "people", includeArchived: false });
    expect(row.usedBy).toBe(2);
  });

  describe("import and map-raw resolve labels against the registry", () => {
    const customRows = async (orgId: string) => (await sql`select email, custom from people where organization_id = ${orgId} order by email`) as unknown as Array<{ email: string; custom: Record<string, string> }>;
    const columnsOf = async (orgId: string) => (await sql`select key, name, archived_at from entity_columns where organization_id = ${orgId} and entity = 'people' order by key`) as unknown as Array<{ key: string; name: string; archived_at: Date | null }>;
    const runImport = async (actor: Actor, label: string, rows: Array<[string, string]>) => {
      const { importLeads } = await import("../../application/import-leads");
      const { drizzleLeadStore } = await import("../drizzle-lead-store");
      return importLeads(
        { store: drizzleLeadStore },
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          filename: "f",
          headers: ["Email", label],
          rows: rows.map(([email, value]) => ({ Email: email, [label]: value })),
          mapping: { Email: "email", [label]: `custom:${label}` },
          // The route passes the same value for the signed-in role.
          restoreArchivedColumns: actor.role === "owner" || actor.role === "admin",
        },
      );
    };

    it("import reuses a renamed column instead of creating a second one with the same name", async () => {
      const { id, admin } = await org();
      const plan = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      await uc.renameCustomColumn(store, admin, plan.id, "Account Plan");
      await runImport(admin, "Account Plan", [["a@imp.test", "Pro"]]);
      const columns = await columnsOf(id);
      expect(columns.map((c) => c.name)).toEqual(["Account Plan"]);
      expect((await customRows(id))[0].custom).toEqual({ [plan.key]: "Pro" });
    });

    it("import restores an archived column and writes into its key", async () => {
      const { id, admin } = await org();
      const plan = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      await uc.archiveCustomColumn(store, admin, plan.id);
      await runImport(admin, "plan", [["b@imp.test", "Free"]]);
      const columns = await columnsOf(id);
      expect(columns).toHaveLength(1);
      expect(columns[0].archived_at).toBeNull();
      expect((await customRows(id))[0].custom).toEqual({ [plan.key]: "Free" });
    });

    it("a member's import and map-raw refuse a label that matches an archived column, and nothing is restored or written", async () => {
      const { id, admin, member } = await org();
      const { leadDeps } = await import("../composition");
      const { mapRawField } = await import("../../application/lead-management");
      const plan = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      await uc.archiveCustomColumn(store, admin, plan.id);
      await sql`insert into people (organization_id, email, raw) values (${id}, 'm@imp.test', ${sql.json({ tier: "Gold" })})`;
      await expect(runImport(member, "plan", [["n@imp.test", "Free"]])).rejects.toBeInstanceOf(ConflictError);
      await expect(mapRawField(leadDeps(), member, { rawKey: "tier", name: "Plan" })).rejects.toBeInstanceOf(ConflictError);
      const columns = await columnsOf(id);
      expect(columns).toHaveLength(1);
      expect(columns[0].archived_at).not.toBeNull();
      expect((await customRows(id)).every((r) => Object.keys(r.custom ?? {}).length === 0)).toBe(true);
      expect((await customRows(id)).some((r) => r.email === "n@imp.test")).toBe(false);
    });

    it("import matches a column whose key got a numeric suffix and allocates fresh keys", async () => {
      const { id, admin } = await org();
      await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      const second = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan!" });
      expect(second.key).toBe("x_plan_2");
      await runImport(admin, "Plan!", [["c@imp.test", "Team"]]);
      expect((await customRows(id))[0].custom).toEqual({ x_plan_2: "Team" });
      // A new label whose derived key is taken gets a suffix instead of writing into another column's key.
      await runImport(admin, "Plan?", [["d@imp.test", "Solo"]]);
      const columns = await columnsOf(id);
      expect(columns.map((c) => c.key)).toEqual(["x_plan", "x_plan_2", "x_plan_3"]);
      expect((await customRows(id)).find((r) => r.email === "d@imp.test")?.custom).toEqual({ x_plan_3: "Solo" });
    });

    it("map-raw reuses a renamed column and restores an archived one", async () => {
      const { id, admin } = await org();
      const { leadDeps } = await import("../composition");
      const { mapRawField } = await import("../../application/lead-management");
      const plan = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      await uc.renameCustomColumn(store, admin, plan.id, "Account Plan");
      await sql`insert into people (organization_id, email, raw) values (${id}, 'r@imp.test', ${sql.json({ tier: "Gold" })})`;
      const first = await mapRawField(leadDeps(), admin, { rawKey: "tier", name: "Account Plan" });
      expect(first).toMatchObject({ key: plan.key, name: "Account Plan", updated: 1 });
      await uc.archiveCustomColumn(store, admin, plan.id);
      await mapRawField(leadDeps(), admin, { rawKey: "tier", name: "account plan", overwrite: true });
      const columns = await columnsOf(id);
      expect(columns).toHaveLength(1);
      expect(columns[0].archived_at).toBeNull();
    });
  });

  describe("the lead edit form's new fields resolve labels against the registry", () => {
    const columnsOf = async (orgId: string) => (await sql`select key, name, archived_at from entity_columns where organization_id = ${orgId} and entity = 'people' order by key`) as unknown as Array<{ key: string; name: string; archived_at: Date | null }>;
    const edit = async (admin: Actor, personId: string, newCustom: Array<{ label: string; value: string }>) => {
      const { leadDeps } = await import("../composition");
      const { updateLead } = await import("../../application/lead-management");
      await updateLead(leadDeps(), admin, personId, { newCustom });
    };

    it("label 'plan' reuses the column 'Plan'", async () => {
      const { id, admin } = await org();
      const plan = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      const personId = await person(id, 1, {});
      await edit(admin, personId, [{ label: "plan", value: "Pro" }]);
      expect((await columnsOf(id)).map((c) => c.name)).toEqual(["Plan"]);
      expect(await customOf("people", personId)).toEqual({ [plan.key]: "Pro" });
    });

    it("the label of an archived column restores it and the value shows in the list", async () => {
      const { id, admin } = await org();
      const plan = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      await uc.archiveCustomColumn(store, admin, plan.id);
      const personId = await person(id, 2, {});
      await edit(admin, personId, [{ label: "PLAN", value: "Free" }]);
      const columns = await columnsOf(id);
      expect(columns).toHaveLength(1);
      expect(columns[0].archived_at).toBeNull();
      expect(await names(admin)).toEqual(["Plan"]);
      expect(await customOf("people", personId)).toEqual({ [plan.key]: "Free" });
    });

    it("a label equal to a renamed column's new name reuses that column", async () => {
      const { id, admin } = await org();
      const plan = await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      await uc.renameCustomColumn(store, admin, plan.id, "Account Plan");
      const personId = await person(id, 3, {});
      await edit(admin, personId, [{ label: "account plan", value: "Team" }]);
      expect((await columnsOf(id)).map((c) => c.name)).toEqual(["Account Plan"]);
      expect(await customOf("people", personId)).toEqual({ [plan.key]: "Team" });
    });

    it("a brand-new label creates one column with the registry's key allocation", async () => {
      const { id, admin } = await org();
      await uc.createCustomColumn(store, admin, { entity: "people", name: "Plan" });
      const personId = await person(id, 4, {});
      // "Plan!" folds to a different name than "Plan" but derives the same key, so the registry allocates a suffix.
      await edit(admin, personId, [{ label: "Plan!", value: "Solo" }]);
      expect((await columnsOf(id)).map((c) => c.key)).toEqual(["x_plan", "x_plan_2"]);
      expect(await customOf("people", personId)).toEqual({ x_plan_2: "Solo" });
    });

    it("two new labels create two columns and the same label twice creates one", async () => {
      const { id, admin } = await org();
      const personId = await person(id, 5, {});
      await edit(admin, personId, [
        { label: "Region", value: "EU" },
        { label: "Tier", value: "Gold" },
      ]);
      expect((await columnsOf(id)).map((c) => c.name)).toEqual(["Region", "Tier"]);
      const otherId = await person(id, 6, {});
      await edit(admin, otherId, [
        { label: "Segment", value: "A" },
        { label: "segment", value: "A" },
      ]);
      expect((await columnsOf(id)).map((c) => c.name)).toEqual(["Region", "Segment", "Tier"]);
    });
  });
});
