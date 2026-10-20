import { and, eq, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { CONVERSION_LOCK_TIMEOUT, setLockTimeout } from "@/platform/db/person-locks";
import { people } from "@/platform/db/schema";
import type { ContactStore, IdentityMatch } from "../application/add-contact";
import { resolveCompanyDomain } from "./company-domain-store";

/*
 * The leads side of Add contact and Make contact. The insert relies on the unique indexes (email, LinkedIn slug, creation key)
 * to decide a race: `ON CONFLICT DO NOTHING` returns no row, and the use case reads who won.
 */

const matchColumns = {
  personId: people.id,
  name: people.fullName,
  email: people.email,
  lifecycle: people.lifecycle,
  linkedinUrl: people.linkedinUrl,
};

const asMatch = (row: { personId: string; name: string | null; email: string | null; lifecycle: string; linkedinUrl: string | null } | undefined): IdentityMatch | null =>
  row ? { ...row, lifecycle: row.lifecycle === "contact" ? "contact" : "lead" } : null;

export const drizzleContactStore: ContactStore = {
  async byCreationKey(tx, organizationId, key) {
    const [row] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.organizationId, organizationId), eq(people.creationKey, key)));
    return row?.id ?? null;
  },

  async matchByEmail(tx, organizationId, email) {
    const [row] = await tx
      .select(matchColumns)
      .from(people)
      .where(and(eq(people.organizationId, organizationId), sql`lower(${people.email}) = ${email.toLowerCase()}`));
    return asMatch(row);
  },

  async matchBySlug(tx, organizationId, slug) {
    const [row] = await tx
      .select(matchColumns)
      .from(people)
      .where(and(eq(people.organizationId, organizationId), eq(people.linkedinSlug, slug)));
    return asMatch(row);
  },

  resolveCompany: resolveCompanyDomain,

  async insertContact(tx, organizationId, row) {
    const [inserted] = await tx
      .insert(people)
      .values({ organizationId, ...row, lifecycle: "contact", source: "manual", createdAt: row.convertedAt, updatedAt: row.convertedAt })
      .onConflictDoNothing()
      .returning({ id: people.id });
    return inserted?.id ?? null;
  },
};

/** The transaction of a person use case: the conversion's lock timeout while it holds nothing of the person. */
export function personTransaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setLockTimeout(tx, CONVERSION_LOCK_TIMEOUT);
    return fn(tx);
  });
}
