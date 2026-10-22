import { and, eq, inArray, sql } from "drizzle-orm";
import { inTransaction } from "@/platform/db/client";
import { people } from "@/platform/db/schema";
import type { FoundPeopleStore } from "../application/found-people";
import { canonicalProfileUrl } from "../domain/linkedin-url";
import { planFoundPeople, type ExistingFoundPerson } from "../domain/found-people";

const CHUNK = 500;

export const drizzleFoundPeopleStore: FoundPeopleStore = {
  async upsert({ organizationId, source, candidates, tx: outer }) {
    return inTransaction(outer, async (tx) => {
      // The CSV import takes the same lock, so the two cannot insert one profile at once.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"leads-import:" + organizationId}, 0))`);

      const memberIdOf = sql<string | null>`${people.raw}->>'linkedin_member_id'`;
      const columns = { id: people.id, linkedinSlug: people.linkedinSlug, memberId: memberIdOf, firstName: people.firstName, lastName: people.lastName, fullName: people.fullName, title: people.title };
      const load = async (slugs: string[], memberIds: string[]): Promise<ExistingFoundPerson[]> => {
        const out = new Map<string, ExistingFoundPerson>();
        for (let i = 0; i < slugs.length; i += CHUNK) {
          const rows = await tx.select(columns).from(people).where(and(eq(people.organizationId, organizationId), inArray(people.linkedinSlug, slugs.slice(i, i + CHUNK))));
          for (const row of rows) out.set(row.id, row);
        }
        for (let i = 0; i < memberIds.length; i += CHUNK) {
          const rows = await tx.select(columns).from(people).where(and(eq(people.organizationId, organizationId), inArray(memberIdOf, memberIds.slice(i, i + CHUNK))));
          for (const row of rows) out.set(row.id, row);
        }
        return [...out.values()];
      };

      const slugs = candidates.flatMap((c) => (c.slug ? [c.slug] : []));
      const memberIds = candidates.flatMap((c) => (!c.slug && c.memberId ? [c.memberId] : []));
      const plan = planFoundPeople(candidates, await load(slugs, memberIds));

      const created = new Set<string>();
      for (let i = 0; i < plan.inserts.length; i += CHUNK) {
        const rows = await tx
          .insert(people)
          .values(
            plan.inserts.slice(i, i + CHUNK).map((c) => ({
              organizationId,
              linkedinSlug: c.slug,
              linkedinUrl: c.slug ? canonicalProfileUrl(c.slug) : c.url,
              raw: c.slug || !c.memberId ? null : { linkedin_member_id: c.memberId },
              firstName: c.firstName,
              lastName: c.lastName,
              fullName: c.fullName,
              title: c.title,
              source,
            })),
          )
          .onConflictDoNothing()
          .returning({ slug: people.linkedinSlug, memberId: memberIdOf });
        for (const row of rows) created.add(row.slug ?? `m:${row.memberId}`);
      }
      for (const fill of plan.fills) {
        await tx.update(people).set(fill.patch).where(and(eq(people.id, fill.id), eq(people.organizationId, organizationId)));
      }

      const all = await load(slugs, memberIds);
      return all.map((p) => ({ slug: p.linkedinSlug, memberId: p.memberId ?? null, personId: p.id, created: created.has(p.linkedinSlug ?? `m:${p.memberId}`) }));
    });
  },
};
