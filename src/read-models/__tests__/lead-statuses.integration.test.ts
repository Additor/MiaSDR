import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("lead status read model", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let reads: typeof import("../lead-activity");
  let dbClient: typeof import("@/platform/db/client");
  const orgs: string[] = [];

  async function org() {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('A', ${"lo-" + tag}) returning id`;
    orgs.push(id);
    const [{ id: pipeline }] = await sql`insert into reply_type_sets (organization_id, name, is_default) values (${id}, 'default', true) returning id`;
    return { id: id as string, pipeline: pipeline as string, tag };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  let counter = 0;
  const person = async (o: Org, p: { email?: string | null; slug?: string | null; url?: string | null; name?: string } = {}) => {
    counter += 1;
    const [{ id }] = await sql`
      insert into people (organization_id, email, linkedin_slug, linkedin_url, full_name)
      values (${o.id}, ${p.email === undefined ? `p${counter}-${o.tag}@lo.test` : p.email}, ${p.slug ?? null}, ${p.url ?? null}, ${p.name ?? `Lead ${counter}`}) returning id`;
    return id as string;
  };
  const campaign = async (o: Org, name: string, type: "regular" | "personal" = "regular", status = "active") => {
    const channel = type === "personal" ? "linkedin" : "email";
    const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status, type) values (${o.id}, ${channel}, ${name}, ${status}, ${type}) returning id`;
    return id as string;
  };
  const enroll = async (o: Org, campaignId: string, personId: string, status: string, updatedAt = new Date().toISOString(), lastSentAt: string | null = null) => {
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, updated_at, last_sent_at)
      values (${o.id}, ${campaignId}, ${personId}, 'email', ${status}, ${updatedAt}, ${lastSentAt})`;
  };
  const record = async (o: Org, personId: string) => {
    const [{ id }] = await sql`insert into records (organization_id, person_id, reply_type_set_id) values (${o.id}, ${personId}, ${o.pipeline}) returning id`;
    return id as string;
  };
  let msg = 0;
  const message = async (o: Org, recordId: string, channel: "email" | "linkedin", direction: "inbound" | "outbound", sentAt: string, privateCampaignId: string | null = null) => {
    msg += 1;
    const account = `${channel}-acct-${o.tag}`;
    const [conv] = await sql`select id from conversations where record_id = ${recordId} and channel = ${channel} and private_campaign_id is not distinct from ${privateCampaignId}`;
    const conversationId =
      conv?.id ??
      (
        await sql`insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id) values (${o.id}, ${recordId}, ${channel}, ${account}, ${privateCampaignId}) returning id`
      )[0].id;
    await sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${o.id}, ${conversationId}, ${channel}, ${account}, ${direction}, ${`k${msg}-${o.tag}`}, 'hello', ${sentAt})`;
  };

  beforeAll(async () => {
    reads = await import("../lead-activity");
    dbClient = await import("@/platform/db/client");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  /** The Drizzle instance behind the lazy `db` proxy. Each `select()` call is one query of the read model. */
  const spyOnSelect = () => {
    void dbClient.db.$client;
    const instance = (globalThis as unknown as { __miasdrDb: typeof dbClient.db }).__miasdrDb;
    return vi.spyOn(instance, "select");
  };
  const read = (orgId: string, ids: string[]) => reads.readLeadStatuses(orgId, ids);

  it("reads the deciding enrollment, a lead in two campaigns and a removed enrollment", async () => {
    const o = await org();
    const [a, b] = [await campaign(o, "Alpha"), await campaign(o, "Beta")];
    const two = await person(o);
    const removedOnly = await person(o);
    const none = await person(o);
    await enroll(o, a, two, "completed", "2026-10-10T10:00:00Z");
    await enroll(o, b, two, "active", "2026-09-01T10:00:00Z");
    await enroll(o, a, removedOnly, "removed");
    const map = await read(o.id, [two, removedOnly, none]);
    expect(map.get(two)).toMatchObject({ state: "in_sequence", enrollment: { campaignName: "Beta" }, otherCampaigns: 1 });
    expect(map.get(removedOnly)).toMatchObject({ state: "new", enrollment: null, otherCampaigns: 0 });
    expect(map.has(none)).toBe(false);
  });

  it("does not count a removed enrollment next to a live one", async () => {
    const o = await org();
    const [a, b] = [await campaign(o, "Alpha"), await campaign(o, "Beta")];
    const p = await person(o);
    await enroll(o, a, p, "removed", "2026-10-10T10:00:00Z");
    await enroll(o, b, p, "completed", "2026-09-01T10:00:00Z");
    const entry = (await read(o.id, [p])).get(p);
    expect(entry).toMatchObject({ state: "finished", enrollment: { campaignName: "Beta" }, otherCampaigns: 0 });
  });

  it("shows a cold campaign send as the last contact when nobody replied and no message exists", async () => {
    const o = await org();
    const c = await campaign(o, "Alpha");
    const personal = await campaign(o, "Private", "personal");
    const cold = await person(o);
    const privateOnly = await person(o);
    const later = await person(o);
    const unsent = await person(o);
    await enroll(o, c, cold, "active", undefined, "2026-10-03T10:00:00Z");
    await enroll(o, personal, privateOnly, "active", undefined, "2026-10-04T10:00:00Z");
    await enroll(o, c, later, "completed", undefined, "2026-10-03T10:00:00Z");
    await message(o, await record(o, later), "email", "outbound", "2026-10-06T10:00:00Z");
    await enroll(o, c, unsent, "pending");
    const map = await read(o.id, [cold, privateOnly, later, unsent]);
    expect(map.get(cold)?.lastContactAt?.toISOString()).toBe("2026-10-03T10:00:00.000Z");
    expect(map.get(privateOnly)).toBeUndefined();
    expect(map.get(later)?.lastContactAt?.toISOString()).toBe("2026-10-06T10:00:00.000Z");
    expect(map.get(unsent)?.lastContactAt).toBeNull();
  });

  it("reads replied, stopped and in sequence from the enrollment status", async () => {
    const o = await org();
    const c = await campaign(o, "Alpha");
    const replied = await person(o);
    const bounced = await person(o);
    const waiting = await person(o);
    await enroll(o, c, replied, "replied");
    await enroll(o, c, bounced, "bounced");
    await enroll(o, c, waiting, "active");
    const map = await read(o.id, [replied, bounced, waiting]);
    expect(map.get(replied)?.state).toBe("replied");
    expect(map.get(bounced)?.state).toBe("stopped");
    expect(map.get(waiting)?.state).toBe("in_sequence");
  });

  it("takes the latest sent message across channels and ignores inbound mail for the last contact and private threads", async () => {
    const o = await org();
    const p = await person(o);
    const inboundOnly = await person(o);
    const never = await person(o);
    const r = await record(o, p);
    await message(o, r, "email", "outbound", "2026-09-01T10:00:00Z");
    await message(o, r, "linkedin", "outbound", "2026-09-20T10:00:00Z");
    await message(o, r, "email", "inbound", "2026-10-05T10:00:00Z");
    const personal = await campaign(o, "Private", "personal");
    await message(o, r, "linkedin", "outbound", "2026-10-09T10:00:00Z", personal);
    const r2 = await record(o, inboundOnly);
    await message(o, r2, "email", "inbound", "2026-10-01T10:00:00Z");
    const map = await read(o.id, [p, inboundOnly, never]);
    expect(map.get(p)?.lastContactAt?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    // Inbound mail is no contact, but it is a reply: the entry exists and says so.
    expect(map.get(inboundOnly)).toEqual({ state: "replied", enrollment: null, otherCampaigns: 0, lastContactAt: null });
    expect(map.get(never)).toBeUndefined();
  });

  it("defines Replied as a replied enrollment or an inbound message in a public conversation", async () => {
    const o = await org();
    const c = await campaign(o, "Alpha");
    const personal = await campaign(o, "Private", "personal");
    const unknownSender = await person(o);
    const outboundOnly = await person(o);
    const privateInbound = await person(o);
    const enrolledReplied = await person(o);
    const both = await person(o);
    await message(o, await record(o, unknownSender), "email", "inbound", "2026-10-01T10:00:00Z");
    await message(o, await record(o, outboundOnly), "email", "outbound", "2026-10-01T10:00:00Z");
    await message(o, await record(o, privateInbound), "linkedin", "inbound", "2026-10-01T10:00:00Z", personal);
    await enroll(o, c, enrolledReplied, "replied");
    await enroll(o, c, both, "replied");
    await message(o, await record(o, both), "email", "inbound", "2026-10-02T10:00:00Z");
    const map = await read(o.id, [unknownSender, outboundOnly, privateInbound, enrolledReplied, both]);
    expect(map.get(unknownSender)?.state).toBe("replied");
    expect(map.get(outboundOnly)?.state).toBe("new");
    expect(map.get(privateInbound)).toBeUndefined();
    expect(map.get(enrolledReplied)?.state).toBe("replied");
    expect(map.get(both)?.state).toBe("replied");
  });

  it("does not leak a private campaign through its name, count, reply or messages", async () => {
    const o = await org();
    const personal = await campaign(o, "Secret private campaign", "personal");
    const p = await person(o);
    await enroll(o, personal, p, "replied");
    await message(o, await record(o, p), "linkedin", "outbound", "2026-10-09T10:00:00Z", personal);
    const map = await read(o.id, [p]);
    // The only fact about this lead is a private one, so outreach reports nothing at all.
    expect(map.get(p)).toBeUndefined();
    // A regular enrollment next to it shows only the regular campaign.
    const regular = await campaign(o, "Alpha");
    await enroll(o, regular, p, "active");
    const entry = (await read(o.id, [p])).get(p);
    expect(entry).toMatchObject({ state: "in_sequence", enrollment: { campaignName: "Alpha" }, otherCampaigns: 0, lastContactAt: null });
    expect(JSON.stringify([...map.values()])).not.toContain("Secret");
  });

  it("reads paused and queued from the campaign status, with the step, next send and stop reason", async () => {
    const o = await org();
    const active = await campaign(o, "Running");
    const paused = await campaign(o, "On hold", "regular", "paused");
    const held = await person(o);
    const waiting = await person(o);
    const stopped = await person(o);
    await enroll(o, paused, held, "active");
    await enroll(o, active, waiting, "pending");
    await enroll(o, active, stopped, "cancelled");
    await sql`update campaign_enrollments set current_step = 2, next_send_at = '2026-10-20T09:00:00Z' where person_id = ${held}`;
    await sql`update campaign_enrollments set stop_reason = 'do_not_contact' where person_id = ${stopped}`;
    const map = await read(o.id, [held, waiting, stopped]);
    expect(map.get(held)).toMatchObject({ state: "paused", enrollment: { campaignName: "On hold", step: 2, nextSendAt: new Date("2026-10-20T09:00:00Z") } });
    expect(map.get(waiting)?.state).toBe("queued");
    expect(map.get(stopped)).toMatchObject({ state: "stopped", enrollment: { stopReason: "do_not_contact" } });
  });

  it("never reads another organization's enrollments or messages", async () => {
    const mine = await org();
    const theirs = await org();
    const c = await campaign(theirs, "Theirs");
    const p = await person(theirs);
    await enroll(theirs, c, p, "replied");
    await message(theirs, await record(theirs, p), "email", "outbound", "2026-10-01T10:00:00Z");
    expect((await read(mine.id, [p])).size).toBe(0);
    // The same ids asked for under the right organization still work.
    const own = (await read(theirs.id, [p])).get(p);
    expect(own?.state).toBe("replied");
    expect(own?.lastContactAt?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });

  it("returns an empty map for no ids and runs no query", async () => {
    const o = await org();
    const select = spyOnSelect();
    try {
      expect((await read(o.id, [])).size).toBe(0);
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  });

  it("reads a whole page in two queries, however many leads it holds", async () => {
    const o = await org();
    const c = await campaign(o, "Alpha");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await person(o);
      ids.push(p);
      await enroll(o, c, p, "active");
      await message(o, await record(o, p), "email", "outbound", "2026-10-01T10:00:00Z");
    }
    const select = spyOnSelect();
    try {
      const map = await read(o.id, ids);
      expect(map.size).toBe(12);
      expect(select).toHaveBeenCalledTimes(2);
    } finally {
      select.mockRestore();
    }
  });
});
