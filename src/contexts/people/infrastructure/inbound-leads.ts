import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { people } from "@/platform/db/schema";
import { canonicalProfileUrl } from "../domain/linkedin-url";
import { splitFullName } from "../domain/normalize";

/*
 * Unknown senders. A message from someone the organization has no person for creates a lead (`source = 'inbound'`),
 * and conversations files the message under it. People owns the row and the rule: an existing person is returned
 * untouched, and a concurrent insert of the same address or slug resolves to the row that won.
 */

const inboundLead = (organizationId: string, name: string | null) => {
  const { first, last } = splitFullName(name);
  // An unknown sender is a lead until a person creates a deal from them.
  return { organizationId, fullName: name, firstName: first, lastName: last, source: "inbound", lifecycle: "lead" as const };
};

/** The person with this address (case-insensitive), or a new inbound lead. */
export async function findOrCreateLeadByEmailTx(tx: DbHandle, organizationId: string, from: { email: string; name: string | null }): Promise<{ id: string; created: boolean }> {
  const find = async () =>
    (await tx.select({ id: people.id }).from(people).where(and(eq(people.organizationId, organizationId), sql`lower(${people.email}) = ${from.email.toLowerCase()}`)))[0]?.id;
  const existing = await find();
  if (existing) return { id: existing, created: false };
  const [created] = await tx
    .insert(people)
    .values({ ...inboundLead(organizationId, from.name), email: from.email })
    .onConflictDoNothing()
    .returning({ id: people.id });
  if (created) return { id: created.id, created: true };
  return { id: (await find()) as string, created: false };
}

/** The person with this public LinkedIn slug, or a new inbound lead with its canonical profile URL. */
export async function findOrCreateLeadByLinkedInTx(tx: DbHandle, organizationId: string, from: { slug: string; name: string | null }): Promise<{ id: string; created: boolean }> {
  const find = async () => (await tx.select({ id: people.id }).from(people).where(and(eq(people.organizationId, organizationId), eq(people.linkedinSlug, from.slug))))[0]?.id;
  const existing = await find();
  if (existing) return { id: existing, created: false };
  const [created] = await tx
    .insert(people)
    .values({ ...inboundLead(organizationId, from.name), linkedinSlug: from.slug, linkedinUrl: canonicalProfileUrl(from.slug) })
    .onConflictDoNothing()
    .returning({ id: people.id });
  if (created) return { id: created.id, created: true };
  return { id: (await find()) as string, created: false };
}
