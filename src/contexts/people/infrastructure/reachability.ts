import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { contactPolicies, people, suppressionList } from "@/platform/db/schema";
import { DELETED_WHILE_MARKED_NOTE, reachability, suppressionKey, type Reachability, type ReadReachability, type SuppressionReason } from "../domain/reachability";

/*
 * Reachability. The people context owns `contact_policies` and `suppression_list` and is their one writer. The contexts
 * above call these functions inside their own transactions and run their own follow-through: outreach ends the
 * enrollments of a suppressed address, conversations ends runs and retires drafts for do not contact.
 */

const ALIAS = /^[a-z_][a-z0-9_]*$/;
const aliasOf = (person: string): string => {
  if (!ALIAS.test(person)) throw new Error(`Not a table alias: ${person}`);
  return person;
};

/**
 * SQL that is true when the `people` row named `person` in the enclosing query (its alias, or `people`) is marked do not
 * contact. Every list, queue and run check that asks reads it here.
 */
export const doNotContactSql = (person: string): SQL => {
  const p = aliasOf(person);
  return sql.raw(`exists (select 1 from contact_policies reach_cp where reach_cp.person_id = ${p}.id and reach_cp.organization_id = ${p}.organization_id and reach_cp.do_not_contact)`);
};

/** SQL that is true when the address of the `people` row named `person` sits on its organization's suppression list. */
export const suppressedSql = (person: string): SQL => {
  const p = aliasOf(person);
  return sql.raw(`exists (select 1 from suppression_list reach_sl where reach_sl.organization_id = ${p}.organization_id and reach_sl.email = lower(${p}.email))`);
};

/** Whether the person is marked do not contact. The send guards ask it right before a provider call. */
export async function isDoNotContact(handle: DbHandle, organizationId: string, personId: string): Promise<boolean> {
  const [row] = await handle
    .select({ doNotContact: contactPolicies.doNotContact })
    .from(contactPolicies)
    .where(and(eq(contactPolicies.organizationId, organizationId), eq(contactPolicies.personId, personId)));
  return row?.doNotContact ?? false;
}

/**
 * The reachability of a page of person ids, keyed by person id, in one query scoped to the organization: the person's
 * email and LinkedIn values, the do-not-contact flag (`contact_policies`) and the address's suppression entry
 * (`suppression_list`, stored lowercased). Lists, record pages, the deal page and the Inbox thread all read it here, so a
 * person shows the same reach everywhere. An unknown id or one of another organization has no entry.
 */
export const readReachability: ReadReachability = async (organizationId, personIds) => {
  const result = new Map<string, Reachability>();
  if (personIds.length === 0) return result;
  const ids = [...new Set(personIds)];

  const rows = await db
    .select({
      id: people.id,
      email: people.email,
      hasLinkedin: sql<boolean>`(${people.linkedinUrl} is not null or ${people.linkedinSlug} is not null)`,
      doNotContact: sql<boolean>`coalesce(${contactPolicies.doNotContact}, false)`,
      dncReason: contactPolicies.reason,
      dncSince: contactPolicies.setAt,
      suppressionReason: suppressionList.reason,
      suppressedSince: suppressionList.createdAt,
    })
    .from(people)
    .leftJoin(contactPolicies, and(eq(contactPolicies.personId, people.id), eq(contactPolicies.organizationId, people.organizationId)))
    .leftJoin(suppressionList, and(eq(suppressionList.organizationId, people.organizationId), eq(suppressionList.email, sql`lower(${people.email})`)))
    .where(and(eq(people.organizationId, organizationId), inArray(people.id, ids)));

  for (const row of rows) {
    result.set(
      row.id,
      reachability({
        doNotContact: row.doNotContact ? { reason: row.dncReason, since: row.dncSince } : null,
        email: row.email,
        suppression: row.suppressionReason ? { reason: row.suppressionReason, since: row.suppressedSince } : null,
        hasLinkedin: row.hasLinkedin,
      }),
    );
  }
  return result;
};

/**
 * Puts an address on the suppression list. An address already there keeps its row, reason and note. Returns the stored
 * form of the address and whether this call added it.
 */
export async function suppressAddressTx(
  tx: DbHandle,
  input: { organizationId: string; email: string; reason: SuppressionReason; note?: string | null; addedInSettings?: boolean },
): Promise<{ email: string; added: boolean }> {
  const email = suppressionKey(input.email);
  const inserted = await tx
    .insert(suppressionList)
    .values({ organizationId: input.organizationId, email, reason: input.reason, note: input.note ?? null, addedInSettings: input.addedInSettings ?? false })
    .onConflictDoNothing()
    .returning({ id: suppressionList.id });
  return { email, added: inserted.length > 0 };
}

/** Takes an address off the list. Only a row an owner or admin pasted on Settings, Suppression list can go. */
export async function removeSettingsSuppression(handle: DbHandle, organizationId: string, id: string): Promise<void> {
  await handle.delete(suppressionList).where(and(eq(suppressionList.organizationId, organizationId), eq(suppressionList.id, id), eq(suppressionList.addedInSettings, true)));
}

/** Whether the address is on the organization's suppression list. */
export async function isSuppressed(handle: DbHandle, organizationId: string, email: string | null): Promise<boolean> {
  const key = email ? suppressionKey(email) : "";
  if (!key) return false;
  const [row] = await handle.select({ id: suppressionList.id }).from(suppressionList).where(and(eq(suppressionList.organizationId, organizationId), eq(suppressionList.email, key)));
  return Boolean(row);
}

/**
 * The rule of every person delete: a person marked do not contact leaves their address on the suppression list, so a
 * later import of the same address stays unreachable. An existing suppression row stays as it is. The caller holds the
 * people's `contact_policies` rows or deletes them in the same transaction.
 */
export async function suppressDoNotContactAddressesTx(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<void> {
  if (personIds.length === 0) return;
  const ids = sql.join(personIds.map((id) => sql`${id}::uuid`), sql`, `);
  await tx.execute(sql`
    insert into suppression_list (organization_id, email, reason, note)
    select distinct p.organization_id, lower(p.email), 'manual', ${DELETED_WHILE_MARKED_NOTE}
    from people p
    join contact_policies cp on cp.person_id = p.id and cp.organization_id = p.organization_id
    -- lower(p.email) is the form every suppression lookup compares with a person's address.
    where p.organization_id = ${organizationId} and p.id in (${ids}) and cp.do_not_contact and p.email is not null
    on conflict (organization_id, email) do nothing`);
}

/** A person's `contact_policies` row `FOR UPDATE`. A person without a row is not marked. */
export async function lockDoNotContactTx(tx: DbHandle, organizationId: string, personId: string): Promise<{ doNotContact: boolean }> {
  const [row] = await tx
    .select({ doNotContact: contactPolicies.doNotContact })
    .from(contactPolicies)
    .where(and(eq(contactPolicies.organizationId, organizationId), eq(contactPolicies.personId, personId)))
    .for("update");
  return { doNotContact: row?.doNotContact ?? false };
}

/**
 * Sets or clears a person's do not contact flag. Takes the `dnc:{personId}` advisory lock first, so set and clear of one
 * person run one at a time, then writes the policy row. Returns the policy before the call and whether the call changed it.
 */
export async function writeDoNotContactTx(
  tx: DbHandle,
  input: { organizationId: string; personId: string; enabled: boolean; reason: string | null; now: Date },
): Promise<{ changed: boolean; previous: { doNotContact: boolean; reason: string | null } | null }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dnc:${input.personId}`}, 0))`);
  const [previous = null] = await tx
    .select({ doNotContact: contactPolicies.doNotContact, reason: contactPolicies.reason })
    .from(contactPolicies)
    .where(and(eq(contactPolicies.personId, input.personId), eq(contactPolicies.organizationId, input.organizationId)));
  if (input.enabled === Boolean(previous?.doNotContact)) return { changed: false, previous };
  if (!input.enabled) {
    await tx
      .update(contactPolicies)
      .set({ doNotContact: false, clearedAt: input.now, reason: input.reason, updatedAt: input.now })
      .where(eq(contactPolicies.personId, input.personId));
    return { changed: true, previous };
  }
  await tx
    .insert(contactPolicies)
    .values({ personId: input.personId, organizationId: input.organizationId, doNotContact: true, reason: input.reason, source: "human", setAt: input.now, clearedAt: null })
    .onConflictDoUpdate({ target: contactPolicies.personId, set: { doNotContact: true, reason: input.reason, source: "human", setAt: input.now, clearedAt: null, updatedAt: input.now } });
  return { changed: true, previous };
}

/** Deletes the people's `contact_policies` rows, before the people rows go. */
export async function deleteDoNotContactTx(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<void> {
  if (personIds.length === 0) return;
  await tx.delete(contactPolicies).where(and(eq(contactPolicies.organizationId, organizationId), inArray(contactPolicies.personId, [...personIds])));
}
