import { sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { members, organizations, users } from "@/platform/db/schema";
import { createPasswordUserTx } from "@/contexts/identity/infrastructure/user-accounts";
import { mergeChannelSettings } from "./channel-settings";
import { SetupAlreadyDoneError, type InstanceSetupStore } from "../application/setup-instance";

/** Arbitrary constant: serialises concurrent setups for the length of a transaction. */
const SETUP_LOCK = 724_105_301;

/** One install serves one organization, so an organization left without users still counts: setup would add a second one. */
const setUpOn = async (handle: DbHandle): Promise<boolean> => {
  const [[user], [organization]] = [await handle.select({ id: users.id }).from(users).limit(1), await handle.select({ id: organizations.id }).from(organizations).limit(1)];
  return Boolean(user ?? organization);
};

export const drizzleSetupStore: InstanceSetupStore = {
  isSetUp: () => setUpOn(db),

  /** The first admin is an ordinary password user (identity's `createPasswordUserTx`) who owns the first organization. */
  async createInitialAdmin(instance) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
      if (await setUpOn(tx)) throw new SetupAlreadyDoneError();

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
