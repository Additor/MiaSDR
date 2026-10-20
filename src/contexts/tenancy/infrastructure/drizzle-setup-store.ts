import { sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { accounts, channelSettings, members, organizations, users } from "@/platform/db/schema";
import { SetupAlreadyDoneError, type InstanceSetupStore } from "../application/setup-instance";

/** Arbitrary constant: serialises concurrent setups for the length of a transaction. */
const SETUP_LOCK = 724_105_301;

export const drizzleSetupStore: InstanceSetupStore = {
  async hasAnyUser() {
    const [row] = await db.select({ id: users.id }).from(users).limit(1);
    return Boolean(row);
  },

  /**
   * Rows are shaped as Better Auth's own signUpEmail writes them (credential
   * account: accountId = user id), so signing in afterwards is an ordinary
   * sign-in. The admin's email is verified: a new self-hoster may have no
   * mail provider yet.
   */
  async createInitialAdmin(instance) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
      const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing) throw new SetupAlreadyDoneError();

      const [user] = await tx
        .insert(users)
        .values({ name: instance.name, email: instance.email, emailVerified: true })
        .returning({ id: users.id });
      await tx
        .insert(accounts)
        .values({ userId: user.id, providerId: "credential", accountId: user.id, password: instance.passwordHash });
      const [organization] = await tx
        .insert(organizations)
        .values({
          name: instance.organizationName,
          slug: instance.organizationSlug,
          metadata: JSON.stringify({ initial: true }),
        })
        .returning({ id: organizations.id });
      await tx.insert(members).values({ organizationId: organization.id, userId: user.id, role: "owner" });
      if (instance.timeZone && instance.timeZone !== "UTC") {
        await tx.insert(channelSettings).values({
          organizationId: organization.id,
          channel: "general",
          values: { timeZone: instance.timeZone },
          updatedBy: user.id,
        });
      }
      return { userId: user.id, organizationId: organization.id };
    });
  },
};
