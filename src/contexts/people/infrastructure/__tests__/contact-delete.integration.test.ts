import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { ContactDeleteDeps, ContactDeletePreview } from "../../application/contact-delete";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/**
 * Contact delete ("Contacts and Companies CRUD" in docs/decisions.md): the use case over the composition root's real wiring of
 * conversations, deals and outreach. Each blocker, member against admin; what the counts leave out; a full delete that leaves no
 * row of the person and touches no other person or organization; the suppression rule; the purge switch; the resolved identity
 * exception; the last-contact stamp; the audit row; the error codes. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describeDb("contact delete", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let app: typeof import("../../application/contact-delete");
  let deps: ContactDeleteDeps;
  let purgeSwitchIsOn: typeof import("@/contexts/conversations/infrastructure/person-purge").purgeSwitchIsOn;
  let deals: typeof import("@/contexts/deals/application/deals");
  let dealsDeps: typeof import("@/composition/deals").dealsDeps;
  const orgs: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    app = await import("../../application/contact-delete");
    deps = (await import("@/composition/person-lifecycle")).contactDeleteDeps;
    purgeSwitchIsOn = (await import("@/contexts/conversations/infrastructure/person-purge")).purgeSwitchIsOn;
    deals = await import("@/contexts/deals/application/deals");
    dealsDeps = (await import("@/composition/deals")).dealsDeps;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id as string;

  async function organization() {
    const tag = Math.random().toString(36).slice(2, 10);
    const org = await one(sql`insert into organizations (name, slug) values ('Contact delete', ${"contact-delete-" + tag}) returning id`);
    orgs.push(org);
    const user = async (name: string, role: string) => {
      const id = await one(sql`insert into users (name, email) values (${name}, ${`${name}-${tag}@x.test`}) returning id`);
      users.push(id);
      await sql`insert into members (organization_id, user_id, role) values (${org}, ${id}, ${role})`;
      return id;
    };
    const member = await user("member", "member");
    const other = await user("other", "member");
    const admin = await user("admin", "admin");
    const pipeline = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'p', true) returning id`);
    const pipeline2 = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'p2', false) returning id`);
    const sub = await one(sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name) values (${org}, ${pipeline}, 'interested', 'a', 'A') returning id`);
    const mailbox = await one(sql`insert into mailboxes (organization_id, email_address, status) values (${org}, ${`box-${tag}@x.test`}, 'connected') returning id`);
    const account = await one(sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id) values (${org}, ${`acc-${tag}`}, ${`li-${tag}`}) returning id`);
    const personal = await one(sql`insert into campaigns (organization_id, channel, name, type, created_by) values (${org}, 'linkedin', 'Mine', 'personal', ${other}) returning id`);
    const regular = await one(sql`insert into campaigns (organization_id, channel, name, status) values (${org}, 'email', 'Spring', 'completed') returning id`);
    const actors = {
      member: { userId: member, organizationId: org, role: "member" } satisfies Actor,
      other: { userId: other, organizationId: org, role: "member" } satisfies Actor,
      admin: { userId: admin, organizationId: org, role: "admin" } satisfies Actor,
    };
    return { org, tag, pipeline, pipeline2, sub, mailbox, account, personal, regular, actors };
  }
  type Org = Awaited<ReturnType<typeof organization>>;

  /** A bare contact, optionally at a company and with a LinkedIn profile. */
  async function bare(o: Org, label: string, opts: { companyId?: string | null; linkedin?: boolean; email?: string | null } = {}) {
    const email = opts.email === undefined ? `${o.tag}-${label}@lead.test` : opts.email;
    const person = await one(sql`
      insert into people (organization_id, email, full_name, lifecycle, converted_at, company_id, linkedin_url, linkedin_slug)
      values (${o.org}, ${email}, ${label}, 'contact', now(), ${opts.companyId ?? null},
              ${opts.linkedin ? `https://www.linkedin.com/in/${o.tag}-${label}` : null}, ${opts.linkedin ? `${o.tag}-${label}` : null}) returning id`);
    return { person, email };
  }

  /**
   * A contact with a row in every table the delete touches: a public email thread with a classification, AI jobs, a draft with
   * a sent attempt, a follow-up run, events, notes, tasks, a do not contact mark, a resolved identity exception, a won and a
   * lost deal, and a finished campaign enrollment with two sends a month old.
   */
  async function full(o: Org, label: string, opts: { companyId?: string | null; privateThread?: boolean } = {}) {
    const t = `${o.tag}-${label}`;
    const { person, email } = await bare(o, label, opts);
    const record = await one(sql`insert into records (organization_id, person_id, reply_type_set_id) values (${o.org}, ${person}, ${o.pipeline}) returning id`);
    const box = `me-${t}@x.test`;
    const conversation = await one(sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${o.org}, ${record}, 'email', ${box}) returning id`);
    const inbound = await one(sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${o.org}, ${conversation}, 'email', ${box}, 'inbound', ${`in-${t}`}, 'hello', now()) returning id`);
    const outbound = await one(sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${o.org}, ${conversation}, 'email', ${box}, 'outbound', ${`out-${t}`}, 'reply', now()) returning id`);
    await sql`update records set latest_inbound_message_id = ${inbound} where id = ${record}`;
    await one(sql`
      insert into reply_type_picks (organization_id, record_id, message_id, expected_context_version, previous_reply_type_id, proposed_reply_type_id, applied_reply_type_id, confidence)
      values (${o.org}, ${record}, ${inbound}, 0, ${o.sub}, ${o.sub}, ${o.sub}, 0.9) returning id`);
    await sql`insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key, completed_at) values (${o.org}, 'classification', 'succeeded', 'message', ${inbound}, ${`job-c-${t}`}, now())`;
    const draft = await one(sql`
      insert into drafts (organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel)
      values (${o.org}, ${record}, ${conversation}, ${inbound}, 0, 'email') returning id`);
    const attempt = await one(sql`
      insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, status) values (${o.org}, ${draft}, ${`sa-${t}`}, ${o.actors.member.userId}, 'prepared') returning id`);
    await sql`update send_attempts set status = 'sent' where id = ${attempt}`;
    const sequence = await one(sql`insert into sequences (organization_id, name) values (${o.org}, ${`Seq ${t}`}) returning id`);
    const version = await one(sql`insert into sequence_versions (organization_id, sequence_id, version) values (${o.org}, ${sequence}, 1) returning id`);
    const step = await one(sql`
      insert into sequence_steps (organization_id, sequence_version_id, position, step_type, name, delay_minutes, ai_instructions)
      values (${o.org}, ${version}, 1, 'reply', 'Step 1', 0, 'Write a short note.') returning id`);
    await sql`update sequence_versions set status = 'published', published_at = now() where id = ${version}`;
    const run = await one(sql`
      insert into sequence_runs (organization_id, record_id, conversation_id, sequence_id, sequence_version_id, reply_type_id, status, started_by, trigger_message_id, last_inbound_at_start)
      values (${o.org}, ${record}, ${conversation}, ${sequence}, ${version}, ${o.sub}, 'completed', 'ai_assignment', ${inbound}, now()) returning id`);
    await sql`
      insert into sequence_step_runs (organization_id, sequence_run_id, sequence_step_id, status, due_at, draft_id, sent_message_id, expected_context_version)
      values (${o.org}, ${run}, ${step}, 'sent', now(), ${draft}, ${outbound}, 0)`;
    await sql`insert into events (organization_id, person_id, record_id, event_type, actor_type) values (${o.org}, ${person}, ${record}, 'reply_type.changed', 'system')`;
    await sql`insert into events (organization_id, person_id, event_type, actor_type) values (${o.org}, ${person}, 'lifecycle.converted', 'system')`;
    await sql`insert into notes (organization_id, person_id, record_id, body) values (${o.org}, ${person}, ${record}, 'on the record')`;
    await sql`insert into notes (organization_id, person_id, body) values (${o.org}, ${person}, 'on the person')`;
    await sql`insert into tasks (organization_id, person_id, record_id, name) values (${o.org}, ${person}, ${record}, 'call')`;
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, reason, source, set_at) values (${o.org}, ${person}, true, 'asked', 'human', now())`;
    await sql`
      insert into identity_exceptions (organization_id, channel, account_ref, source_event_key, reason, status, resolved_person_id, resolved_at)
      values (${o.org}, 'email', ${box}, ${`ev-${t}`}, 'unknown sender', 'resolved', ${person}, now())`;
    const enrollment = await one(sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${o.org}, ${o.regular}, ${person}, 'email', 'completed') returning id`);
    for (const stepNumber of [1, 2]) {
      await sql`
        insert into sends (organization_id, kind, enrollment_id, step_number, channel, status, mailbox_id, claimed_at, sent_at)
        values (${o.org}, 'campaign', ${enrollment}, ${stepNumber}, 'email', 'sent', ${o.mailbox}, now() - interval '30 days', now() - interval '30 days')`;
    }
    const won = await closedDeal(o, person, "won", `${label} renewal`);
    const lost = await closedDeal(o, person, "lost", `${label} pilot`);
    let privateConversation: string | null = null;
    if (opts.privateThread) {
      const privateRecord = await one(sql`insert into records (organization_id, person_id, reply_type_set_id) values (${o.org}, ${person}, ${o.pipeline2}) returning id`);
      privateConversation = await one(sql`
        insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id) values (${o.org}, ${privateRecord}, 'linkedin', ${`li-${t}`}, ${o.personal}) returning id`);
      await sql`
        insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${o.org}, ${privateConversation}, 'linkedin', ${`li-${t}`}, 'inbound', ${`li-in-${t}`}, 'private hello', now())`;
    }
    return { person, email, record, conversation, inbound, won, lost, privateConversation };
  }

  async function closedDeal(o: Org, personId: string, kind: "won" | "lost", title: string) {
    const created = await deals.createDealForContact(dealsDeps(), o.actors.admin, personId, { title, idempotencyKey: `deal-${kind}-${personId}` });
    const [{ id: stageId }] = await sql`select id from deal_stages where organization_id = ${o.org} and kind = ${kind} order by position limit 1`;
    await deals.moveDealStage(dealsDeps(), o.actors.admin, created.dealId, { stageId, expectedVersion: 0, lostReason: kind === "lost" ? "budget" : null });
    return created.dealId;
  }

  async function openDeal(o: Org, personId: string, title: string) {
    return (await deals.createDealForContact(dealsDeps(), o.actors.admin, personId, { title, idempotencyKey: `deal-open-${personId}` })).dealId;
  }

  /** Rows that point at the person, per table the delete clears. */
  async function rowsOf(o: Org, person: string) {
    const recs = sql`(select id from records where person_id = ${person})`;
    const convs = sql`(select id from conversations where record_id in ${recs})`;
    const [row] = await sql`
      select
        (select count(*) from people where id = ${person})::int as people,
        (select count(*) from records where person_id = ${person})::int as records,
        (select count(*) from conversations where id in ${convs})::int as conversations,
        (select count(*) from messages where conversation_id in ${convs})::int as messages,
        (select count(*) from reply_type_picks where record_id in ${recs})::int as classifications,
        (select count(*) from drafts where record_id in ${recs})::int as drafts,
        (select count(*) from sequence_runs where record_id in ${recs})::int as sequence_runs,
        (select count(*) from events where person_id = ${person} or record_id in ${recs})::int as events,
        (select count(*) from contact_policies where person_id = ${person})::int as policies,
        (select count(*) from notes where person_id = ${person})::int as notes,
        (select count(*) from tasks where person_id = ${person})::int as tasks,
        (select count(*) from deals where person_id = ${person})::int as deals,
        (select count(*) from campaign_enrollments where person_id = ${person})::int as enrollments,
        (select count(*) from sends s join campaign_enrollments e on e.id = s.enrollment_id where e.person_id = ${person})::int as sends,
        (select count(*) from lead_ccs where person_id = ${person})::int as lead_ccs`;
    return row as Record<string, number>;
  }

  const expectedOf = (preview: ContactDeletePreview) => ({
    deals: preview.counts.deals.won + preview.counts.deals.lost,
    notes: preview.counts.notes,
    tasks: preview.counts.tasks,
    events: preview.counts.events,
    conversations: preview.counts.conversations,
    messages: preview.counts.messages,
    sends: preview.counts.sends,
  });

  const reasons = (preview: ContactDeletePreview) => preview.blockers.map((b) => b.reason);

  async function rejection(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected a rejection");
  }

  it("deletes the contact with every row of theirs, keeps the email suppressed, and touches no other person or organization", async () => {
    const o = await organization();
    const companyId = await one(sql`insert into companies (organization_id, domain, name) values (${o.org}, ${`acme-${o.tag}.test`}, 'Acme') returning id`);
    const target = await full(o, "target", { companyId });
    const neighbour = await full(o, "neighbour");
    // A cc of the neighbour that the target's message carried goes with that message (risk 3).
    await sql`insert into lead_ccs (organization_id, person_id, email, source_message_id) values (${o.org}, ${neighbour.person}, ${`cc-${o.tag}@lead.test`}, ${target.inbound})`;
    const elsewhere = await organization();
    const stranger = await full(elsewhere, "stranger");
    const neighbourBefore = await rowsOf(o, neighbour.person);
    const strangerBefore = await rowsOf(elsewhere, stranger.person);

    const preview = await app.previewContactDelete(deps, o.actors.admin, target.person);
    expect(preview).toEqual({
      person: { id: target.person, fullName: "target", email: target.email, linkedinUrl: null, doNotContact: true },
      counts: { deals: { won: 1, lost: 1, wonTitles: ["target renewal"] }, notes: 2, tasks: 1, events: preview.counts.events, conversations: 1, messages: 2, campaigns: 1, sends: 2 },
      blockers: [],
      suppressionKept: true,
      linkedinOnlyBlock: false,
      hiddenExcluded: false,
    });
    // Two seeded lines plus the deals' own history.
    expect(preview.counts.events).toBeGreaterThan(2);

    let switchAfterPurge: boolean | null = null;
    const watched: ContactDeleteDeps = {
      ...deps,
      handling: {
        ...deps.handling,
        purge: async (tx, org, personId) => {
          const result = await deps.handling.purge(tx, org, personId);
          switchAfterPurge = await purgeSwitchIsOn(tx);
          return result;
        },
      },
    };
    const result = await app.deleteContact(watched, o.actors.admin, target.person, { expected: expectedOf(preview) });
    expect(result).toEqual({ deleted: preview.counts });
    expect(switchAfterPurge).toBe(false);

    expect(Object.values(await rowsOf(o, target.person)).every((n) => n === 0)).toBe(true);
    const neighbourAfter = await rowsOf(o, neighbour.person);
    expect(neighbourAfter).toEqual({ ...neighbourBefore, lead_ccs: 0 });
    expect(await rowsOf(elsewhere, stranger.person)).toEqual(strangerBefore);

    const [suppression] = await sql`select reason, note from suppression_list where organization_id = ${o.org} and email = ${target.email}`;
    expect(suppression).toEqual({ reason: "manual", note: "Deleted while marked do not contact." });
    const [exception] = await sql`select status, resolved_person_id, resolved_at from identity_exceptions where organization_id = ${o.org} and source_event_key = ${`ev-${o.tag}-target`}`;
    expect(exception).toMatchObject({ status: "resolved", resolved_person_id: null });
    expect(exception.resolved_at).not.toBeNull();
    const [company] = await sql`select crm_listed_at, version from companies where id = ${companyId}`;
    expect(company.crm_listed_at).not.toBeNull();
    expect(company.version).toBe(1);

    const [audit] = await sql`select action, entity_type, entity_id, actor_user_id, meta from audit_log where organization_id = ${o.org} and action = 'person.deleted'`;
    expect(audit).toMatchObject({ action: "person.deleted", entity_type: "person", entity_id: target.person, actor_user_id: o.actors.admin.userId });
    expect(audit.meta).toEqual({ lifecycle: "contact", counts: { ...preview.counts, deals: { won: 1, lost: 1 } }, suppressionKept: true });
    const metaText = JSON.stringify(audit.meta);
    for (const secret of ["target", target.email]) expect(metaText).not.toContain(secret);

    // A repeat after success finds no contact.
    expect(await rejection(app.deleteContact(deps, o.actors.admin, target.person, { expected: expectedOf(preview) }))).toBeInstanceOf(NotFoundError);
  });

  it("blocks on an open deal and names it, and deletes nothing", async () => {
    const o = await organization();
    const { person } = await bare(o, "open");
    const dealId = await openDeal(o, person, "Big order");
    const preview = await app.previewContactDelete(deps, o.actors.member, person);
    expect(preview.blockers).toEqual([{ reason: "open_deals", deals: [{ id: dealId, title: "Big order", stageName: "New", stageKind: "open" }] }]);

    const error = await rejection(app.deleteContact(deps, o.actors.member, person, { expected: expectedOf(preview) }));
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toEqual({ code: "contact_blocked", blockers: preview.blockers });
    expect((await rowsOf(o, person)).people).toBe(1);
    expect((await rowsOf(o, person)).deals).toBe(1);
  });

  it("blocks on a send in flight, a recent campaign send and a recent LinkedIn invitation", async () => {
    const o = await organization();
    const enrollmentOf = async (personId: string, channel: "email" | "linkedin") => {
      const campaign = await one(sql`insert into campaigns (organization_id, channel, name) values (${o.org}, ${channel}, ${`C ${personId}`}) returning id`);
      return one(sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${o.org}, ${campaign}, ${personId}, ${channel}, 'completed') returning id`);
    };
    const send = async (enrollment: string, channel: "email" | "linkedin", status: string, claimedAgoMs: number) =>
      sql`
        insert into sends (organization_id, kind, enrollment_id, step_number, channel, status, mailbox_id, linkedin_account_id, claimed_at)
        values (${o.org}, 'campaign', ${enrollment}, 1, ${channel}, ${status}, ${channel === "email" ? o.mailbox : null}, ${channel === "linkedin" ? o.account : null},
                ${new Date(Date.now() - claimedAgoMs).toISOString()})`;

    const inFlight = await bare(o, "inflight");
    await send(await enrollmentOf(inFlight.person, "email"), "email", "sending", 3 * DAY);
    expect(reasons(await app.previewContactDelete(deps, o.actors.member, inFlight.person))).toEqual(["send_in_flight"]);

    const recent = await bare(o, "recent");
    await send(await enrollmentOf(recent.person, "email"), "email", "sent", 23 * HOUR);
    const recentPreview = await app.previewContactDelete(deps, o.actors.member, recent.person);
    expect(reasons(recentPreview)).toEqual(["recent_send"]);
    expect(recentPreview.blockers[0]).toEqual({ reason: "recent_send", until: expect.any(Date) });

    const invited = await bare(o, "invited", { linkedin: true });
    await send(await enrollmentOf(invited.person, "linkedin"), "linkedin", "sent", 6 * DAY);
    expect(reasons(await app.previewContactDelete(deps, o.actors.member, invited.person))).toEqual(["recent_invite"]);

    const old = await bare(o, "old", { linkedin: true });
    await send(await enrollmentOf(old.person, "linkedin"), "linkedin", "sent", 8 * DAY);
    const oldPreview = await app.previewContactDelete(deps, o.actors.member, old.person);
    expect(oldPreview.blockers).toEqual([]);
    await app.deleteContact(deps, o.actors.member, old.person, { expected: expectedOf(oldPreview) });
    expect((await rowsOf(o, old.person)).people).toBe(0);
  });

  it("blocks on an AI job with a live lease; a running job whose lease ran out does not block and goes with the contact", async () => {
    const o = await organization();
    const live = await full(o, "live");
    // The classification job of the inbound message runs again and holds a fresh lease.
    await sql`update ai_jobs set status = 'running', completed_at = null, locked_at = now(), locked_by = 'worker', started_at = now() where entity_id = ${live.inbound}`;
    expect(reasons(await app.previewContactDelete(deps, o.actors.admin, live.person))).toEqual(["ai_job_running"]);

    const stale = await full(o, "stale");
    const job = await one(sql`
      update ai_jobs set status = 'running', completed_at = null, locked_at = now() - interval '1 day', locked_by = 'worker', started_at = now() - interval '1 day'
      where entity_id = ${stale.inbound} returning id`);
    const preview = await app.previewContactDelete(deps, o.actors.admin, stale.person);
    expect(preview.blockers).toEqual([]);
    await app.deleteContact(deps, o.actors.admin, stale.person, { expected: expectedOf(preview) });
    expect(await sql`select id from ai_jobs where id = ${job}`).toEqual([]);
  });

  it("blocks a member on another member's personal campaign and private thread, leaves them out of the counts, and lets an admin delete", async () => {
    const o = await organization();
    const target = await full(o, "private", { privateThread: true });
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${o.org}, ${o.personal}, ${target.person}, 'linkedin', 'completed')`;

    const member = await app.previewContactDelete(deps, o.actors.member, target.person);
    expect(reasons(member)).toEqual(["personal_campaign_sends", "private_conversation"]);
    expect(member.hiddenExcluded).toBe(true);
    expect(member.counts).toMatchObject({ conversations: 1, messages: 2, campaigns: 1 });

    // The campaign's creator sees both and is not blocked.
    const creator = await app.previewContactDelete(deps, o.actors.other, target.person);
    expect(creator.blockers).toEqual([]);
    expect(creator.hiddenExcluded).toBe(false);

    const admin = await app.previewContactDelete(deps, o.actors.admin, target.person);
    expect(admin.blockers).toEqual([]);
    expect(admin.hiddenExcluded).toBe(false);
    expect(admin.counts).toMatchObject({ conversations: 2, messages: 3, campaigns: 2 });

    const error = await rejection(app.deleteContact(deps, o.actors.member, target.person, { expected: expectedOf(member) }));
    expect((error as ConflictError).details?.code).toBe("contact_blocked");
    await app.deleteContact(deps, o.actors.admin, target.person, { expected: expectedOf(admin) });
    expect(Object.values(await rowsOf(o, target.person)).every((n) => n === 0)).toBe(true);
    expect(await sql`select id from conversations where id = ${target.privateConversation}`).toEqual([]);
  });

  it("keeps an existing suppression row as it is, and blocks nothing for an unmarked contact", async () => {
    const o = await organization();
    const unmarked = await bare(o, "unmarked");
    const preview = await app.previewContactDelete(deps, o.actors.member, unmarked.person);
    expect(preview).toMatchObject({ suppressionKept: false, linkedinOnlyBlock: false });
    await app.deleteContact(deps, o.actors.member, unmarked.person, { expected: expectedOf(preview) });
    expect(await sql`select email from suppression_list where organization_id = ${o.org} and email = ${unmarked.email}`).toEqual([]);

    const unsubscribed = await bare(o, "unsubscribed");
    await sql`insert into suppression_list (organization_id, email, reason, note) values (${o.org}, ${unsubscribed.email}, 'unsubscribed', 'link')`;
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, reason, source, set_at) values (${o.org}, ${unsubscribed.person}, true, 'asked', 'human', now())`;
    const kept = await app.previewContactDelete(deps, o.actors.member, unsubscribed.person);
    expect(kept.suppressionKept).toBe(true);
    await app.deleteContact(deps, o.actors.member, unsubscribed.person, { expected: expectedOf(kept) });
    expect(await sql`select reason, note from suppression_list where organization_id = ${o.org} and email = ${unsubscribed.email}`).toEqual([{ reason: "unsubscribed", note: "link" }]);

    const linkedinOnly = await bare(o, "linkedin-only", { linkedin: true, email: null });
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, reason, source, set_at) values (${o.org}, ${linkedinOnly.person}, true, 'asked', 'human', now())`;
    expect(await app.previewContactDelete(deps, o.actors.member, linkedinOnly.person)).toMatchObject({ suppressionKept: false, linkedinOnlyBlock: true });
  });

  it("stamps a company whose last contact went, and leaves a company with another contact unstamped", async () => {
    const o = await organization();
    const lonely = await one(sql`insert into companies (organization_id, domain, name) values (${o.org}, ${`lonely-${o.tag}.test`}, 'Lonely') returning id`);
    const busy = await one(sql`insert into companies (organization_id, domain, name) values (${o.org}, ${`busy-${o.tag}.test`}, 'Busy') returning id`);
    const a = await bare(o, "a", { companyId: lonely });
    const b = await bare(o, "b", { companyId: busy });
    await bare(o, "c", { companyId: busy });
    for (const p of [a, b]) await app.deleteContact(deps, o.actors.member, p.person, { expected: expectedOf(await app.previewContactDelete(deps, o.actors.member, p.person)) });
    const rows = await sql`select id, crm_listed_at from companies where id in (${lonely}, ${busy})`;
    expect(rows.find((r) => r.id === lonely)?.crm_listed_at).not.toBeNull();
    expect(rows.find((r) => r.id === busy)?.crm_listed_at).toBeNull();
  });

  it("answers 404, not_a_contact, counts_changed, 422 for a missing count, and try_again past the statement timeout", async () => {
    const o = await organization();
    const elsewhere = await organization();
    const { person } = await bare(o, "codes");
    const preview = await app.previewContactDelete(deps, o.actors.member, person);
    const expected = expectedOf(preview);

    expect(await rejection(app.previewContactDelete(deps, elsewhere.actors.admin, person))).toBeInstanceOf(NotFoundError);
    expect(await rejection(app.deleteContact(deps, elsewhere.actors.admin, person, { expected }))).toBeInstanceOf(NotFoundError);
    expect(await rejection(app.deleteContact(deps, o.actors.member, "not-a-uuid", { expected }))).toBeInstanceOf(NotFoundError);

    const lead = await one(sql`insert into people (organization_id, email, full_name) values (${o.org}, ${`lead-${o.tag}@lead.test`}, 'Lena Lead') returning id`);
    const notContact = await rejection(app.previewContactDelete(deps, o.actors.member, lead));
    expect(notContact).toBeInstanceOf(ConflictError);
    expect((notContact as ConflictError).message).toBe("Lena Lead is a lead. Delete leads from the lead page.");
    expect((notContact as ConflictError).details).toEqual({ code: "not_a_contact" });

    const missing = await rejection(app.deleteContact(deps, o.actors.member, person, { expected: { ...expected, sends: undefined } }));
    expect(missing).toBeInstanceOf(ValidationError);
    expect((missing as ValidationError).message).toBe("Send the counts the delete dialog showed.");
    expect(await rejection(app.deleteContact(deps, o.actors.member, person, { expected: { ...expected, notes: "1.5" } }))).toBeInstanceOf(ValidationError);

    const changed = await rejection(app.deleteContact(deps, o.actors.member, person, { expected: { ...expected, notes: expected.notes + 1 } }));
    expect((changed as ConflictError).message).toBe("codes changed while this was open. Check the new counts and confirm again.");
    expect((changed as ConflictError).details).toEqual({ code: "counts_changed", counts: preview.counts });

    // A statement that runs past the timeout stands in for a contact with a very long history.
    const { sql: dsql } = await import("drizzle-orm");
    const slow: ContactDeleteDeps = {
      ...deps,
      people: {
        ...deps.people,
        limitStatements: async (tx) => {
          await tx.execute(dsql.raw("set local statement_timeout = '20ms'"));
          await tx.execute(dsql`select pg_sleep(0.2)`);
        },
      },
    };
    const timedOut = await rejection(app.deleteContact(slow, o.actors.member, person, { expected }));
    expect((timedOut as ConflictError).details).toEqual({ code: "try_again" });
    expect((await rowsOf(o, person)).people).toBe(1);

    await app.deleteContact(deps, o.actors.member, person, { expected });
    expect((await rowsOf(o, person)).people).toBe(0);
  });
});
