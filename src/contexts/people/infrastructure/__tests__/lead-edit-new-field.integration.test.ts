import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { callRoute, createWorld, type World } from "@/test-support/route-client";
import { ConflictError, ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, TEST_DATABASE_URL, useTestEnv, waitForLockWaiters } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("lead edit: new fields against the column registry", () => {
  useTestEnv();
  let world: World;
  let uc: typeof import("../../application/custom-columns");
  let store: import("../../application/custom-columns").CustomColumnStore;
  let updateLead: typeof import("../../application/lead-management").updateLead;
  let leadDeps: typeof import("@/composition/leads").leadDeps;
  const owner = (): Actor => ({ userId: world.admin.userId, organizationId: world.orgA.id, role: "owner" });
  const member = (): Actor => ({ userId: world.member.userId, organizationId: world.orgA.id, role: "member" });

  beforeAll(async () => {
    world = await createWorld(TEST_DATABASE_URL ?? "");
    uc = await import("../../application/custom-columns");
    store = (await import("../drizzle-custom-column-store")).drizzleCustomColumnStore;
    ({ updateLead } = await import("../../application/lead-management"));
    ({ leadDeps } = await import("@/composition/leads"));
  });

  afterAll(async () => {
    // Throws on a failed delete; world.close() then finds nothing left of the two organizations.
    await dropOrgs(world.sql, [{ organizationId: world.orgA.id }, { organizationId: world.orgB.id }]);
    await world.close();
  });

  const person = async (custom: object = {}) => {
    const [{ id }] = await world.sql`insert into people (organization_id, email, custom) values (${world.orgA.id}, ${`p-${Math.random()}@nf.test`}, ${world.sql.json(custom as never)}) returning id`;
    return id as string;
  };
  const customOf = async (id: string) => (await world.sql`select custom from people where id = ${id}`)[0].custom as Record<string, unknown>;
  const columnRows = async () =>
    (await world.sql`select key, name, archived_at from entity_columns where organization_id = ${world.orgA.id} and entity = 'people' order by key`) as unknown as Array<{ key: string; name: string; archived_at: Date | null }>;
  const clean = async () => {
    await world.sql`delete from entity_columns where organization_id = ${world.orgA.id}`;
    await world.sql`delete from people where organization_id = ${world.orgA.id}`;
  };

  describe("lock order: the registry lock comes before the lead row lock", () => {
    it("concurrent edits with a new field and deletes of an archived column never deadlock", async () => {
      await clean();
      const failures: unknown[] = [];
      for (let round = 0; round < 40; round++) {
        const gone = await uc.createCustomColumn(store, owner(), { entity: "people", name: `Gone ${round}` });
        await uc.archiveCustomColumn(store, owner(), gone.id);
        const id = await person({ [gone.key]: "v" });
        const results = await Promise.allSettled([
          updateLead(leadDeps(), owner(), id, { title: `t${round}`, newCustom: [{ label: `Fresh ${round}`, value: "x" }] }),
          uc.deleteCustomColumn(store, owner(), gone.id),
        ]);
        for (const r of results) if (r.status === "rejected" && (r.reason as { code?: string; cause?: { code?: string } }).cause?.code === "40P01") failures.push(r.reason);
        for (const r of results) if (r.status === "rejected" && !(r.reason instanceof ConflictError)) failures.push(r.reason);
      }
      expect(failures).toEqual([]);
    }, 60_000);

    it("waits for the registry lock without holding the lead row lock", async () => {
      await clean();
      const id = await person();
      const lockKey = `leads-columns:${world.orgA.id}:people`;
      let edit: Promise<void> = Promise.resolve();
      await world.sql.begin(async (holder) => {
        // This transaction plays a column delete that holds the registry lock.
        await holder`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        edit = updateLead(leadDeps(), owner(), id, { newCustom: [{ label: "Order", value: "1" }] });
        // The edit waits on the registry lock before it touches the row.
        await waitForLockWaiters(world.sql, 1);
        // The delete would now update this row. It must not queue behind a held row lock.
        const free = await world.sql
          .begin(async (probe) => {
            await probe`set local lock_timeout = '200ms'`;
            await probe`select id from people where id = ${id} for update`;
            return true;
          })
          .catch(() => false);
        expect(free).toBe(true);
      });
      await edit;
      expect(await customOf(id)).toEqual({ x_order: "1" });
    });
  });

  describe("a member cannot restore an archived column through an edit", () => {
    it("refuses a label that matches an archived column and leaves it archived", async () => {
      await clean();
      const plan = await uc.createCustomColumn(store, owner(), { entity: "people", name: "Plan" });
      await uc.archiveCustomColumn(store, owner(), plan.id);
      const id = await person();
      const error = await updateLead(leadDeps(), member(), id, { newCustom: [{ label: "plan", value: "Free" }] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as Error).message).toBe("A field named Plan is archived. Ask an owner or admin to restore it first.");
      expect((await columnRows())[0].archived_at).not.toBeNull();
      expect(await customOf(id)).toEqual({});
    });

    it("lets an admin restore it through the edit", async () => {
      await clean();
      const plan = await uc.createCustomColumn(store, owner(), { entity: "people", name: "Plan" });
      await uc.archiveCustomColumn(store, owner(), plan.id);
      const id = await person();
      await updateLead(leadDeps(), { ...owner(), role: "admin" }, id, { newCustom: [{ label: "plan", value: "Free" }] });
      expect((await columnRows())[0].archived_at).toBeNull();
      expect(await customOf(id)).toEqual({ [plan.key]: "Free" });
    });

    it("answers 409 on PATCH /api/leads/[id] for a member", async () => {
      await clean();
      const plan = await uc.createCustomColumn(store, owner(), { entity: "people", name: "Plan" });
      await uc.archiveCustomColumn(store, owner(), plan.id);
      const id = await person();
      const res = await callRoute("leads/[id]/route.ts", "PATCH", { as: world.member, params: { id }, json: { newCustom: [{ label: "Plan", value: "Free" }] } });
      expect(res.status).toBe(409);
      expect(res.text).toContain("archived");
      expect((await columnRows())[0].archived_at).not.toBeNull();
      const ok = await callRoute("leads/[id]/route.ts", "PATCH", { as: world.admin, params: { id }, json: { newCustom: [{ label: "Plan", value: "Free" }] } });
      expect(ok.status).toBe(200);
    });
  });

  describe("new labels keep their values apart from explicit custom keys", () => {
    it("a blank new label that resolves to an existing column keeps the edit of that column", async () => {
      await clean();
      const plan = await uc.createCustomColumn(store, owner(), { entity: "people", name: "Plan" });
      const id = await person({ [plan.key]: "old" });
      await updateLead(leadDeps(), owner(), id, { custom: { [plan.key]: "Pro" }, newCustom: [{ label: "plan", value: "" }] });
      expect(await customOf(id)).toEqual({ [plan.key]: "Pro" });
      expect((await columnRows()).map((c) => c.key)).toEqual([plan.key]);
    });

    it("a label equal to the column's name with a different value than custom is a validation error", async () => {
      await clean();
      const plan = await uc.createCustomColumn(store, owner(), { entity: "people", name: "Plan" });
      const id = await person({ [plan.key]: "old" });
      const error = await updateLead(leadDeps(), owner(), id, { custom: { [plan.key]: "Pro" }, newCustom: [{ label: "plan", value: "Team" }] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(await customOf(id)).toEqual({ [plan.key]: "old" });
    });

    it("'Plan' and 'Plan!' in one edit create two columns and keep both values", async () => {
      await clean();
      const id = await person();
      await updateLead(leadDeps(), owner(), id, {
        newCustom: [
          { label: "Plan", value: "Pro" },
          { label: "Plan!", value: "Team" },
        ],
      });
      expect((await columnRows()).map((c) => c.key)).toEqual(["x_plan", "x_plan_2"]);
      expect(await customOf(id)).toEqual({ x_plan: "Pro", x_plan_2: "Team" });
    });

    it("two labels that fold to one name are one column, and disagreeing values are a validation error naming the label", async () => {
      await clean();
      const id = await person();
      await updateLead(leadDeps(), owner(), id, {
        newCustom: [
          { label: "Segment", value: "A" },
          { label: "segment", value: "A" },
        ],
      });
      expect((await columnRows()).map((c) => c.name)).toEqual(["Segment"]);
      const error = await updateLead(leadDeps(), owner(), id, {
        newCustom: [
          { label: "Region", value: "EU" },
          { label: "region", value: "US" },
        ],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain("region");
      expect((await columnRows()).map((c) => c.name)).toEqual(["Segment"]);
    });
  });
});
