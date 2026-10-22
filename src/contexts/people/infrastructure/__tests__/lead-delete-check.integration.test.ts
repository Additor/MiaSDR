import { afterAll, beforeAll, expect, it } from "vitest";
import type { LeadDeps } from "../../application/lead-ports";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("lead delete qualification", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let deps: LeadDeps;
  let check: typeof import("../../application/lead-delete-check");
  let management: typeof import("../../application/lead-management");
  const orgs: string[] = [];
  const users: string[] = [];

  async function org() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('D', ${"ld-" + tag}) returning id`;
    orgs.push(id);
    const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name, is_default) values (${id}, 'default', true) returning id`;
    return { id: id as string, pipeline: pipeline as string, tag };
  }
  type Org = Awaited<ReturnType<typeof org>>;
  let n = 0;
  const person = async (o: Org) => {
    n += 1;
    const [{ id }] = await sql`insert into people (organization_id, email, full_name) values (${o.id}, ${`d${n}-${o.tag}@ld.test`}, ${`Lead ${n}`}) returning id`;
    return id as string;
  };
  const campaign = async (o: Org, status: string) => {
    const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${o.id}, 'email', 'C', ${status}) returning id`;
    return id as string;
  };
  const enroll = async (o: Org, campaignId: string, personId: string, status: string) => {
    const [{ id }] =
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${o.id}, ${campaignId}, ${personId}, 'email', ${status}) returning id`;
    return id as string;
  };
  const actor = (o: Org) => ({ organizationId: o.id, userId: "u", role: "owner" }) as never;

  beforeAll(async () => {
    deps = (await import("../composition")).leadDeps();
    check = await import("../../application/lead-delete-check");
    management = await import("../../application/lead-management");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  /** The page's answer and the server's answer, side by side. They must agree. */
  async function both(o: Org, id: string) {
    const said = await check.checkLeadDelete(deps, actor(o), id);
    const outcome = await management.deleteLeads(deps, actor(o), { ids: [id] });
    return { said, outcome };
  }

  it("says a lead with nothing attached qualifies, and the delete then succeeds", async () => {
    const o = await org();
    const { said, outcome } = await both(o, await person(o));
    expect(said.canDelete).toBe(true);
    expect(outcome.deleted).toBe(1);
  });

  it("says a lead in a running campaign cannot be deleted, and the delete refuses it for that reason", async () => {
    const o = await org();
    const id = await person(o);
    await enroll(o, await campaign(o, "active"), id, "active");
    const said = await check.checkLeadDelete(deps, actor(o), id);
    expect(said.canDelete).toBe(false);
    expect(said.detail).toBe(management.BLOCK_MESSAGES.in_active_campaign);
    const outcome = await management.deleteLeads(deps, actor(o), { ids: [id] });
    expect(outcome.blocked).toEqual([{ id, name: "Lead " + n, reason: "in_active_campaign" }]);
  });

  it("treats an enrollment in a finished campaign as no blocker, like the delete", async () => {
    const o = await org();
    const id = await person(o);
    await enroll(o, await campaign(o, "completed"), id, "active");
    const { said, outcome } = await both(o, id);
    expect(said.canDelete).toBe(true);
    expect(outcome.deleted).toBe(1);
  });

  it("says a lead that was sent a message cannot be deleted", async () => {
    const o = await org();
    const id = await person(o);
    const c = await campaign(o, "completed");
    const enrollmentId = await enroll(o, c, id, "completed");
    await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status) values (${o.id}, ${enrollmentId}, 1, 'email', 'sent')`;
    const { said, outcome } = await both(o, id);
    expect(said).toMatchObject({ canDelete: false, detail: management.BLOCK_MESSAGES.has_sends });
    expect(outcome.deleted).toBe(0);
  });

  it("says a lead with a CRM record cannot be deleted", async () => {
    const o = await org();
    const id = await person(o);
    await sql`insert into records (organization_id, person_id, pipeline_id) values (${o.id}, ${id}, ${o.pipeline})`;
    const { said, outcome } = await both(o, id);
    expect(said).toMatchObject({ canDelete: false, detail: management.BLOCK_MESSAGES.linked_records });
    expect(outcome.deleted).toBe(0);
  });

  it("does not read another organization's lead as blocked", async () => {
    const a = await org();
    const b = await org();
    const id = await person(b);
    await sql`insert into records (organization_id, person_id, pipeline_id) values (${b.id}, ${id}, ${b.pipeline})`;
    expect((await check.checkLeadDelete(deps, actor(a), id)).canDelete).toBe(true);
  });

  it("names another member's personal campaign when the viewer cannot see its sends, and lists them for those who can", async () => {
    const o = await org();
    const [{ id: creator }] = await sql`insert into users (name, email) values ('Creator', ${`creator-${o.tag}@ld.test`}) returning id`;
    users.push(creator);
    const id = await person(o);
    const [{ id: personal }] = await sql`insert into campaigns (organization_id, channel, name, status, type, created_by) values (${o.id}, 'linkedin', 'Mine', 'completed', 'personal', ${creator}) returning id`;
    const [{ id: enrollmentId }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${o.id}, ${personal}, ${id}, 'linkedin', 'completed') returning id`;
    await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status) values (${o.id}, ${enrollmentId}, 1, 'linkedin', 'sent')`;
    const member = { organizationId: o.id, userId: "00000000-0000-4000-8000-000000000009", role: "member" } as never;
    const owner = { organizationId: o.id, userId: "00000000-0000-4000-8000-000000000008", role: "owner" } as never;
    const theCreator = { organizationId: o.id, userId: creator, role: "member" } as never;

    expect(await check.checkLeadDelete(deps, member, id)).toMatchObject({
      canDelete: false,
      detail: "This lead got messages in another member's personal campaign. Mark it do not contact instead of deleting it.",
    });
    expect((await management.deleteLeads(deps, member, { ids: [id] })).blocked).toEqual([{ id, name: "Lead " + n, reason: "has_hidden_sends" }]);
    expect(await check.checkLeadDelete(deps, theCreator, id)).toMatchObject({ detail: management.BLOCK_MESSAGES.has_sends });
    expect(await check.checkLeadDelete(deps, owner, id)).toMatchObject({ detail: management.BLOCK_MESSAGES.has_sends });

    const hidden = await management.getLead(deps, member, id);
    expect(hidden.sends).toEqual([]);
    expect(hidden.hiddenSends).toBe(true);
    const shown = await management.getLead(deps, theCreator, id);
    expect(shown.sends).toHaveLength(1);
    expect(shown.hiddenSends).toBe(false);
    expect((await management.getLead(deps, owner, id)).sends).toHaveLength(1);
  });
});
