import { and, eq, sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { people } from "@/platform/db/schema";
import { canonicalProfileUrl, parseLinkedinRef } from "../domain/linkedin-url";

/*
 * What a LinkedIn profile lookup teaches about a person. Outreach runs the lookup; people owns the person row and decides
 * what the answer may change: the public slug once, and the name, title and picture only where they are empty.
 */

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++, e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * Sets the person's public slug, and a canonical URL when the stored one is empty or a member reference (Sales Navigator,
 * Recruiter, a bare id). A person that already has a slug is left alone. The write runs in a savepoint, so a hit on
 * `people_org_linkedin_uq` (another lead holds the slug) leaves the surrounding transaction usable.
 */
export async function writeLinkedInSlugTx(tx: DbTx, organizationId: string, personId: string, slug: string): Promise<"written" | "skipped" | "collision"> {
  const [person] = await tx
    .select({ slug: people.linkedinSlug, url: people.linkedinUrl })
    .from(people)
    .where(and(eq(people.id, personId), eq(people.organizationId, organizationId)))
    .for("update");
  if (!person || person.slug) return "skipped";
  const replaceUrl = person.url === null || parseLinkedinRef(person.url)?.kind === "member";
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint
        .update(people)
        .set({ linkedinSlug: slug, ...(replaceUrl ? { linkedinUrl: canonicalProfileUrl(slug) } : {}) })
        .where(and(eq(people.id, personId), eq(people.organizationId, organizationId)));
    });
    return "written";
  } catch (error) {
    if (isUniqueViolation(error)) return "collision";
    throw error;
  }
}

/**
 * Fills the person's empty name, title and picture from the profile, never overwriting what the user imported, and keeps
 * the member id the lookup started from, so a later import of the same Sales Navigator URL finds this person.
 */
export async function fillFromLinkedInProfileTx(
  tx: DbTx,
  personId: string,
  profile: { firstName: string | null; lastName: string | null; headline: string | null; pictureUrl: string | null; memberId?: string | null },
): Promise<void> {
  await tx
    .update(people)
    .set({
      firstName: sql`coalesce(${people.firstName}, ${profile.firstName})`,
      lastName: sql`coalesce(${people.lastName}, ${profile.lastName})`,
      fullName: sql`coalesce(${people.fullName}, ${[profile.firstName, profile.lastName].filter(Boolean).join(" ") || null})`,
      title: sql`coalesce(${people.title}, ${profile.headline})`,
      profilePictureUrl: sql`coalesce(${people.profilePictureUrl}, ${profile.pictureUrl})`,
    })
    .where(eq(people.id, personId));
  if (profile.memberId) {
    await tx
      .update(people)
      .set({ raw: sql`jsonb_build_object('linkedin_member_id', ${profile.memberId}::text) || coalesce(${people.raw}, '{}'::jsonb)` })
      .where(eq(people.id, personId));
  }
}
