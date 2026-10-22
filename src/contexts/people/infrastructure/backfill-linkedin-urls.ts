import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { people } from "@/platform/db/schema";
import { canonicalProfileUrl } from "../domain/linkedin-url";

const BATCH = 500;

/**
 * Data migration: fills people.linkedin_url from linkedin_slug for rows
 * written before the column existed. Only rows with a slug and no URL change,
 * so a second run updates nothing. Pass an organization to limit the run.
 */
export async function backfillLinkedinUrls(organizationId?: string): Promise<number> {
  let updated = 0;
  let after: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; organizationId: string; slug: string | null }> = await db
      .select({ id: people.id, organizationId: people.organizationId, slug: people.linkedinSlug })
      .from(people)
      .where(
        and(
          isNotNull(people.linkedinSlug),
          isNull(people.linkedinUrl),
          organizationId ? eq(people.organizationId, organizationId) : undefined,
          after ? gt(people.id, after) : undefined,
        ),
      )
      .orderBy(asc(people.id))
      .limit(BATCH);
    if (rows.length === 0) return updated;
    for (const row of rows) {
      const result = await db
        .update(people)
        .set({ linkedinUrl: canonicalProfileUrl(row.slug as string) })
        .where(and(eq(people.id, row.id), eq(people.organizationId, row.organizationId), isNull(people.linkedinUrl)))
        .returning({ id: people.id });
      updated += result.length;
    }
    after = rows[rows.length - 1].id;
  }
}
