import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { contactPolicies, people, suppressionList } from "@/platform/db/schema";
import { reachability, type Reachability, type ReadReachability } from "../domain/reachability";

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
