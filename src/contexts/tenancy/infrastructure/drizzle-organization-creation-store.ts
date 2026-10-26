import { sqlState } from "@/platform/db/errors";
import { asc, eq, like } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { members, organizations } from "@/platform/db/schema";
import { SlugTakenError, type OrganizationCreationStore } from "../application/create-organization";
import type { MembershipStore } from "../application/organization-switching";

export const drizzleOrganizationCreationStore: OrganizationCreationStore = {
  async slugsStartingWith(prefix) {
    const escaped = prefix.replace(/[\\%_]/g, "\\$&");
    const rows = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(like(organizations.slug, `${escaped}%`));
    return rows.map((r) => r.slug);
  },

  async createWithOwner(input) {
    try {
      return await db.transaction(async (tx) => {
        const [organization] = await tx.insert(organizations).values({ name: input.name, slug: input.slug }).returning({ id: organizations.id });
        await tx.insert(members).values({ organizationId: organization.id, userId: input.ownerUserId, role: "owner" });
        return organization;
      });
    } catch (error) {
      if (sqlState(error) === "23505") throw new SlugTakenError();
      throw error;
    }
  },
};

export const drizzleMembershipStore: MembershipStore = {
  async forUser(userId) {
    return db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: members.role })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .where(eq(members.userId, userId))
      .orderBy(asc(members.createdAt), asc(organizations.id));
  },
};
