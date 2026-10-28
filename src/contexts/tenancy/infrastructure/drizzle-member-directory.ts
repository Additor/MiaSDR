import { and, asc, eq } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { members, users } from "@/platform/db/schema";
import type { MemberDirectory } from "../application/member-directory";

export const drizzleMemberDirectory: MemberDirectory = {
  async isMember(organizationId, userId) {
    const [row] = await db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)));
    return Boolean(row);
  },

  async list(organizationId) {
    return db
      .select({ userId: members.userId, name: users.name })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, organizationId))
      .orderBy(asc(users.name));
  },
};
