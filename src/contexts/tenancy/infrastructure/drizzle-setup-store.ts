import { sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { members, organizations, users } from "@/platform/db/schema";
import { createPasswordUserTx } from "@/contexts/identity/infrastructure/user-accounts";
import { mergeChannelSettings } from "./channel-settings";
import { SetupAlreadyDoneError, type InstanceSetupStore } from "../application/setup-instance";

/** Arbitrary constant: serialises concurrent setups for the length of a transaction. */
const SETUP_LOCK = 724_105_301;

export const drizzleSetupStore: InstanceSetupStore = {
  async hasAnyUser() {
    const [row] = await db.select({ id: users.id }).from(users).limit(1);
    return Boolean(row);
  },

  /** The first admin is an ordinary password user (identity's `createPasswordUserTx`) who owns the first organization. */
  async createInitialAdmin(instance) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
      const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing) throw new SetupAlreadyDoneError();

      const { userId } = await createPasswordUserTx(tx, { name: instance.name, email: instance.email, passwordHash: instance.passwordHash });
      const [organization] = await tx
        .insert(organizations)
        .values({
          name: instance.organizationName,
          slug: instance.organizationSlug,
          metadata: JSON.stringify({ initial: true }),
          ...(instance.timeZone ? { timezone: instance.timeZone } : {}),
        })
        .returning({ id: organizations.id });
      await tx.insert(members).values({ organizationId: organization.id, userId, role: "owner" });
      if (instance.timeZone && instance.timeZone !== "UTC") await mergeChannelSettings(tx, organization.id, "general", { timeZone: instance.timeZone }, userId);
      return { userId, organizationId: organization.id };
    });
  },
};
