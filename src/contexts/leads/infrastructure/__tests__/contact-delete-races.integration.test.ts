import { sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { lockRetryStats } from "@/platform/db/errors";
import { ConflictError, NotFoundError } from "@/shared/errors";
import { bootDealsKit, holdLocks, sqlState, waitForLockWaiters, type DealsKit, type DealsOrg } from "@/test-support/deals-test-kit";
import type { ContactDeleteDeps, ContactDeletePreview } from "../../application/contact-delete";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Contact delete races of "Contacts and Companies CRUD" in docs/decisions.md, on two connections with the real writers:
 *   a deal insert for the contact, before and after the delete takes the people row;
 *   a reply that lands between the dialog and the delete, and a message insert that holds a conversation of the contact;
 *   Mark do not contact, with and without a `contact_policies` row;
 *   `suppressEmail` (its run stop meets the records) while the delete holds the records.
 * Where the delete must stop at a chosen statement, a port wrapper pauses it in process. No case may lose state.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("contact delete races", () => {
  let kit: DealsKit;
  let app: typeof import("../../application/contact-delete");
  let deps: ContactDeleteDeps;
  let deals: typeof import("@/contexts/deals/application/deals");
  let dealsDeps: typeof import("@/contexts/deals/infrastructure/deals-composition").dealsDeps;
  let conversations: typeof import("@/contexts/conversations/infrastructure/composition");
  let crmStore: typeof import("@/contexts/conversations/infrastructure/drizzle-crm-store").drizzleCrmStore;
  let suppression: typeof import("@/contexts/outreach/infrastructure/drizzle-outreach-store").drizzleSuppressionStore;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    app = await import("../../application/contact-delete");
    deps = (await import("@/composition/person-lifecycle")).contactDeleteDeps;
    deals = await import("@/contexts/deals/application/deals");
    dealsDeps = (await import("@/contexts/deals/infrastructure/deals-composition")).dealsDeps;
    conversations = await import("@/contexts/conversations/infrastructure/composition");
    crmStore = (await import("@/contexts/conversations/infrastructure/drizzle-crm-store")).drizzleCrmStore;
    suppression = (await import("@/contexts/outreach/infrastructure/drizzle-outreach-store")).drizzleSuppressionStore;
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const settle = <T,>(run: Promise<T>) => run.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null as T | null, error }));

  const expectedOf = (preview: ContactDeletePreview) => ({
    deals: preview.counts.deals.won + preview.counts.deals.lost,
    notes: preview.counts.notes,
    tasks: preview.counts.tasks,
    events: preview.counts.events,
    conversations: preview.counts.conversations,
    messages: preview.counts.messages,
    sends: preview.counts.sends,
  });

  /** A reply from an unknown sender, made a contact: a record, a public thread and one inbound message. */
  async function repliedContact(f: DealsOrg) {
    const lead = await f.ingest();
    await kit.sql`update people set lifecycle = 'contact', converted_at = now() where id = ${lead.personId}`;
    return lead;
  }

  const people = (personId: string) => kit.sql`select id from people where id = ${personId}`.then((rows) => rows.length);

  /** `deps` with one port that stops after its first real call until `resume`. */
  function pauseAt<K extends "people" | "handling", M extends keyof ContactDeleteDeps[K]>(part: K, method: M) {
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let calls = 0;
    const real = (deps[part] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method as string];
    const wrapped = {
      ...deps,
      [part]: {
        ...(deps[part] as object),
        [method]: async (...args: unknown[]) => {
          const result = await real(...args);
          calls += 1;
          if (calls === 1) {
            reached();
            await resumed;
          }
          return result;
        },
      },
    } as ContactDeleteDeps;
    return { deps: wrapped, paused, resume, calls: () => calls };
  }

  it("a deal insert that commits while the delete waits for the people row blocks the delete with that deal", async () => {
    const f = await kit.organization();
    const contact = await f.person({ contact: true, name: "Dana Deal" });
    // A template deal of another contact gives the holder a valid stage to copy.
    const other = await f.person({ contact: true });
    const template = (await deals.createDealForContact(dealsDeps(), f.owner, other, { title: "Template", idempotencyKey: `tpl-${f.tag}` })).dealId;
    const preview = await app.previewContactDelete(deps, f.member, contact);
    expect(preview.blockers).toEqual([]);

    // The holder inserts a deal for the contact and keeps it uncommitted: its foreign key check holds the people row in key share.
    let dealId = "";
    const holder = await holdLocks(TEST_DATABASE_URL ?? "", async (tx) => {
      const [row] = await tx`
        insert into deals (organization_id, person_id, stage_id, stage_kind, title, created_by)
        select organization_id, ${contact}, stage_id, stage_kind, 'Raced deal', created_by from deals where id = ${template}
        returning id`;
      dealId = row.id;
    });
    // The delete waits on the people row; a longer wait than the held-lock timeout keeps the order fixed for the test.
    const patient: ContactDeleteDeps = {
      ...deps,
      handling: {
        ...deps.handling,
        lockPersonForDelete: async (tx, org, id) => {
          await deps.handling.lockPersonForDelete(tx, org, id);
          await tx.execute(dsql.raw("set local lock_timeout = '10s'"));
        },
      },
    };
    const deleting = settle(app.deleteContact(patient, f.member, contact, { expected: expectedOf(preview) }));
    await waitForLockWaiters(kit.sql, 1);
    await holder.release();
    const deleted = await deleting;
    expect(sqlState(deleted.error)).toBeUndefined();
    expect(deleted.error).toBeInstanceOf(ConflictError);
    expect((deleted.error as ConflictError).details).toEqual({
      code: "contact_blocked",
      blockers: [{ reason: "open_deals", deals: [{ id: dealId, title: "Raced deal", stageName: "New", stageKind: "open" }] }],
    });
    expect(await people(contact)).toBe(1);
  }, 30_000);

  it("a deal insert that waits on the people row the delete holds answers 404 once the delete commits", async () => {
    const f = await kit.organization();
    const contact = await f.person({ contact: true });
    const preview = await app.previewContactDelete(deps, f.member, contact);
    const gate = pauseAt("people", "lock");
    const deleting = settle(app.deleteContact(gate.deps, f.member, contact, { expected: expectedOf(preview) }));
    await gate.paused;
    const creating = settle(deals.createDealForContact(dealsDeps(), f.owner, contact, { title: "Too late", idempotencyKey: `late-${f.tag}` }));
    await waitForLockWaiters(kit.sql, 1);
    gate.resume();
    const [deleted, created] = await Promise.all([deleting, creating]);
    expect(deleted.error).toBeNull();
    expect(created.error).toBeInstanceOf(NotFoundError);
    expect((created.error as NotFoundError).message).toBe("This contact no longer exists.");
    expect(await people(contact)).toBe(0);
    expect(await kit.count("deals", f.org, `person_id = '${contact}'`)).toBe(0);
  }, 30_000);

  it("a reply that lands after the dialog opened answers counts_changed, and the delete with the new counts removes it", async () => {
    const f = await kit.organization();
    const lead = await repliedContact(f);
    const preview = await app.previewContactDelete(deps, f.member, lead.personId);
    expect(preview.counts.messages).toBe(1);
    await conversations.ingestInbound(f.mail({ from: lead.input.from, providerThreadId: lead.input.providerThreadId, inReplyTo: lead.input.rfcMessageId }));

    const changed = await settle(app.deleteContact(deps, f.member, lead.personId, { expected: expectedOf(preview) }));
    expect((changed.error as ConflictError).details).toMatchObject({ code: "counts_changed", counts: { messages: 2 } });
    expect(await kit.count("messages", f.org, `conversation_id = '${lead.conversationId}'`)).toBe(2);

    const fresh = (changed.error as ConflictError).details?.counts as ContactDeletePreview["counts"];
    await app.deleteContact(deps, f.member, lead.personId, { expected: expectedOf({ ...preview, counts: fresh }) });
    expect(await people(lead.personId)).toBe(0);
    expect(await kit.count("messages", f.org, `conversation_id = '${lead.conversationId}'`)).toBe(0);
  }, 30_000);

  it("a message insert that holds the contact's conversation makes the delete wait, then answer counts_changed: no message lands after the purge", async () => {
    const f = await kit.organization();
    const lead = await repliedContact(f);
    const preview = await app.previewContactDelete(deps, f.member, lead.personId);
    // The holder inserts a message into the thread and keeps it uncommitted: the insert holds the conversation in key share.
    const holder = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      select organization_id, id, channel, account_ref, 'inbound', ${`raced-${f.tag}`}, 'One more thing', now() from conversations where id = ${lead.conversationId}`);
    const deleting = settle(app.deleteContact(deps, f.member, lead.personId, { expected: expectedOf(preview) }));
    await waitForLockWaiters(kit.sql, 1);
    await holder.release();
    const deleted = await deleting;
    expect(sqlState(deleted.error)).toBeUndefined();
    expect((deleted.error as ConflictError).details).toMatchObject({ code: "counts_changed", counts: { messages: 2 } });
    expect(await kit.count("messages", f.org, `conversation_id = '${lead.conversationId}'`)).toBe(2);
    expect(await people(lead.personId)).toBe(1);
  }, 30_000);

  it("Mark do not contact without a contact_policies row waits on the people row and answers 404 once the delete commits", async () => {
    const f = await kit.organization();
    const contact = await f.person({ contact: true });
    const preview = await app.previewContactDelete(deps, f.member, contact);
    const gate = pauseAt("people", "lock");
    const deleting = settle(app.deleteContact(gate.deps, f.member, contact, { expected: expectedOf(preview) }));
    await gate.paused;
    const marking = settle(crmStore.setDoNotContact({ organizationId: f.org, actorUserId: f.member.userId, personId: contact, enabled: true, reason: "asked", now: new Date() }));
    await waitForLockWaiters(kit.sql, 1);
    gate.resume();
    const [deleted, marked] = await Promise.all([deleting, marking]);
    expect(deleted.error).toBeNull();
    expect(marked.error).toBeInstanceOf(NotFoundError);
    expect(await people(contact)).toBe(0);
    expect(await kit.count("contact_policies", f.org, `person_id = '${contact}'`)).toBe(0);
  }, 30_000);

  it("Mark do not contact holding the policy row while it waits for the records makes the delete give way; the retry sees the mark", async () => {
    const f = await kit.organization();
    const lead = await repliedContact(f);
    await kit.sql`insert into contact_policies (organization_id, person_id, do_not_contact, source) values (${f.org}, ${lead.personId}, false, null)`;
    const preview = await app.previewContactDelete(deps, f.member, lead.personId);
    expect(preview.suppressionKept).toBe(false);
    const retries = lockRetryStats.retries;

    // The delete stops after its first lock step, holding the records, their conversations and the advisory lock.
    const gate = pauseAt("handling", "lockPersonForDelete");
    const deleting = settle(app.deleteContact(gate.deps, f.member, lead.personId, { expected: expectedOf(preview) }));
    await gate.paused;
    // Do not contact takes its policy row, then waits for the records the delete holds.
    const marking = settle(crmStore.setDoNotContact({ organizationId: f.org, actorUserId: f.member.userId, personId: lead.personId, enabled: true, reason: "asked", now: new Date() }));
    await waitForLockWaiters(kit.sql, 1);
    gate.resume();
    const [deleted, marked] = await Promise.all([deleting, marking]);
    expect(marked.error).toBeNull();
    expect(lockRetryStats.retries).toBe(retries + 1);
    expect(gate.calls()).toBe(2);
    // The mark wrote a history line, so the retry reports the new counts; the next confirm deletes and keeps the email suppressed.
    expect((deleted.error as ConflictError).details).toMatchObject({ code: "counts_changed" });
    const fresh = (deleted.error as ConflictError).details?.counts as ContactDeletePreview["counts"];
    const done = await app.deleteContact(deps, f.member, lead.personId, { expected: expectedOf({ ...preview, counts: fresh }) });
    expect(done.deleted).toEqual(fresh);
    expect(await people(lead.personId)).toBe(0);
    expect(await kit.count("suppression_list", f.org, `email = '${lead.input.from.email.toLowerCase()}' and note = 'Deleted while marked do not contact.'`)).toBe(1);
  }, 30_000);

  it("suppressEmail racing a delete that holds the records: both commit, the person goes and the address stays suppressed", async () => {
    const f = await kit.organization();
    const lead = await f.ingest();
    await f.emailedBy(lead.personId);
    await f.cycle();
    expect(await kit.count("sequence_runs", f.org, "status = 'active'")).toBe(1);
    // The campaign email went out two days ago, so no recent send blocks the delete.
    await kit.sql`update campaign_enrollments set status = 'completed', next_send_at = null where person_id = ${lead.personId}`;
    await kit.sql`update sends set claimed_at = now() - interval '2 days' where enrollment_id in (select id from campaign_enrollments where person_id = ${lead.personId})`;
    await kit.sql`update people set lifecycle = 'contact', converted_at = now() where id = ${lead.personId}`;
    const preview = await app.previewContactDelete(deps, f.owner, lead.personId);
    expect(preview.blockers).toEqual([]);
    const retries = lockRetryStats.retries;

    const gate = pauseAt("handling", "lockPersonForDelete");
    const deleting = settle(app.deleteContact(gate.deps, f.owner, lead.personId, { expected: expectedOf(preview) }));
    await gate.paused;
    // suppressEmail adds the address and goes for the active run of the record the delete holds.
    const suppressing = settle(suppression.suppressEmail({ organizationId: f.org, email: lead.input.from.email, reason: "unsubscribed" }));
    await waitForLockWaiters(kit.sql, 1);
    gate.resume();
    const [suppressed, deleted] = await Promise.all([suppressing, deleting]);
    expect(sqlState(suppressed.error)).toBeUndefined();
    expect(suppressed.error).toBeNull();
    // Postgres decides which waiter meets the other first: either the delete commits and the suppression finds no run left, or
    // the delete gives way once and its retry runs after the suppression. Neither writer fails and nothing is lost.
    expect(lockRetryStats.retries - retries).toBeLessThanOrEqual(1);
    expect(gate.calls()).toBe(1 + lockRetryStats.retries - retries);
    // A retry after the run ended sees its history line and reports new counts; the next confirm deletes.
    if (deleted.error) {
      expect((deleted.error as ConflictError).details).toMatchObject({ code: "counts_changed" });
      const fresh = (deleted.error as ConflictError).details?.counts as ContactDeletePreview["counts"];
      await app.deleteContact(deps, f.owner, lead.personId, { expected: expectedOf({ ...preview, counts: fresh }) });
    }
    expect(await people(lead.personId)).toBe(0);
    expect(await kit.count("suppression_list", f.org, `email = '${lead.input.from.email.toLowerCase()}' and reason = 'unsubscribed'`)).toBe(1);
  }, 60_000);
});
